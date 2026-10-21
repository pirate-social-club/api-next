#!/usr/bin/env python3
"""Extend an existing role check to its accepted native application processes."""
import argparse
import base64
import hashlib
import json
import math
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
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(256 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


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
    request = urllib.request.Request(url, data=None if body is None else json.dumps(body, separators=(",", ":")).encode(), headers=headers)
    with opener.open(request, timeout=6) as response:
        data = response.read(1_048_577)
        require(len(data) <= 1_048_576, "native-response-too-large")
        return response.status, response.headers, data


def observer_rpc(method, params):
    request = {"version": "pirate-hns-private-driver-request-v1", "exchange_kind": "hsd_json_rpc",
               "driver_reference": "hsd-json-rpc:production-primary",
               "request_bytes_base64": base64.b64encode(json.dumps({"method": method, "params": params}, separators=(",", ":")).encode()).decode(),
               "response_max_bytes": 1_048_576, "timeout_ms": 4000}
    status, headers, body = exchange("http://127.0.0.1:4081/internal/hns-observer-driver/v1/hsd", request, "application/octet-stream")
    require(status == 200 and headers.get("Pirate-HNS-Driver-Protocol") == "pirate-hns-private-driver-v1"
            and headers.get("Pirate-HNS-Driver-Upstream-Status") == "200", "observer-driver-protocol-mismatch")
    value = json.loads(body)
    require(value.get("error") is None and isinstance(value.get("result"), dict), "observer-rpc-refused")
    return value["result"]


def validate_tip(chain, block, now):
    height, headers = chain.get("blocks"), chain.get("headers")
    progress, stamp = chain.get("verificationprogress"), block.get("time")
    require(chain.get("chain") == "main" and type(height) is int and height >= 350000
            and type(headers) is int and 0 <= headers - height <= 2
            and type(progress) in (int, float) and math.isfinite(progress)
            and 0.9999 <= progress <= 1, "observer-not-synchronized")
    require(block.get("hash") == chain.get("bestblockhash")
            and type(block.get("height")) is int and block["height"] == height, "observer-tip-mismatch")
    require(type(stamp) is int and -300 <= now - stamp <= 7200, "observer-actual-tip-stale")


def required_installed_paths(profile):
    shared = {"/usr/local/bin/bun"}
    if profile == "observer-driver":
        return shared | {
            "/usr/local/bin/cloudflared", "/etc/systemd/system/pirate-hns-observer-driver.service",
            "/etc/systemd/system/cloudflared-hns-authority.service",
            "/etc/pirate/hns-observer-driver.env", "/etc/pirate/hns-observer-driver-hsd-api-key",
            "/srv/pirate-hns-observer-driver/current/bin/pirate-hns-observer-driver.mjs",
            "/srv/pirate-hns-observer/config/observer.env", "/srv/pirate-hns-observer/config/hsd_api_key",
            "/etc/systemd/system/pirate-deployment-verify@observer.service.d/20-native-driver.conf",
            "/etc/pirate-deployment-verify/observer.env",
        }
    return shared | {
        "/etc/systemd/system/pirate-hns-community-app-gateway.service",
        "/srv/pirate-hns-community-app-gateway/current/bin/pirate-hns-community-app-gateway.mjs",
        "/srv/pirate-hns-community-app-gateway/current/deployment-manifest.json",
        "/etc/pirate/hns-community-app-gateway/authority-database-url",
        "/etc/pirate/hns-community-app-gateway/forwarder-key-registry.json",
        "/etc/pirate/hns-community-app-gateway/solid-access-client-id",
        "/etc/pirate/hns-community-app-gateway/solid-access-client-secret",
        "/etc/systemd/system/pirate-deployment-verify@gateway-config.service.d/10-native-gateway.conf",
        "/etc/pirate-deployment-verify/gateway-config.env",
    }


def verify_installed_coverage(profile, root):
    manifest = root / "config/INSTALLED_SHA256SUMS"
    require(manifest.is_file(), "native-installed-manifest-missing")
    paths = set()
    for line in manifest.read_text().splitlines():
        digest, separator, path = line.partition("  ")
        require(separator and len(digest) == 64 and all(c in "0123456789abcdef" for c in digest)
                and path.startswith("/") and path not in paths, "native-installed-manifest-invalid")
        paths.add(path)
    require(required_installed_paths(profile) <= paths, "native-installed-coverage-incomplete")


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
        block = observer_rpc("getblockheader", [chain["bestblockhash"], True])
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
    verify_installed_coverage(args.profile, root)
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
