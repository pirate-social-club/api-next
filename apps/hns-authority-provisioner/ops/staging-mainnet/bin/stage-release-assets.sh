#!/usr/bin/env bash
# Called by the standard immutable-role builder; inputs are previously built
# protected-source bundles, bound here by exact hashes and source ancestry.
set -euo pipefail
release="${1:?release directory required}"
[[ "$release" = /* && -d "$release" && ! -L "$release" ]] || exit 2
[[ ! -e "$release/gateway" && ! -e "$release/provisioner" ]] || exit 2
repo_root="$(git rev-parse --show-toplevel)"
source "$repo_root/scripts/hns-deployment/git-provenance.sh"
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
