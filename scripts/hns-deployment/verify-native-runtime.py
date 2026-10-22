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
    if profile == "authority-provisioner":
        return shared | {
            "/etc/systemd/system/pirate-hns-authority-provisioner.service",
            "/etc/pirate/hns-authority-provisioner.env", "/etc/pirate/hns-authority-axfr-tsig-secret",
            "/srv/pirate-hns-authority-provisioner/current/deployment-manifest.json",
            "/srv/pirate-hns-authority-provisioner/current/bin/pirate-hns-authority-provisioner.mjs",
            "/etc/systemd/system/pirate-deployment-verify@authdns.service.d/20-native-provisioner.conf",
            "/etc/pirate-deployment-verify/authdns.env",
        }
    if profile == "observer-driver":
        return shared | {
            "/usr/local/bin/cloudflared", "/etc/systemd/system/pirate-hns-observer-driver.service",
            "/etc/systemd/system/cloudflared-hns-authority.service",
            "/etc/pirate/hns-observer-driver.env", "/etc/pirate/hns-observer-driver-hsd-api-key",
            "/srv/pirate-hns-observer-driver/current/bin/pirate-hns-observer-driver.mjs",
            "/srv/pirate-hns-observer/config/observer.env", "/srv/pirate-hns-observer/config/hsd_api_key",
            "/etc/systemd/system/pirate-deployment-verify@observer.service.d/20-native-driver.conf",
            "/etc/pirate-deployment-verify/observer.env",
            "/etc/systemd/system/pirate-hns-production-mainnet-reader.service",
            "/etc/systemd/system/pirate-hns-secondary-api-tunnel.service",
            "/opt/pirate-hns-production/mainnet-reader/production-mainnet/read-only-hsd-rpc-production.mjs",
            "/opt/pirate-hns-production/mainnet-reader/staging-mainnet/read-only-hsd-rpc-proxy.mjs",
            "/etc/pirate/hns-production-mainnet-reader/client-key",
            "/etc/pirate/hns-secondary-api-tunnel/id_ed25519",
            "/etc/pirate/hns-secondary-api-tunnel/known_hosts", "/usr/bin/ssh",
        }
    return shared | {
        "/usr/local/bin/pirate-caddy", "/etc/caddy/caddy.json",
        "/lib/systemd/system/caddy.service",
        "/etc/systemd/system/caddy.service.d/30-production-json.conf",
        "/etc/systemd/system/pirate-hns-community-app-gateway.service",
        "/etc/systemd/system/pirate-hns-platform-gateway.service",
        "/srv/pirate-hns-platform-gateway/current/DEPLOYMENT",
        "/srv/pirate-hns-platform-gateway/current/bin/pirate-hns-platform-gateway.mjs",
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


def verify_static_gateway(release, runtime_hash):
    binding = json.loads((release / "static-native/bundle-binding.json").read_text())
    require(binding["schema"] == "pirate-hns-native-bundle/1" and binding["profile"] == "static-gateway",
            "static-gateway-binding-mismatch")
    require(binding["bun"]["runtime"]["binary_sha256"] == runtime_hash, "static-gateway-runtime-mismatch")
    root = Path("/srv/pirate-hns-platform-gateway/current")
    lines = (root / "DEPLOYMENT").read_text().splitlines()
    metadata = dict(line.split("=", 1) for line in lines)
    require(len(metadata) == len(lines) and metadata.get("api-next_commit") == binding["source_commit"]
            and metadata.get("bundle_sha256") == binding["bundle_sha256"], "static-gateway-source-binding-mismatch")
    bundle = root / "bin" / binding["bundle_name"]
    require(sha256(bundle) == binding["bundle_sha256"], "static-gateway-bundle-mismatch")
    unit = "pirate-hns-platform-gateway.service"
    pid = active_process(unit, runtime_hash, str(bundle))
    status, _, body = exchange("http://127.0.0.1:4051/readyz")
    require(status == 204 and body == b"", "static-gateway-not-ready")
    return unit, pid


def require_zero_swap():
    group = Path("/sys/fs/cgroup") / Path("/proc/self/cgroup").read_text().split("0::", 1)[1].strip().lstrip("/")
    require((group / "memory.swap.max").read_text().strip() == "0", "private-probe-swap-not-disabled")


def loaded_credential(pid, unit, name, source):
    runtime = Path(f"/proc/{pid}/root/run/credentials/{unit}/{name}")
    require(sha256(runtime) == sha256(source), "native-loaded-credential-mismatch")


def reader_rpc(method, params):
    key = Path("/etc/pirate/hns-production-mainnet-reader/client-key").read_bytes().strip()
    request = urllib.request.Request("http://127.0.0.1:12039/",
        data=json.dumps({"method": method, "params": params}, separators=(",", ":")).encode(),
        headers={"Authorization": "Basic " + base64.b64encode(b"x:" + key).decode(), "Content-Type": "application/json"})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(request, timeout=6) as response:
        require(response.status == 200, "production-reader-status-mismatch")
        data = response.read(1_048_577)
        require(len(data) <= 1_048_576, "native-response-too-large")
    result = json.loads(data)
    require(result.get("error") is None and isinstance(result.get("result"), dict), "production-reader-rpc-refused")
    return result["result"]


def verify_reader_and_secondary(release, runtime_hash):
    require_zero_swap()
    reader = "pirate-hns-production-mainnet-reader.service"
    root = Path("/opt/pirate-hns-production/mainnet-reader")
    for relative in ["production-mainnet/read-only-hsd-rpc-production.mjs", "staging-mainnet/read-only-hsd-rpc-proxy.mjs"]:
        require(sha256(root / relative) == sha256(release / "native/reader" / relative), "production-reader-source-mismatch")
    pids = {reader: active_process(reader, runtime_hash, str(root / "production-mainnet/read-only-hsd-rpc-production.mjs"))}
    for name, source in [("production-hsd-client-key", "/etc/pirate/hns-production-mainnet-reader/client-key"),
                         ("production-hsd-upstream-key", "/srv/pirate-hns-observer/config/hsd_api_key")]:
        loaded_credential(pids[reader], reader, name, source)
    chain = reader_rpc("getblockchaininfo", [])
    validate_tip(chain, reader_rpc("getblockheader", [chain["bestblockhash"], True]), time.time())
    try:
        reader_rpc("getrawmempool", [])
    except urllib.error.HTTPError as error:
        require(error.code == 403, "production-reader-policy-mismatch")
    else:
        raise Refused("production-reader-extra-method-admitted")
    tunnel = "pirate-hns-secondary-api-tunnel.service"
    pids[tunnel] = active_process(tunnel, sha256("/usr/bin/ssh"), "127.0.0.1:18081:127.0.0.1:8081")
    for unit in [reader, tunnel]:
        template = (release / "native/systemd" / unit).read_bytes()
        if unit == tunnel:
            template = template.replace(b"%d/", b"/run/credentials/pirate-hns-secondary-api-tunnel.service/")
        require(Path("/etc/systemd/system", unit).read_bytes() == template, "production-boundary-unit-mismatch")
    for name, source in [("secondary-tunnel-key", "/etc/pirate/hns-secondary-api-tunnel/id_ed25519"),
                         ("secondary-known-hosts", "/etc/pirate/hns-secondary-api-tunnel/known_hosts")]:
        loaded_credential(pids[tunnel], tunnel, name, source)
    # An unauthenticated API response proves the actual forwarded endpoint is
    # answering without exposing or transmitting the private PowerDNS API key.
    try:
        exchange("http://127.0.0.1:18081/api/v1/servers/localhost")
    except urllib.error.HTTPError as error:
        require(error.code == 401, "secondary-api-forward-status-mismatch")
    else:
        raise Refused("secondary-api-forward-authentication-missing")
    return pids


def verify_provisioner(release, binding, runtime_hash):
    require_zero_swap()
    unit = "pirate-hns-authority-provisioner.service"
    root = Path("/srv/pirate-hns-authority-provisioner/current")
    manifest = root / "deployment-manifest.json"
    require(sha256(manifest) == sha256(release / "deployment-manifest.json"), "provisioner-manifest-mismatch")
    identity = json.loads(manifest.read_text())
    require(identity["source_commit"] == binding["source_commit"]
            and identity["bundle_sha256"] == binding["bundle_sha256"], "provisioner-source-binding-mismatch")
    bundle = root / "bin" / binding["bundle_name"]
    require(sha256(bundle) == binding["bundle_sha256"], "native-installed-bundle-mismatch")
    pid = active_process(unit, runtime_hash, str(bundle))
    loaded_credential(pid, unit, "hns_axfr_tsig_secret", "/etc/pirate/hns-authority-axfr-tsig-secret")
    # Reuse only the current process's database URL. The historical command
    # performs SELECT-only schema compatibility checks, never lifecycle work.
    values = dict(item.split(b"=", 1) for item in Path(f"/proc/{pid}/environ").read_bytes().split(b"\0") if b"=" in item)
    url = values.get(b"CONTROL_PLANE_POSTGRES_URL")
    require(bool(url), "provisioner-database-configuration-missing")
    result = subprocess.run(["/usr/local/bin/bun", str(bundle), "--verify-schema", "--manifest", str(manifest), "--bundle", str(bundle)],
        env={"PATH": "/usr/local/bin:/usr/bin:/bin", "CONTROL_PLANE_POSTGRES_URL": os.fsdecode(url)},
        capture_output=True, text=True, timeout=20)
    require(result.returncode == 0 and json.loads(result.stdout).get("outcome") == "compatible", "provisioner-schema-refused")
    return {unit: pid}


def verify_native(profile, release):
    binding = json.loads((release / "native/bundle-binding.json").read_text())
    require(binding["schema"] == "pirate-hns-native-bundle/1" and binding["profile"] == profile, "native-binding-mismatch")
    runtime_hash = binding["bun"]["runtime"]["binary_sha256"]
    require(sha256("/usr/local/bin/bun") == runtime_hash, "native-installed-runtime-mismatch")
    if profile == "authority-provisioner":
        pids = verify_provisioner(release, binding, runtime_hash)
        for unit, pid in pids.items():
            require(int(run(["systemctl", "show", unit, "-p", "MainPID", "--value"]).strip()) == pid,
                    "native-pid-changed-during-verification")
        return {"profile": profile, "historical_application_source": binding["source_commit"],
                "bundle_sha256": binding["bundle_sha256"], "pids": pids, "schema_compatible": True}
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
        pids.update(verify_reader_and_secondary(release, runtime_hash))
    else:
        status, _, body = exchange("http://127.0.0.1:4071/readyz")
        require(status == 204 and body == b"", "gateway-not-ready")
        static_unit, static_pid = verify_static_gateway(release, runtime_hash)
        pids[static_unit] = static_pid
    for unit, pid in pids.items():
        require(int(run(["systemctl", "show", unit, "-p", "MainPID", "--value"]).strip()) == pid,
                "native-pid-changed-during-verification")
    return {"profile": profile, "historical_application_source": binding["source_commit"],
            "bundle_sha256": binding["bundle_sha256"], "pids": pids}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("profile", choices=["observer-driver", "community-gateway", "authority-provisioner"])
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
