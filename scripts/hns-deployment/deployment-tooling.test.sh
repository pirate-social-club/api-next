#!/usr/bin/env bash
set -euo pipefail

# Executable harness for the deployment tooling. No docker daemon required:
# docker is shimmed on PATH with canned responses. Covers:
#   1. make-release refuses a dirty tree
#   2. make-release stages role assets and records a separately versioned app
#   3. make-app-release archives and checksums the exact app commit
#   4. make-release succeeds for roles without a container image
#   5. verify passes on a clean role + app deployment
#   6. verify fails on role tamper
#   7. verify fails on app tamper, added files, missing manifest, or repoint
#   8. verify fails when config changes after --record-config
#   9. verify fails when the container runs while EXPECT_RUNNING=false
#  10. verify fails when the current symlink points at the wrong release
#  11. verify passes for a running container whose image digest matches the pin
#  12. failure wrapper selects the explicit hosted failure state
#  13. status reports when deployment heartbeats are not configured
#  14. successful verification selects the hosted success state with source binding
#  15. installed host files are recorded and checked independently of runtimes
#  16. release construction rejects non-main commits unless break-glass is recorded
#  17. relative app output roots and missing-main diagnostics remain unambiguous
#  18. locally built container IDs are recorded and verified
#  19. stateful VPS compose roles use stable host paths, not release-relative mounts
#  20. per-service runtime configuration: Compose provenance (mixed releases),
#      retained-release integrity, exact args and mounts, unexpected project
#      containers, systemd drop-ins and COMPOSE_* environment overrides

tooling_dir="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fail() { echo "FAIL: $1" >&2; exit 1; }
pass() { echo "ok: $1"; }

# Stateful data and secret mounts must survive immutable release replacement.
# A release-relative path silently creates a new empty state directory on the
# next checkout and lets deployment verification bless the wrong bytes. This
# sweep is intentionally fleet-wide: a new stateful role must inherit the
# stable-path rule without requiring another role-specific test update.
source_root="$(cd "$tooling_dir/../.." && pwd)"
observer_compose="$source_root/apps/hns-observer-driver/ops/chain-reader/compose.yaml"
authdns_compose="$source_root/apps/hns-authority-provisioner/ops/primary-dns/compose.yaml"
grep -Fq '${HSD_DATA_DIR:-/srv/pirate-hns-observer/shared/data}' "$observer_compose" \
  || fail "chain observer data mount is not release-independent"
grep -Fq '${HSD_API_KEY_FILE:-/srv/pirate-hns-observer/config/hsd_api_key}' "$observer_compose" \
  || fail "chain observer secret mount is not release-independent"
grep -Fq '${PDNS_DATA_DIR:-/srv/pirate-hns-authdns/shared/data}' "$authdns_compose" \
  || fail "authoritative DNS data mount is not release-independent"
secondary_compose="$tooling_dir/../hns-secondary-dns/compose.yaml"
grep -Fq '${PDNS_DATA_DIR:-/srv/pirate-hns-secondary/shared/data}' "$secondary_compose" \
  || fail "secondary DNS data mount is not release-independent"
while IFS= read -r compose_file; do
  if sed 's/#.*$//' "$compose_file" \
    | grep -Eq '(^|[[:space:]:-])(\./(data|secrets)|\$\{[^}]*:-\./(data|secrets))'; then
    fail "VPS compose role retains a release-relative data or secret mount: $compose_file"
  fi
done < <(find "$tooling_dir/.." -mindepth 2 -maxdepth 2 -type f -name compose.yaml -print | sort)
pass "stateful VPS compose roles use stable host paths"

# --- fixture repo with a minimal role ---------------------------------------

repo="$work/repo"
mkdir -p "$repo/scripts/hns-deployment-fixtures/demo-role/config" "$repo/scripts/hns-deployment-fixtures/no-image-role" "$repo/scripts/hns-deployment"
cp "$tooling_dir"/*.sh "$tooling_dir/ping-healthcheck.py" "$repo/scripts/hns-deployment/"
cp -r "$tooling_dir/systemd" "$repo/scripts/hns-deployment/systemd"
cat > "$repo/scripts/hns-deployment-fixtures/demo-role/compose.yaml" <<'EOF'
services:
  demo:
    image: example/demo@sha256:1111111111111111111111111111111111111111111111111111111111111111
    container_name: pirate-demo-role
EOF
echo "setting=1" > "$repo/scripts/hns-deployment-fixtures/demo-role/config/demo.conf.example"
printf '%s\n' 'tracked nested checksum fixture' > "$repo/scripts/hns-deployment-fixtures/demo-role/config/SHA256SUMS"
echo "no container image" > "$repo/scripts/hns-deployment-fixtures/no-image-role/README.md"
mkdir -p "$repo/scripts/hns-deployment-fixtures/demo-role/bin"
cat > "$repo/scripts/hns-deployment-fixtures/demo-role/bin/stage-release-assets.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
release_dir="${1:?release directory required}"
printf '%s\n' 'fixture runtime asset' > "$release_dir/bin/demo-helper"
chmod 0755 "$release_dir/bin/demo-helper"
EOF
chmod +x "$repo/scripts/hns-deployment-fixtures/demo-role/bin/stage-release-assets.sh"
git -C "$repo" init -q
git -C "$repo" -c user.email=fixture@invalid.example -c user.name=fixture_role add -A
git -C "$repo" -c user.email=fixture@invalid.example -c user.name=fixture_role commit -qm "fixture"
commit="$(git -C "$repo" rev-parse HEAD)"
git -C "$repo" update-ref refs/remotes/origin/main "$commit"

make_release() {
  (cd "$repo" && bash scripts/hns-deployment/make-release.sh \
    scripts/hns-deployment-fixtures/demo-role "$@" --app-commit "$commit")
}

# 1. dirty-tree refusal
echo dirty > "$repo/scripts/hns-deployment-fixtures/demo-role/scratch.txt"
if make_release "$work/dirty-out" --expect-running false >/dev/null 2>&1; then
  fail "make-release accepted a dirty tree"
fi
rm "$repo/scripts/hns-deployment-fixtures/demo-role/scratch.txt"
pass "make-release refuses dirty tree"

# 2. staged release shape
make_release "$work/deploy" --expect-running false >/dev/null
release="$work/deploy/releases/$commit"
cmp "$tooling_dir/ping-healthcheck.py" "$release/bin/ping-healthcheck.py" \
  || fail "release omits or changes the hosted heartbeat sender"
grep -Fq '  ./bin/ping-healthcheck.py' "$release/SHA256SUMS" \
  || fail "release checksum manifest omits the hosted heartbeat sender"
[[ -f "$release/DEPLOYMENT" && -f "$release/SHA256SUMS" \
  && -x "$release/bin/deployment-status.sh" && -x "$release/bin/record-installed-files.sh" ]] \
  || fail "release layout incomplete"
[[ -x "$release/bin/demo-helper" ]] || fail "role-provided runtime asset was not staged"
grep -q 'bin/demo-helper$' "$release/SHA256SUMS" || fail "runtime asset omitted from SHA256SUMS"
grep -Fq '  ./config/SHA256SUMS' "$release/SHA256SUMS" || fail "tracked nested checksum file omitted from role manifest"
grep -q "^SOURCE_COMMIT=$commit$" "$release/DEPLOYMENT" || fail "DEPLOYMENT missing commit"
grep -q '^SOURCE_PROVENANCE=origin-main$' "$release/DEPLOYMENT" \
  || fail "DEPLOYMENT missing source provenance"
grep -q "^APP_COMMIT=$commit$" "$release/DEPLOYMENT" || fail "DEPLOYMENT missing app commit"
grep -q '^APP_PROVENANCE=origin-main$' "$release/DEPLOYMENT" \
  || fail "DEPLOYMENT missing app provenance"
grep -q "^IMAGE_DIGEST=example/demo@sha256:1111" "$release/DEPLOYMENT" || fail "DEPLOYMENT missing digest"
grep -q "^CONTAINER_NAME=pirate-demo-role$" "$release/DEPLOYMENT" || fail "DEPLOYMENT missing container"
pass "make-release stages role assets and records app commit"

# 3. separately versioned app release
(cd "$repo" && bash scripts/hns-deployment/make-app-release.sh "$work/deploy" \
  --commit "$commit") >/dev/null
app_release="$work/deploy/app-releases/$commit"
[[ -f "$app_release/.pirate-deployment/DEPLOYMENT" \
  && -f "$app_release/.pirate-deployment/SHA256SUMS" ]] \
  || fail "app release metadata incomplete"
grep -q "^APP_COMMIT=$commit$" "$app_release/.pirate-deployment/DEPLOYMENT" \
  || fail "app release metadata missing commit"
grep -q '^APP_PROVENANCE=origin-main$' "$app_release/.pirate-deployment/DEPLOYMENT" \
  || fail "app release metadata missing provenance"
(cd "$app_release" && sha256sum --check --quiet .pirate-deployment/SHA256SUMS) \
  || fail "staged app release checksums do not verify"
pass "make-app-release archives and checksums exact commit"

# A relative output root is relative to the caller, not silently rebased to the
# repository root while provenance is checked.
(cd "$repo/scripts/hns-deployment-fixtures" && bash ../hns-deployment/make-app-release.sh \
  ../../../relative-app-output --commit "$commit") >/dev/null
[[ -f "$work/relative-app-output/app-releases/$commit/.pirate-deployment/DEPLOYMENT" ]] \
  || fail "make-app-release changed the base of a relative output root"
pass "make-app-release preserves caller-relative output roots"

# 4. roles without a compose image still complete successfully
(cd "$repo" && bash scripts/hns-deployment/make-release.sh \
  scripts/hns-deployment-fixtures/no-image-role "$work/no-image-deploy" --expect-running true \
  --local-image-id pirate-local=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa) >/dev/null \
  || fail "make-release returned failure after staging a no-image role"
grep -Fxq 'LOCAL_IMAGE_ID_1=pirate-local=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
  "$work/no-image-deploy/releases/$commit/DEPLOYMENT" \
  || fail "make-release omitted the local container image ID"
pass "make-release succeeds for roles without a container image"

# --- docker shim -------------------------------------------------------------

shim="$work/shim"
mkdir -p "$shim"
cat > "$shim/docker" <<'EOF'
#!/usr/bin/env bash
state_file="${DOCKER_SHIM_STATE:?}"
state="$(cat "$state_file")"
case "$1 $2" in
  "inspect --format")
    if [[ "$state" == "absent" ]]; then exit 1; fi
    if [[ "$3" == "{{.Image}}" ]]; then
      echo "${DOCKER_SHIM_IMAGE_ID:-sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}"
    elif [[ "$4" == img-1 ]]; then
      # image inspect for RepoDigests
      echo "example/demo@sha256:${DOCKER_SHIM_DIGEST:?}"
    else
      echo "$state 2026-07-17T16:00:00Z img-1"
    fi
    ;;
  "image inspect")
    echo "example/demo@sha256:${DOCKER_SHIM_DIGEST:?}"
    ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$shim/docker"
export PATH="$shim:$PATH"
export DOCKER_SHIM_STATE="$work/docker-state"
export DOCKER_SHIM_DIGEST="1111111111111111111111111111111111111111111111111111111111111111"
echo absent > "$DOCKER_SHIM_STATE"

deploy_root="$work/deploy"
ln -s "releases/$commit" "$deploy_root/current"
ln -s "app-releases/$commit" "$deploy_root/app"
mkdir -p "$deploy_root/config"
echo "PRIMARY_DNS_IP=203.0.113.7" > "$deploy_root/config/demo.env"
runtime_tool="$work/runtime-tool"
echo "trusted runtime" > "$runtime_tool"
sha256sum "$runtime_tool" > "$deploy_root/config/RUNTIME_SHA256SUMS"
installed_target="$work/installed-unit-v1.service"
installed_file="$work/installed-unit.service"
echo "tracked installed unit" > "$installed_target"
ln -s "$installed_target" "$installed_file"
bash "$deploy_root/current/bin/record-installed-files.sh" \
  --deploy-root "$deploy_root" "$installed_file" >/dev/null

status() { bash "$deploy_root/current/bin/deployment-status.sh" --deploy-root "$deploy_root" "$@"; }

# 5. clean pre-launch verify (container absent, EXPECT_RUNNING=false)
status --record-config >/dev/null
status --verify >/dev/null || fail "clean pre-launch deployment reported drift"
clean_status="$(status)"
grep -q "drift:   none" <<< "$clean_status" || fail "status did not report drift: none"
grep -q "heartbeat: not configured (HNS_HEALTHCHECK_URL_FILE is unset)" <<< "$clean_status" \
  || fail "status did not report missing heartbeat configuration: $clean_status"
grep -q "desired: app  $commit" <<< "$clean_status" \
  || fail "status omitted desired app commit: $clean_status"
grep -q "desired: source $commit  provenance origin-main" <<< "$clean_status" \
  || fail "status omitted desired source provenance: $clean_status"
grep -q "desired: app  $commit  provenance origin-main" <<< "$clean_status" \
  || fail "status omitted desired app provenance: $clean_status"
grep -q "app:     $commit checksums OK" <<< "$clean_status" \
  || fail "status omitted app integrity: $clean_status"
grep -q "runtime: 1 host executables checksums OK" <<< "$clean_status" \
  || fail "status omitted host runtime integrity: $clean_status"
pass "status reports when deployment heartbeats are not configured"
grep -q "installed: 1 host files checksums OK" <<< "$clean_status" \
  || fail "status omitted installed host file integrity: $clean_status"
pass "verify reports and passes clean role + app deployment"

echo tampered >> "$runtime_tool"
status --verify >/dev/null 2>&1 && fail "host runtime executable tamper not detected"
echo "trusted runtime" > "$runtime_tool"
status --verify >/dev/null || fail "restored host runtime executable still drifting"
pass "verify detects host runtime executable tamper"

echo tampered >> "$installed_file"
status --verify >/dev/null 2>&1 && fail "installed host file tamper not detected"
echo "tracked installed unit" > "$installed_target"
status --verify >/dev/null || fail "restored installed host file still drifting"

installed_target_v2="$work/installed-unit-v2.service"
echo "different installed unit" > "$installed_target_v2"
ln -sfn "$installed_target_v2" "$installed_file"
status --verify >/dev/null 2>&1 && fail "installed host file symlink repoint not detected"
ln -sfn "$installed_target" "$installed_file"
status --verify >/dev/null || fail "restored installed host file symlink still drifting"
pass "verify detects installed host file tamper and symlink repoint"

# 6. tracked role-file tamper
echo tampered >> "$release/compose.yaml"
status --verify >/dev/null 2>&1 && fail "checksum tamper not detected"
git -C "$repo" show "HEAD:scripts/hns-deployment-fixtures/demo-role/compose.yaml" > "$release/compose.yaml"
status --verify >/dev/null || fail "restore after tamper still drifting"
pass "verify fails on tracked role-file modification"

# Role integrity includes every regular file, including a nested checksum name.
for added in added-untracked.conf bin/SHA256SUMS; do
  printf '%s\n' 'unrecorded role file' > "$release/$added"
  status --verify >/dev/null 2>&1 && fail "added role file not detected: $added"
  rm "$release/$added"
  status --verify >/dev/null || fail "removed role addition still drifting"
done
pass "verify rejects role additions including nested checksum files"

# 7. app integrity and symlink checks
app_test_file="$app_release/scripts/hns-deployment-fixtures/no-image-role/README.md"
echo tampered >> "$app_test_file"
status --verify >/dev/null 2>&1 && fail "app checksum tamper not detected"
git -C "$repo" show "HEAD:scripts/hns-deployment-fixtures/no-image-role/README.md" > "$app_test_file"
status --verify >/dev/null || fail "app restore after tamper still drifting"

echo injected > "$app_release/untracked-runtime-file"
status --verify >/dev/null 2>&1 && fail "added app file not detected"
rm "$app_release/untracked-runtime-file"

mv "$app_release/.pirate-deployment/SHA256SUMS" "$work/app-SHA256SUMS"
status --verify >/dev/null 2>&1 && fail "missing app manifest not detected"
mv "$work/app-SHA256SUMS" "$app_release/.pirate-deployment/SHA256SUMS"

old_app="$deploy_root/app-releases/0000000000000000000000000000000000000000"
cp -r "$app_release" "$old_app"
ln -sfn "app-releases/0000000000000000000000000000000000000000" "$deploy_root/app"
status --verify >/dev/null 2>&1 && fail "app symlink repoint not detected"
ln -sfn "app-releases/$commit" "$deploy_root/app"
status --verify >/dev/null || fail "restored app symlink still drifting"
pass "verify detects app tamper, added files, missing manifest, and repoint"

# 8. config drift
echo "PRIMARY_DNS_IP=198.51.100.9" > "$deploy_root/config/demo.env"
status --verify >/dev/null 2>&1 && fail "config drift not detected"
status --record-config >/dev/null
status --verify >/dev/null || fail "re-recorded config still drifting"
pass "verify fails on unrecorded config change"

# 9. unexpected running container
echo running > "$DOCKER_SHIM_STATE"
status --verify >/dev/null 2>&1 && fail "unexpected running container not detected"
pass "verify fails when container runs while EXPECT_RUNNING=false"

# 10. role symlink mismatch
echo absent > "$DOCKER_SHIM_STATE"
mkdir -p "$deploy_root/releases/deadbeef"
cp -r "$release/." "$deploy_root/releases/deadbeef/"
ln -sfn "releases/deadbeef" "$deploy_root/current"
status --verify >/dev/null 2>&1 && fail "symlink/commit mismatch not detected"
ln -sfn "releases/$commit" "$deploy_root/current"
pass "verify fails on current-symlink mismatch"

# 11. expected running container with matching digest
sed -i 's/^EXPECT_RUNNING=false$/EXPECT_RUNNING=true/' "$release/DEPLOYMENT"
(cd "$release" && find . -type f ! -path './SHA256SUMS' -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
echo running > "$DOCKER_SHIM_STATE"
status --verify >/dev/null || fail "matching running deployment reported drift"
export DOCKER_SHIM_DIGEST="2222222222222222222222222222222222222222222222222222222222222222"
status --verify >/dev/null 2>&1 && fail "digest mismatch not detected"
pass "verify checks running image digest against the pin"

# Exact IDs cover locally built images that cannot have a registry RepoDigest.
export DOCKER_SHIM_DIGEST="1111111111111111111111111111111111111111111111111111111111111111"
sed -i '/^EXPECT_RUNNING=/a LOCAL_IMAGE_ID_1=pirate-demo-role=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' "$release/DEPLOYMENT"
(cd "$release" && find . -type f ! -path './SHA256SUMS' -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
export DOCKER_SHIM_IMAGE_ID="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
status --verify >/dev/null || fail "matching local image ID reported drift"
export DOCKER_SHIM_IMAGE_ID="sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
status --verify >/dev/null 2>&1 && fail "local image ID mismatch not detected"
export DOCKER_SHIM_IMAGE_ID="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
pass "verify checks locally built container image IDs"

# Wrappers select explicit states without exposing a managed URL in arguments.
cat > "$shim/python3" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" > "${SIGNAL_SHIM_ARGS:?}"
EOF
chmod +x "$shim/python3"
export SIGNAL_SHIM_ARGS="$work/signal-args"
HNS_HEALTHCHECK_URL_FILE="$work/private-managed-url" \
  bash "$tooling_dir/alert-on-failure.sh" pirate-deployment-verify@observer.service >/dev/null
grep -Fxq 'failure' "$SIGNAL_SHIM_ARGS" || fail "failure wrapper did not select the failure state"
export DOCKER_SHIM_DIGEST="1111111111111111111111111111111111111111111111111111111111111111"
DEPLOY_ROOT="$deploy_root" HNS_HEALTHCHECK_URL_FILE="$work/private-managed-url" \
  bash "$deploy_root/current/bin/verify-deployment.sh" >/dev/null \
  || fail "successful verification did not invoke heartbeat"
grep -Fxq 'success' "$SIGNAL_SHIM_ARGS" || fail "heartbeat did not select the success state"
grep -Fxq "demo-role:$commit" "$SIGNAL_SHIM_ARGS" || fail "heartbeat omitted its bound source"
pass "wrappers distinguish failed and successful verification signals"

# N. metadata parsing must fail closed for multi-service and comment-shadowed
# compose files. Both of these silently produced wrong or empty DEPLOYMENT
# metadata before, which made the drift verifier skip container checks entirely.
multi_role="$repo/scripts/hns-deployment-fixtures/multi-role"
mkdir -p "$multi_role"
cat > "$multi_role/compose.yaml" <<'EOF'
services:
  local:
    image: locally-built:1
    container_name: pirate-local
  pinned:
    image: foo/bar:1@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
    container_name: pirate-pinned
EOF
commented_role="$repo/scripts/hns-deployment-fixtures/commented-role"
mkdir -p "$commented_role"
cat > "$commented_role/compose.yaml" <<'EOF'
services:
  # tooling derives container_name: and image: from this file
  only:
    image: foo/bar:1@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    container_name: pirate-only
EOF
git -C "$repo" -c user.email=fixture@invalid.example -c user.name=fixture_role add -A
git -C "$repo" -c user.email=fixture@invalid.example -c user.name=fixture_role commit -qm "multi-service fixtures"
multi_commit="$(git -C "$repo" rev-parse HEAD)"
git -C "$repo" update-ref refs/remotes/origin/main "$multi_commit"

if (cd "$repo" && bash scripts/hns-deployment/make-release.sh \
    scripts/hns-deployment-fixtures/multi-role "$work/multi-out" --expect-running false >/dev/null 2>&1); then
  fail "make-release guessed a container for a multi-service compose file"
fi
pass "make-release refuses to guess the monitored container"

(cd "$repo" && bash scripts/hns-deployment/make-release.sh \
  scripts/hns-deployment-fixtures/multi-role "$work/multi-ok" --expect-running false \
  --monitored-container pirate-pinned >/dev/null) \
  || fail "make-release rejected an explicit monitored container"
multi_meta="$work/multi-ok/releases/$multi_commit/DEPLOYMENT"
grep -Fxq "CONTAINER_NAME=pirate-pinned" "$multi_meta" \
  || fail "monitored container was not recorded"
grep -q "IMAGE_DIGEST=foo/bar:1@sha256:bbbb" "$multi_meta" \
  || fail "digest was not taken from the monitored container's own service"
pass "make-release pairs the digest with the monitored container's service"

if (cd "$repo" && bash scripts/hns-deployment/make-release.sh \
    scripts/hns-deployment-fixtures/multi-role "$work/multi-bad" --expect-running false \
    --monitored-container not-declared >/dev/null 2>&1); then
  fail "make-release accepted an undeclared monitored container"
fi
pass "make-release rejects an undeclared monitored container"

(cd "$repo" && bash scripts/hns-deployment/make-release.sh \
  scripts/hns-deployment-fixtures/commented-role "$work/commented-out" --expect-running false >/dev/null) \
  || fail "make-release failed on a compose file whose comments mention the keys"
grep -Fxq "CONTAINER_NAME=pirate-only" "$work/commented-out/releases/$multi_commit/DEPLOYMENT" \
  || fail "a comment mentioning the key shadowed the real container_name"
pass "make-release ignores key names appearing in comments"

# N. Commits outside the locally fetched protected branch fail closed. The
# emergency path is explicit and leaves durable metadata in both release kinds.
echo "branch-only" > "$repo/branch-only.txt"
git -C "$repo" -c user.email=fixture@invalid.example -c user.name=fixture_role add branch-only.txt
git -C "$repo" -c user.email=fixture@invalid.example -c user.name=fixture_role commit -qm "branch-only fixture"
branch_commit="$(git -C "$repo" rev-parse HEAD)"

if (cd "$repo" && bash scripts/hns-deployment/make-release.sh \
    scripts/hns-deployment-fixtures/no-image-role "$work/non-main-role" --expect-running false >/dev/null 2>&1); then
  fail "make-release accepted a non-main commit without break-glass metadata"
fi
if (cd "$repo" && bash scripts/hns-deployment/make-app-release.sh \
    "$work/non-main-app" --commit "$branch_commit" >/dev/null 2>&1); then
  fail "make-app-release accepted a non-main commit without break-glass metadata"
fi

break_glass_reference="change-vps-provenance-test"
(cd "$repo" && bash scripts/hns-deployment/make-app-release.sh \
  "$work/break-glass-app" --commit "$branch_commit" \
  --break-glass-non-main "$break_glass_reference") >/dev/null
(cd "$repo" && bash scripts/hns-deployment/make-release.sh \
  scripts/hns-deployment-fixtures/no-image-role "$work/break-glass-role" --expect-running false \
  --app-commit "$branch_commit" \
  --break-glass-non-main "$break_glass_reference") >/dev/null

break_glass_app_meta="$work/break-glass-app/app-releases/$branch_commit/.pirate-deployment/DEPLOYMENT"
break_glass_role_meta="$work/break-glass-role/releases/$branch_commit/DEPLOYMENT"
grep -Fxq 'APP_PROVENANCE=break-glass' "$break_glass_app_meta" \
  || fail "app break-glass provenance was not recorded"
grep -Fxq 'SOURCE_PROVENANCE=break-glass' "$break_glass_role_meta" \
  || fail "role break-glass source provenance was not recorded"
grep -Fxq 'APP_PROVENANCE=break-glass' "$break_glass_role_meta" \
  || fail "role break-glass app provenance was not recorded"
grep -Fxq "PROVENANCE_BREAK_GLASS_REFERENCE=$break_glass_reference" "$break_glass_role_meta" \
  || fail "break-glass reference was not recorded"
pass "release construction enforces main ancestry and records break-glass use"

git -C "$repo" update-ref -d refs/remotes/origin/main
missing_ref_error="$work/missing-main-ref-error"
if (cd "$repo" && bash scripts/hns-deployment/make-release.sh \
    scripts/hns-deployment-fixtures/no-image-role "$work/missing-main-role" --expect-running false \
    > /dev/null 2> "$missing_ref_error"); then
  fail "make-release accepted a commit without the required origin/main ref"
fi
grep -Fq 'required remote-tracking ref refs/remotes/origin/main is not available locally' \
  "$missing_ref_error" || fail "missing origin/main diagnostic was ambiguous"
git -C "$repo" update-ref refs/remotes/origin/main "$multi_commit"
pass "release provenance distinguishes a missing origin/main ref"

# 20. Per-service runtime configuration. A container can run the pinned image
# while differing from its release (extra Compose file, changed command, added
# mount, systemd drop-in). Services may deliberately stay on a retained older
# release, so expectations are per service. Uses its own docker/systemctl shims
# and the real python3 (the heartbeat tests above shim python3).
PATH="${PATH#"$shim":}"
rt_shim="$work/rt-shim"
rt_fixtures="$work/rt-fixtures"
mkdir -p "$rt_shim" "$rt_fixtures"
cat > "$rt_shim/docker" <<'EOF'
#!/usr/bin/env bash
fixtures="${RT_FIXTURES:?}"
if [[ "$1" == inspect && "${2:-}" == --format ]]; then
  # Existing digest check on the monitored container.
  [[ -f "$fixtures/$4.json" ]] || exit 1
  echo "running 2026-11-03T00:00:00Z img-$4"
elif [[ "$1" == inspect ]]; then
  [[ -f "$fixtures/$2.json" ]] || exit 1
  cat "$fixtures/$2.json"
elif [[ "$1 $2" == "image inspect" ]]; then
  echo "example/dnsdist@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
elif [[ "$1" == ps ]]; then
  cat "$fixtures/ps.txt"
else
  exit 1
fi
EOF
cat > "$rt_shim/systemctl" <<'EOF'
#!/usr/bin/env bash
fixtures="${RT_FIXTURES:?}"
[[ "$1" == show ]] || exit 1
case "$3" in
  DropInPaths) cat "$fixtures/dropins.txt" ;;
  Environment) cat "$fixtures/environment.txt" ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$rt_shim/docker" "$rt_shim/systemctl"
export RT_FIXTURES="$rt_fixtures"
PATH="$rt_shim:$PATH"
: > "$rt_fixtures/dropins.txt"
echo "DEPLOY_ROOT=/srv/test" > "$rt_fixtures/environment.txt"

resolver_role="$repo/scripts/hns-deployment-fixtures/resolver-role"
mkdir -p "$resolver_role"
cat > "$resolver_role/compose.yaml" <<'EOF'
services:
  doh:
    image: example/dnsdist@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
    container_name: pirate-test-dnsdist
  spv:
    image: pirate-test-hnsd:1
    container_name: pirate-test-spv
EOF
echo "dnsdist v1" > "$resolver_role/dnsdist.conf"
git -C "$repo" -c user.email=fixture@invalid.example -c user.name=fixture_role add -A
git -C "$repo" -c user.email=fixture@invalid.example -c user.name=fixture_role commit -qm "resolver fixture v1"
old_commit="$(git -C "$repo" rev-parse HEAD)"
git -C "$repo" update-ref refs/remotes/origin/main "$old_commit"
rt="$work/rt-deploy"
(cd "$repo" && bash scripts/hns-deployment/make-release.sh scripts/hns-deployment-fixtures/resolver-role \
  "$rt" --expect-running true --monitored-container pirate-test-dnsdist >/dev/null)

echo "aggressive-nsec: no" > "$resolver_role/unbound.conf"
git -C "$repo" -c user.email=fixture@invalid.example -c user.name=fixture_role add -A
git -C "$repo" -c user.email=fixture@invalid.example -c user.name=fixture_role commit -qm "resolver fixture v2"
new_commit="$(git -C "$repo" rev-parse HEAD)"
git -C "$repo" update-ref refs/remotes/origin/main "$new_commit"

rt_release() {
  (cd "$repo" && bash scripts/hns-deployment/make-release.sh scripts/hns-deployment-fixtures/resolver-role \
    "$@" --expect-running true --monitored-container pirate-test-dnsdist)
}
spv_mounts='pirate-test-spv=/var/lib/hnsd|${DEPLOY_ROOT}/shared/spv|rw'
dnsdist_mounts="pirate-test-dnsdist=/etc/dnsdist/dnsdist.conf|\${RELEASE:$old_commit}/dnsdist.conf|ro"

# make-release fails closed on malformed or unknown runtime expectations.
for bad in "--container-args pirate-test-spv=not-json" \
           "--container-args pirate-test-spv={\"a\":1}" \
           "--container-release pirate-test-spv=main" \
           "--container-release undeclared=self" \
           "--container-mounts pirate-test-spv=relative|/x|rw" \
           "--systemd-unit not-a-service"; do
  # shellcheck disable=SC2086
  if rt_release "$work/rt-bad" --compose-project hnsdoh-test $bad >/dev/null 2>&1; then
    fail "make-release accepted a bad runtime expectation: $bad"
  fi
done
if rt_release "$work/rt-bad" --container-release pirate-test-spv=self >/dev/null 2>&1; then
  fail "make-release accepted --container-release without --compose-project"
fi
pass "make-release rejects malformed, unknown or unscoped runtime expectations"

rt_release "$rt" --compose-project hnsdoh-test \
  --container-release pirate-test-spv=self --container-release "pirate-test-dnsdist=$old_commit" \
  --container-args 'pirate-test-spv=[ ]' \
  --container-mounts "$spv_mounts" --container-mounts "$dnsdist_mounts" \
  --systemd-unit test-resolver.service >/dev/null
rt_meta="$rt/releases/$new_commit/DEPLOYMENT"
for line in "COMPOSE_PROJECT=hnsdoh-test" "CONTAINER_RELEASE_1=pirate-test-spv=self" \
            "CONTAINER_RELEASE_2=pirate-test-dnsdist=$old_commit" "CONTAINER_ARGS_1=pirate-test-spv=[]" \
            "CONTAINER_MOUNTS_1=$spv_mounts" "CONTAINER_MOUNTS_2=$dnsdist_mounts" \
            "SYSTEMD_UNIT_1=test-resolver.service"; do
  grep -Fxq -- "$line" "$rt_meta" || fail "DEPLOYMENT is missing '$line'"
done
pass "make-release records per-service runtime expectations (args canonicalized)"
ln -s "releases/$new_commit" "$rt/current"

write_container() {  # name workdir config_files args_json mounts_json
  python3 - "$rt_fixtures/$1.json" "$2" "$3" "$4" "$5" <<'PY'
import json, sys
out, workdir, files, args, mounts = sys.argv[1:]
json.dump([{
  "Args": json.loads(args),
  "Mounts": json.loads(mounts),
  "Config": {"Labels": {
    "com.docker.compose.project": "hnsdoh-test",
    "com.docker.compose.project.working_dir": workdir,
    "com.docker.compose.project.config_files": files}},
}], open(out, "w"))
PY
}
spv_clean() {
  write_container pirate-test-spv "$rt/releases/$new_commit" "$rt/releases/$new_commit/compose.yaml" '[]' \
    "[{\"Type\":\"bind\",\"Source\":\"$rt/shared/spv\",\"Destination\":\"/var/lib/hnsd\",\"RW\":true}]"
}
dnsdist_clean() {
  write_container pirate-test-dnsdist "$rt/releases/$old_commit" "$rt/releases/$old_commit/compose.yaml" \
    '["--","/usr/local/bin/dnsdist-startup"]' \
    "[{\"Type\":\"bind\",\"Source\":\"$rt/releases/$old_commit/dnsdist.conf\",\"Destination\":\"/etc/dnsdist/dnsdist.conf\",\"RW\":false}]"
}
spv_clean
dnsdist_clean
printf '%s\n' pirate-test-spv pirate-test-dnsdist > "$rt_fixtures/ps.txt"
rt_status() { bash "$rt/current/bin/deployment-status.sh" --deploy-root "$rt" "$@"; }
rt_drifts() {  # expectation text: verify must fail and report it
  local out
  out="$(rt_status --verify 2>&1)" && fail "$1 was not reported as drift"
  grep -Fq -- "$2" <<< "$out" || fail "$1: expected drift containing '$2', got: $out"
}

mixed="$(rt_status --verify)" || fail "clean mixed-release state reported drift: $(rt_status)"
grep -Fq "running: pirate-test-spv created from release self compose.yaml only" <<< "$mixed" \
  || fail "status omitted the resolver's provenance: $mixed"
grep -Fq "running: pirate-test-dnsdist created from release $old_commit compose.yaml only" <<< "$mixed" \
  || fail "status omitted the retained dnsdist provenance: $mixed"
grep -Fq "release: retained $old_commit checksums OK (used by pirate-test-dnsdist)" <<< "$mixed" \
  || fail "status omitted retained release integrity: $mixed"
grep -Fq "systemd: test-resolver.service has no drop-ins or Compose overrides" <<< "$mixed" \
  || fail "status omitted the systemd check: $mixed"
pass "verify passes a clean mixed-release state (resolver new, dnsdist retained)"

echo "tampered" >> "$rt/releases/$old_commit/dnsdist.conf"
rt_drifts "retained release tamper" "retained release $old_commit (used by pirate-test-dnsdist) fails its checksums"
echo "dnsdist v1" > "$rt/releases/$old_commit/dnsdist.conf"
mv "$rt/releases/$old_commit" "$work/rt-old-moved"
rt_drifts "missing retained release" "retained release $old_commit (used by pirate-test-dnsdist) is missing"
mv "$work/rt-old-moved" "$rt/releases/$old_commit"
rt_status --verify >/dev/null || fail "restored retained release still drifting"
pass "verify requires retained releases to exist and pass their own checksums"

write_container pirate-test-dnsdist "$rt/releases/$new_commit" "$rt/releases/$new_commit/compose.yaml" \
  '["--","/usr/local/bin/dnsdist-startup"]' \
  "[{\"Type\":\"bind\",\"Source\":\"$rt/releases/$old_commit/dnsdist.conf\",\"Destination\":\"/etc/dnsdist/dnsdist.conf\",\"RW\":false}]"
rt_drifts "dnsdist on an unexpected release" "container pirate-test-dnsdist was created from $rt/releases/$new_commit, expected release $old_commit"
dnsdist_clean
write_container pirate-test-spv "$rt/releases/$old_commit" "$rt/releases/$old_commit/compose.yaml" '[]' \
  "[{\"Type\":\"bind\",\"Source\":\"$rt/shared/spv\",\"Destination\":\"/var/lib/hnsd\",\"RW\":true}]"
rt_drifts "resolver left on the old release" "container pirate-test-spv was created from $rt/releases/$old_commit, expected release self"
spv_clean
pass "verify checks each container against its own expected release"

write_container pirate-test-spv "$rt/releases/$new_commit" "$rt/releases/$new_commit/compose.yaml" \
  '["--rs-config","/etc/hnsd/unbound.conf"]' \
  "[{\"Type\":\"bind\",\"Source\":\"$rt/shared/spv\",\"Destination\":\"/var/lib/hnsd\",\"RW\":true}]"
rt_drifts "override arguments" 'container pirate-test-spv args ["--rs-config","/etc/hnsd/unbound.conf"] differ from expected []'
write_container pirate-test-spv "$rt/releases/$new_commit" \
  "$rt/releases/$new_commit/compose.yaml,/srv/overrides/spv-override.yaml" '[]' \
  "[{\"Type\":\"bind\",\"Source\":\"$rt/shared/spv\",\"Destination\":\"/var/lib/hnsd\",\"RW\":true}]"
rt_drifts "extra Compose file" "was created with Compose files '$rt/releases/$new_commit/compose.yaml,/srv/overrides/spv-override.yaml'"
write_container pirate-test-spv "$rt/releases/$new_commit" "$rt/releases/$new_commit/compose.yaml" '[]' \
  "[{\"Type\":\"bind\",\"Source\":\"$rt/shared/spv\",\"Destination\":\"/var/lib/hnsd\",\"RW\":true},{\"Type\":\"bind\",\"Source\":\"/srv/overrides/unbound.conf\",\"Destination\":\"/etc/hnsd/unbound.conf\",\"RW\":false}]"
rt_drifts "extra bind mount" "container pirate-test-spv mounts"
spv_clean
pass "verify detects override arguments, extra Compose files and extra mounts"

printf '%s\n' pirate-test-spv pirate-test-dnsdist pirate-test-stray > "$rt_fixtures/ps.txt"
rt_drifts "unexpected project container" "container pirate-test-stray in Compose project hnsdoh-test has no recorded release expectation"
printf '%s\n' pirate-test-spv pirate-test-dnsdist > "$rt_fixtures/ps.txt"
pass "verify flags project containers without an expectation"

echo "/etc/systemd/system/test-resolver.service.d/override.conf" > "$rt_fixtures/dropins.txt"
rt_drifts "systemd drop-in" "systemd unit test-resolver.service has drop-ins"
: > "$rt_fixtures/dropins.txt"
echo "DEPLOY_ROOT=/srv/test COMPOSE_FILE=compose.yaml:/srv/overrides/spv-override.yaml" > "$rt_fixtures/environment.txt"
rt_drifts "COMPOSE_FILE in unit environment" "systemd unit test-resolver.service sets a Compose override in its environment"
echo "DEPLOY_ROOT=/srv/test" > "$rt_fixtures/environment.txt"
rt_status --verify >/dev/null || fail "restored systemd state still drifting"
pass "verify detects systemd drop-ins and Compose environment overrides"

sed -i "s/^CONTAINER_RELEASE_1=.*/CONTAINER_RELEASE_1=pirate-test-spv=not-a-commit/" "$rt_meta"
(cd "$rt/releases/$new_commit" && find . -type f ! -path './SHA256SUMS' -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
rt_drifts "malformed CONTAINER_RELEASE" "CONTAINER_RELEASE_1 is malformed"
pass "verify fails closed on malformed runtime expectation keys"

# Releases without these keys keep their previous report unchanged.
if grep -Eq '^(COMPOSE_PROJECT|CONTAINER_RELEASE_|CONTAINER_ARGS_|CONTAINER_MOUNTS_|SYSTEMD_UNIT_)' "$release/DEPLOYMENT" \
  || grep -Eq 'compose.yaml only|^systemd:|args match|mounts match|retained .* checksums' <<< "$clean_status"; then
  fail "a release without runtime expectations changed its report"
fi
pass "releases without runtime expectations are reported exactly as before"

echo "all deployment-tooling checks passed"
