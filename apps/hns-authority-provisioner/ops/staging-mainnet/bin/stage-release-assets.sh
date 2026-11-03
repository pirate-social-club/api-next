#!/usr/bin/env bash
# Called by the standard immutable-role builder; inputs are previously built
# protected-source bundles, bound here by exact hashes and source ancestry.
set -euo pipefail
release="${1:?release directory required}"
[[ "$release" = /* && -d "$release" && ! -L "$release" ]] || exit 2
[[ ! -e "$release/gateway" && ! -e "$release/provisioner" ]] || exit 2
repo_root="$(git rev-parse --show-toplevel)"
source "$repo_root/scripts/hns-deployment/git-provenance.sh"
# This explicit fixed profile stages only the accepted V4 gateway. The runtime
# copy is recovery evidence; the existing unit keeps /usr/local/bin/bun.
profile="${HNS_STAGING_ASSET_PROFILE-historical-v3}"
case "$profile" in
  historical-v3) ;;
  posting-v4)
    [[ ! -L "$release/gateway" && ! -L "$release/provisioner" ]] || exit 2
    assert_release_provenance 97a701a7afa1274ebb73e1e9705fba1a95e61803 "" "$repo_root"
    gateway="${HNS_STAGING_GATEWAY_BUNDLE:?set retained V4 gateway bundle path}"
    runtime="${HNS_STAGING_GATEWAY_RUNTIME:?set retained Bun1.3.14 runtime path}"
    manifest="$repo_root/apps/hns-authority-provisioner/ops/staging-mainnet/deployment-manifest.gateway-v4.json"
    [[ "$gateway" = /* && -f "$gateway" && ! -L "$gateway" ]] || exit 2
    [[ "$runtime" = /* && -f "$runtime" && ! -L "$runtime" ]] || exit 2
    printf '%s  %s\n' 34029a3cf81dda85a7f9fc6eed3d9655be08a930fb17db3f1497b7618fe72a24 "$gateway" | sha256sum -c -
    printf '%s  %s\n' 9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74 "$runtime" | sha256sum -c -
    printf '%s  %s\n' 34f51467e42481bf829e774943a63860bf8946f755fb5b73a5727f455c19204c "$manifest" | sha256sum -c -
    mkdir -p "$release/gateway/bin"
    cp -- "$gateway" "$release/gateway/bin/pirate-hns-community-app-handle-gateway.mjs"
    cp -- "$runtime" "$release/gateway/bin/bun"
    cp -- "$manifest" "$release/gateway/deployment-manifest.json"
    printf '%s  %s\n' 34029a3cf81dda85a7f9fc6eed3d9655be08a930fb17db3f1497b7618fe72a24 "$release/gateway/bin/pirate-hns-community-app-handle-gateway.mjs" | sha256sum -c -
    printf '%s  %s\n' 9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74 "$release/gateway/bin/bun" | sha256sum -c -
    printf '%s  %s\n' 34f51467e42481bf829e774943a63860bf8946f755fb5b73a5727f455c19204c "$release/gateway/deployment-manifest.json" | sha256sum -c -
    chmod 0555 "$release/gateway/bin/"*
    chmod 0444 "$release/gateway/deployment-manifest.json"
    exit 0
    ;;
  *) echo "unsupported staging asset profile" >&2; exit 2 ;;
esac
app_source=76cd679ead1a680bb74a47f6718d3e0e7e4e5f3f
assert_release_provenance "$app_source" "" "$repo_root"
gateway="${HNS_STAGING_GATEWAY_BUNDLE:?set protected-source gateway bundle path}"
provisioner="${HNS_STAGING_PROVISIONER_BUNDLE:?set protected-source provisioner bundle path}"
[[ "$gateway" = /* && -f "$gateway" && "$provisioner" = /* && -f "$provisioner" ]] || exit 2
printf '%s  %s\n' f19d0a9280a181b4efa892788646e7619e0ec6705a3f2c2421bbe59b320b5902 "$gateway" | sha256sum -c -
printf '%s  %s\n' 66339d830ff63676b9243985af593c9a40d382ea10790a64fd96241b965b095e "$provisioner" | sha256sum -c -
mkdir -p "$release/gateway/bin" "$release/provisioner/bin"
cp -- "$gateway" "$release/gateway/bin/pirate-hns-community-app-handle-gateway.mjs"
cp -- "$provisioner" "$release/provisioner/bin/pirate-hns-authority-provisioner.mjs"
printf '%s  %s\n' f19d0a9280a181b4efa892788646e7619e0ec6705a3f2c2421bbe59b320b5902 "$release/gateway/bin/pirate-hns-community-app-handle-gateway.mjs" | sha256sum -c -
printf '%s  %s\n' 66339d830ff63676b9243985af593c9a40d382ea10790a64fd96241b965b095e "$release/provisioner/bin/pirate-hns-authority-provisioner.mjs" | sha256sum -c -
chmod 0555 "$release/gateway/bin/"*.mjs "$release/provisioner/bin/"*.mjs
python3 - "$release/deployment-manifest.gateway.json" "$release/gateway/deployment-manifest.json" <<'PYTHON'
import hashlib, json, pathlib, sys
raw = json.dumps(json.loads(pathlib.Path(sys.argv[1]).read_text()), separators=(",", ":")).encode()
assert hashlib.sha256(raw).hexdigest() == "b1457435805e81b41fcd253af6b9ac95559e503efae64b07705d1a0a844fc83d"
pathlib.Path(sys.argv[2]).write_bytes(raw)
PYTHON
attempt="staging-relocation-$(date -u +%Y%m%dT%H%M%SZ)-$$"
printf '{"api_next_source_commit":"%s","bundle_sha256":"%s","service_version":"pirate-hns-authority-provisioner-v2","job_envelope_version":"hns-lifecycle-job-envelope-v1","attempt_id":"%s"}\n' \
  "$app_source" 66339d830ff63676b9243985af593c9a40d382ea10790a64fd96241b965b095e "$attempt" \
  > "$release/provisioner/deployment-manifest.json"
