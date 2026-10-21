#!/usr/bin/env python3
"""Extend an existing role check to its accepted native application processes."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.error
import urllib.request


class Refused(RuntimeError):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def require(value, reason):
    if not value:
        raise Refused(reason)


def sha256(path):
    with open(path, "rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def run(args):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=40).stdout


def active_process(unit, executable_hash, bundle=None):
    require(run(["systemctl", "is-active", unit]).strip() == "active", "native-unit-inactive")
    pid = int(run(["systemctl", "show", unit, "-p", "MainPID", "--value"]).strip())
    require(pid > 1, "native-pid-missing")
    require(sha256(f"/proc/{pid}/exe") == executable_hash, "native-running-binary-mismatch")
    if bundle:
        args = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
        require(os.fsencode(bundle) in args, "native-bundle-argument-mismatch")
    return pid


def exchange(url, body=None, accept="application/json"):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    headers = {"Accept": accept}
    if body is not None:
        headers.update({"Content-Type": "application/json", "Pirate-HNS-Driver-Protocol": "pirate-hns-private-driver-v1"})
    request = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(), headers=headers)
    with opener.open(request, timeout=6) as response:
        data = response.read(1_048_577)
        require(len(data) <= 1_048_576, "native-response-too-large")
        return response.status, response.headers, data


def observer_rpc(method, params):
    request = {"version": "pirate-hns-private-driver-request-v1", "exchange_kind": "hsd_json_rpc",
               "driver_reference": "hsd-json-rpc:production-primary",
               "request_bytes_base64": base64.b64encode(json.dumps({"method": method, "params": params, "id": 1}).encode()).decode(),
               "response_max_bytes": 1_048_576, "timeout_ms": 4000}
    status, headers, body = exchange("http://127.0.0.1:4081/internal/hns-observer-driver/v1/hsd", request, "application/octet-stream")
    require(status == 200 and headers.get("Pirate-HNS-Driver-Protocol") == "pirate-hns-private-driver-v1"
            and headers.get("Pirate-HNS-Driver-Upstream-Status") == "200", "observer-driver-protocol-mismatch")
    value = json.loads(body)
    require(value.get("error") is None and isinstance(value.get("result"), dict), "observer-rpc-refused")
    return value["result"]


def validate_tip(chain, block, now):
    require(chain.get("chain") == "main" and isinstance(chain.get("blocks"), int)
            and chain["blocks"] > 0 and isinstance(chain.get("verificationprogress"), (int, float))
            and 0.999 <= chain["verificationprogress"] <= 1.001, "observer-not-synchronized")
    require(block.get("hash") == chain.get("bestblockhash") and block.get("height") == chain["blocks"], "observer-tip-mismatch")
    stamp = block.get("time")
    require(isinstance(stamp, (int, float)) and -300 <= now - stamp <= 7200, "observer-actual-tip-stale")


def verify_native(profile, release):
    binding = json.loads((release / "native/bundle-binding.json").read_text())
    require(binding["schema"] == "pirate-hns-native-bundle/1" and binding["profile"] == profile, "native-binding-mismatch")
    runtime_hash = binding["bun"]["runtime"]["binary_sha256"]
    require(sha256("/usr/local/bin/bun") == runtime_hash, "native-installed-runtime-mismatch")
    pids = {}
    if profile == "observer-driver":
        unit = "pirate-hns-observer-driver.service"
        root = Path("/srv/pirate-hns-observer-driver/current")
        env = Path("/etc/pirate/hns-observer-driver.env").read_text().splitlines()
        values = dict(line.split("=", 1) for line in env if line and not line.startswith("#"))
        require(values == {"HNS_OBSERVER_DRIVER_HSD_REFERENCE": "hsd-json-rpc:production-primary",
                           "HNS_OBSERVER_DRIVER_HSD_RPC_URL": "http://127.0.0.1:12037/",
                           "HNS_OBSERVER_DRIVER_PORT": "4081"}, "observer-driver-boundary-config-mismatch")
        tunnel = "cloudflared-hns-authority.service"
        require(sha256("/usr/local/bin/cloudflared") == binding["cloudflared"]["binary_sha256"], "tunnel-installed-binary-mismatch")
        pids[tunnel] = active_process(tunnel, binding["cloudflared"]["binary_sha256"])
    else:
        unit = "pirate-hns-community-app-gateway.service"
        root = Path("/srv/pirate-hns-community-app-gateway/current")
        require(sha256(root / "deployment-manifest.json") == sha256(release / "deployment-manifest.json"), "gateway-manifest-mismatch")
        manifest = json.loads((root / "deployment-manifest.json").read_text())
        require(manifest["api_next_source_commit"] == binding["source_commit"]
                and manifest["bundle_sha256"] == binding["bundle_sha256"], "gateway-source-binding-mismatch")
    bundle = root / "bin" / binding["bundle_name"]
    require(sha256(bundle) == binding["bundle_sha256"], "native-installed-bundle-mismatch")
    pids[unit] = active_process(unit, runtime_hash, str(bundle))
    if profile == "observer-driver":
        chain = observer_rpc("getblockchaininfo", [])
        block = observer_rpc("getblock", [chain["bestblockhash"], True])
        validate_tip(chain, block, time.time())
    else:
        status, _, body = exchange("http://127.0.0.1:4071/readyz")
        require(status == 204 and body == b"", "gateway-not-ready")
    for unit, pid in pids.items():
        require(int(run(["systemctl", "show", unit, "-p", "MainPID", "--value"]).strip()) == pid,
                "native-pid-changed-during-verification")
    return {"profile": profile, "historical_application_source": binding["source_commit"],
            "bundle_sha256": binding["bundle_sha256"], "pids": pids}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("profile", choices=["observer-driver", "community-gateway"])
    parser.add_argument("--deploy-root", type=Path, default=os.environ.get("DEPLOY_ROOT"))
    parser.add_argument("--no-heartbeat", action="store_true")
    args = parser.parse_args()
    require(args.deploy_root is not None, "deployment-root-missing")
    root = Path(args.deploy_root)
    release = (root / "current").resolve(strict=True)
    # The ordinary checker covers the release, external installed-file manifest,
    # container and Caddy. Never send success before the native checks complete.
    run([str(release / "bin/deployment-status.sh"), "--verify", "--deploy-root", str(root)])
    result = verify_native(args.profile, release)
    if not args.no_heartbeat and os.environ.get("HNS_HEALTHCHECK_URL_FILE"):
        env = dict(os.environ, DEPLOY_ROOT=str(root))
        subprocess.run([str(release / "bin/heartbeat.sh")], env=env, check=True, timeout=15, capture_output=True)
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Refused as error:
        print("native verification refused: " + str(error))
        raise SystemExit(1) from None
    except Exception:
        # Exceptions may contain private HTTP, process or configuration data.
        print("native verification refused: bounded-operation-failed")
        raise SystemExit(1) from None
