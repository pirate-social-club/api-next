#!/usr/bin/env bash
set -euo pipefail

# Stages an immutable release for a VPS role from a CLEAN, exact git commit.
#
#   make-release.sh <role-dir> <output-root> [--expect-running true|false]
#     [--db-path REL] [--app-commit COMMIT] [--app-link REL]
#     [--monitored-container NAME]
#     [--local-image-id CONTAINER=sha256:IMAGE_ID]...
#     [--break-glass-non-main INCIDENT_OR_CHANGE_REFERENCE]
#
# Example:
#   make-release.sh scripts/hns-secondary-dns /tmp/ns2-out --expect-running false \
#     --db-path shared/data/pdns.sqlite3
#
# Produces <output-root>/releases/<source-commit>/ containing the role's tracked
# files, the deployment tooling under bin/, a DEPLOYMENT metadata file, and
# SHA256SUMS covering every file in the release. The operator copies the
# release directory to $DEPLOY_ROOT/releases/ on the host and flips the
# `current` symlink. Configuration and persistent data live outside releases.
#
# Refuses dirty trees and commits outside locally fetched origin/main unless an
# approved break-glass reference is recorded.

role_dir="${1:?usage: make-release.sh <role-dir> <output-root> [flags]}"
output_root="${2:?usage: make-release.sh <role-dir> <output-root> [flags]}"
shift 2

expect_running="true"
db_path=""
app_commit=""
app_link="app"
monitored_container=""
local_image_ids=()
break_glass_reason=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect-running) shift; expect_running="${1:?}" ;;
    --db-path) shift; db_path="${1:?}" ;;
    --app-commit) shift; app_commit="${1:?}" ;;
    --app-link) shift; app_link="${1:?}" ;;
    --monitored-container) shift; monitored_container="${1:?}" ;;
    --local-image-id) shift; local_image_ids+=("${1:?}") ;;
    --break-glass-non-main) shift; break_glass_reason="${1:?}" ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

for local_image in "${local_image_ids[@]}"; do
  if [[ ! "$local_image" =~ ^[A-Za-z0-9_.-]+=sha256:[a-f0-9]{64}$ ]]; then
    echo "--local-image-id must be CONTAINER=sha256:<64 lowercase hex characters>" >&2
    exit 2
  fi
done

if [[ -n "$app_commit" && ! "$app_commit" =~ ^[a-f0-9]{40}$ ]]; then
  echo "--app-commit must be a full lowercase 40-character git commit" >&2
  exit 2
fi
if [[ -n "$app_commit" && ( "$app_link" = /* || "$app_link" == *..* ) ]]; then
  echo "--app-link must stay beneath the deployment root" >&2
  exit 2
fi

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

if [[ ! -d "$role_dir" ]]; then
  echo "role directory not found: $role_dir" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "refusing to build a release from a dirty tree; commit or stash first" >&2
  exit 1
fi

source_commit="$(git rev-parse HEAD)"
source "$repo_root/scripts/hns-deployment/git-provenance.sh"
assert_release_provenance "$source_commit" "$break_glass_reason" "$repo_root"
source_provenance="$RELEASE_PROVENANCE"
app_provenance=""
if [[ -n "$app_commit" ]]; then
  git cat-file -e "$app_commit^{commit}" 2>/dev/null \
    || { echo "app commit does not exist locally: $app_commit" >&2; exit 1; }
  assert_release_provenance "$app_commit" "$break_glass_reason" "$repo_root"
  app_provenance="$RELEASE_PROVENANCE"
fi
release_dir="$output_root/releases/$source_commit"
if [[ -e "$release_dir" ]]; then
  echo "release already exists: $release_dir" >&2
  exit 1
fi
mkdir -p "$release_dir/bin"

# Tracked role files only — anything untracked cannot enter a release.
git ls-files -z -- "$role_dir" | while IFS= read -r -d '' f; do
  rel="${f#"$role_dir"/}"
  mkdir -p "$release_dir/$(dirname "$rel")"
  cp "$f" "$release_dir/$rel"
done

tooling_dir="scripts/hns-deployment"
for script in deployment-status.sh verify-deployment.sh alert-on-failure.sh heartbeat.sh record-installed-files.sh ping-healthcheck.py; do
  cp "$tooling_dir/$script" "$release_dir/bin/$script"
  chmod 0755 "$release_dir/bin/$script"
done
mkdir -p "$release_dir/systemd"
cp "$tooling_dir"/systemd/*.service "$tooling_dir"/systemd/*.timer "$release_dir/systemd/"

# A role may stage digest-pinned, generated or downloaded runtime assets into
# its immutable release. The stager is itself tracked at the exact source commit,
# receives only the empty release destination, and must fail closed on any
# provenance or checksum mismatch. Its output is covered by SHA256SUMS below.
asset_stager="$role_dir/bin/stage-release-assets.sh"
if [[ -f "$asset_stager" ]]; then
  if [[ ! -x "$asset_stager" ]]; then
    echo "release asset stager is not executable: $asset_stager" >&2
    exit 1
  fi
  "$repo_root/$asset_stager" "$release_dir"
fi

# Pinned image digest and container name from the role's compose file, if any.
#
# This metadata is what the drift verifier checks at runtime, so parsing it must
# fail CLOSED. Taking the first grep match over the whole file went wrong in two
# real ways: a comment mentioning a key name was matched ahead of the real key,
# leaving CONTAINER_NAME empty so drift checks silently skipped the container
# entirely; and in a multi-service file whose first service is built locally
# (no digest), the first container name was paired with a later service's digest.
# Empty metadata is indistinguishable from "this role has no container", so an
# ambiguous or failed parse aborts instead of staging a release that verifies
# less than the operator thinks.
image_digest=""
container_name=""
compose_file="$role_dir/compose.yaml"
if [[ -f "$compose_file" ]]; then
  # Strip comments, then read per service block so a name is only ever paired
  # with the digest from its own service.
  compose_body="$(sed 's/#.*$//' "$compose_file")"
  service_pairs="$(awk '
    /^  [a-zA-Z0-9_.-]+:[[:space:]]*$/ { svc=$1; sub(/:$/, "", svc); next }
    svc == "" { next }
    $1 == "image:" && $2 ~ /@sha256:[a-f0-9]{40,}/ { digest[svc]=$2 }
    $1 == "container_name:" { cname[svc]=$2; order[++n]=svc }
    END { for (i=1; i<=n; i++) { s=order[i]; printf "%s\t%s\n", cname[s], digest[s] } }
  ' <<< "$compose_body")"

  declared_names="$(grep -cE '^[[:space:]]+container_name:' <<< "$compose_body" || true)"
  parsed_names="$(grep -c . <<< "${service_pairs:-}" || true)"

  if (( declared_names > 0 && parsed_names == 0 )); then
    echo "compose declares container_name but none could be parsed; refusing to stage metadata that verifies nothing" >&2
    exit 2
  fi
  if (( parsed_names > 1 )) && [[ -z "$monitored_container" ]]; then
    echo "compose declares $parsed_names containers; pass --monitored-container to say which one DEPLOYMENT describes" >&2
    cut -f1 <<< "$service_pairs" | sed 's/^/  /' >&2
    exit 2
  fi

  if [[ -n "$monitored_container" ]]; then
    match="$(awk -F'\t' -v want="$monitored_container" '$1 == want { print; found=1 } END { exit !found }' <<< "$service_pairs")" \
      || { echo "--monitored-container '$monitored_container' is not declared in $compose_file" >&2; exit 2; }
  else
    match="$service_pairs"
  fi
  container_name="$(cut -f1 <<< "$match")"
  image_digest="$(cut -f2 <<< "$match")"
fi

{
  echo "ROLE=$(basename "$role_dir")"
  echo "SOURCE_COMMIT=$source_commit"
  echo "SOURCE_PROVENANCE=$source_provenance"
  echo "PROVENANCE_MAIN_REF=$DEPLOYMENT_MAIN_REF"
  if [[ -n "$app_commit" ]]; then
    echo "APP_COMMIT=$app_commit"
    echo "APP_PROVENANCE=$app_provenance"
    echo "APP_LINK=$app_link"
  fi
  if [[ "$source_provenance" == "break-glass" || "$app_provenance" == "break-glass" ]]; then
    echo "PROVENANCE_BREAK_GLASS_REFERENCE=$break_glass_reason"
  fi
  [[ -n "$image_digest" ]] && echo "IMAGE_DIGEST=$image_digest"
  [[ -n "$container_name" ]] && echo "CONTAINER_NAME=$container_name"
  local_image_index=0
  for local_image in "${local_image_ids[@]}"; do
    local_image_index=$((local_image_index + 1))
    echo "LOCAL_IMAGE_ID_${local_image_index}=$local_image"
  done
  echo "EXPECT_RUNNING=$expect_running"
  [[ -n "$db_path" ]] && echo "DB_PATH=$db_path"
  echo "DEPLOYED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$release_dir/DEPLOYMENT"

(
  cd "$release_dir"
  find . -type f ! -path './SHA256SUMS' -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS
)

echo "release staged: $release_dir"
echo "source commit:    $source_commit"
if [[ -n "$image_digest" ]]; then
  echo "image digest:   $image_digest"
fi
