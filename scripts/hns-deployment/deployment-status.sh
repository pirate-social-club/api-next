#!/usr/bin/env bash
set -euo pipefail

# Reports desired-vs-running deployment state for a VPS role deployed with the
# immutable-release layout produced by make-release.sh:
#
#   $DEPLOY_ROOT/
#     current -> releases/<source-commit>
#     releases/<source-commit>/{DEPLOYMENT,SHA256SUMS,bin/,...}
#     app -> app-releases/<app-commit>    optional, declared by DEPLOYMENT
#     config/            host-local configuration (never inside a release)
#     shared/            persistent state (never inside a release)
#
# Modes:
#   deployment-status.sh [--deploy-root DIR]            human-readable report, exit 0
#   deployment-status.sh --verify [--deploy-root DIR]   same checks, exit 1 on any drift
#   deployment-status.sh --record-config [...]          record config/CONFIG_SHA256 and exit
#
# DEPLOY_ROOT may also come from the environment. Only hashes of configuration
# are ever recorded or printed — never configuration contents.

mode="status"
deploy_root="${DEPLOY_ROOT:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --verify) mode="verify" ;;
    --record-config) mode="record-config" ;;
    --deploy-root) shift; deploy_root="${1:-}" ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

if [[ -z "$deploy_root" ]]; then
  echo "DEPLOY_ROOT is not set (flag --deploy-root or environment)" >&2
  exit 2
fi

drift=()
note() { printf '%s\n' "$1"; }
mark_drift() { drift+=("$1"); }

config_hash() {
  # Combined hash over sorted config file names + contents, excluding the
  # recorded-hash file itself. Prints nothing if the config dir is absent.
  local dir="$deploy_root/config"
  [[ -d "$dir" ]] || return 0
  (
    cd "$dir"
    find . -type f ! -name CONFIG_SHA256 -print0 | sort -z \
      | xargs -0 --no-run-if-empty sha256sum
  ) | sha256sum | awk '{print $1}'
}

if [[ "$mode" == "record-config" ]]; then
  hash="$(config_hash)"
  if [[ -z "$hash" ]]; then
    echo "no config directory at $deploy_root/config" >&2
    exit 1
  fi
  printf '%s\n' "$hash" > "$deploy_root/config/CONFIG_SHA256"
  echo "recorded config hash $hash"
  exit 0
fi

# --- desired state -----------------------------------------------------------

current_link="$deploy_root/current"
if [[ ! -L "$current_link" ]]; then
  mark_drift "current symlink missing at $current_link"
  release_dir=""
else
  release_dir="$(readlink -f "$current_link")"
fi

declare -A dep=()
if [[ -n "$release_dir" && -f "$release_dir/DEPLOYMENT" ]]; then
  while IFS='=' read -r key value; do
    [[ -n "$key" && "$key" != \#* ]] && dep["$key"]="$value"
  done < "$release_dir/DEPLOYMENT"
else
  [[ -n "$release_dir" ]] && mark_drift "DEPLOYMENT file missing in $release_dir"
fi

role="${dep[ROLE]:-unknown}"
source_commit="${dep[SOURCE_COMMIT]:-}"
source_provenance="${dep[SOURCE_PROVENANCE]:-legacy-unrecorded}"
image_digest="${dep[IMAGE_DIGEST]:-}"
container_name="${dep[CONTAINER_NAME]:-}"
expect_running="${dep[EXPECT_RUNNING]:-true}"
app_commit="${dep[APP_COMMIT]:-}"
app_provenance="${dep[APP_PROVENANCE]:-legacy-unrecorded}"
app_link="${dep[APP_LINK]:-app}"

note "host:    $(hostname -s)  role: $role"
if [[ -z "${HNS_HEALTHCHECK_URL_FILE:-}" ]]; then
  note "heartbeat: not configured (HNS_HEALTHCHECK_URL_FILE is unset)"
fi
note "desired: source ${source_commit:-unknown}  provenance $source_provenance  image ${image_digest:-unpinned}"
if [[ -n "$app_commit" ]]; then
  note "desired: app  $app_commit  provenance $app_provenance"
fi
if [[ "$source_provenance" == "break-glass" || "$app_provenance" == "break-glass" ]]; then
  note "warning:  deployment provenance used recorded break-glass authority"
fi

if [[ -n "$release_dir" && -n "$source_commit" ]]; then
  if [[ "$(basename "$release_dir")" != "$source_commit" ]]; then
    mark_drift "current -> $(basename "$release_dir") but DEPLOYMENT says $source_commit"
  fi
fi

# --- release integrity -------------------------------------------------------

if [[ -n "$release_dir" && -f "$release_dir/SHA256SUMS" ]]; then
  if (cd "$release_dir" && sha256sum --check --quiet SHA256SUMS >/dev/null 2>&1); then
    expected_role_files="$(sed 's/^[a-f0-9]\{64\}  //' "$release_dir/SHA256SUMS" | sort)"
    actual_role_files="$(cd "$release_dir" && find . -type f ! -path './SHA256SUMS' -print | sort)"
    if [[ "$actual_role_files" == "$expected_role_files" ]]; then
      note "release: checksums OK ($(wc -l < "$release_dir/SHA256SUMS") files)"
    else
      mark_drift "role file set differs from SHA256SUMS"
    fi
  else
    mark_drift "release checksum mismatch (sha256sum --check SHA256SUMS failed)"
  fi
elif [[ -n "$release_dir" ]]; then
  mark_drift "SHA256SUMS missing in $release_dir"
fi

# --- separately versioned app integrity ------------------------------------

if [[ -n "$app_commit" ]]; then
  app_link_path="$deploy_root/$app_link"
  app_release_dir=""
  if [[ ! -L "$app_link_path" ]]; then
    mark_drift "app symlink missing at $app_link_path"
  else
    app_release_dir="$(readlink -f "$app_link_path")"
  fi

  if [[ -n "$app_release_dir" ]]; then
    expected_app_release_dir="$(readlink -m "$deploy_root/app-releases/$app_commit")"
    app_metadata="$app_release_dir/.pirate-deployment/DEPLOYMENT"
    app_sums="$app_release_dir/.pirate-deployment/SHA256SUMS"
    if [[ "$app_release_dir" != "$expected_app_release_dir" ]]; then
      mark_drift "$app_link -> $app_release_dir but expected $expected_app_release_dir"
    fi
    if [[ ! -f "$app_metadata" ]]; then
      mark_drift "app DEPLOYMENT missing in $app_release_dir/.pirate-deployment"
    else
      recorded_app_commit="$(sed -n 's/^APP_COMMIT=//p' "$app_metadata" | head -1)"
      if [[ "$recorded_app_commit" != "$app_commit" ]]; then
        mark_drift "app DEPLOYMENT says ${recorded_app_commit:-unknown} but role DEPLOYMENT says $app_commit"
      fi
      recorded_app_provenance="$(sed -n 's/^APP_PROVENANCE=//p' "$app_metadata" | head -1)"
      if [[ "$app_provenance" != "legacy-unrecorded" \
        && "$recorded_app_provenance" != "$app_provenance" ]]; then
        mark_drift "app provenance says ${recorded_app_provenance:-unknown} but role DEPLOYMENT says $app_provenance"
      fi
    fi

    if [[ ! -f "$app_sums" ]]; then
      mark_drift "app SHA256SUMS missing in $app_release_dir/.pirate-deployment"
    elif (cd "$app_release_dir" && sha256sum --check --quiet .pirate-deployment/SHA256SUMS >/dev/null 2>&1); then
      expected_app_files="$(sed 's/^[a-f0-9]\{64\}  //' "$app_sums" | sort)"
      actual_app_files="$(cd "$app_release_dir" && find . -type f ! -path './.pirate-deployment/SHA256SUMS' -print | sort)"
      if [[ "$actual_app_files" == "$expected_app_files" ]]; then
        note "app:     $app_commit checksums OK ($(wc -l < "$app_sums") files)"
      else
        mark_drift "app file set differs from .pirate-deployment/SHA256SUMS"
      fi
    else
      mark_drift "app checksum mismatch (sha256sum --check .pirate-deployment/SHA256SUMS failed)"
    fi
  fi
fi

# --- running container -------------------------------------------------------

container_state="unknown"
if [[ -n "$container_name" ]] && command -v docker >/dev/null 2>&1; then
  if inspect="$(docker inspect --format '{{.State.Status}} {{.State.StartedAt}} {{.Image}}' "$container_name" 2>/dev/null)"; then
    read -r container_state started_at image_id <<< "$inspect"
    running_digests="$(docker image inspect --format '{{join .RepoDigests ","}}' "$image_id" 2>/dev/null || true)"
    note "running: container $container_name $container_state (started $started_at)"
    if [[ "$container_state" == "running" ]]; then
      if [[ "$expect_running" != "true" ]]; then
        mark_drift "container is running but EXPECT_RUNNING=$expect_running"
      fi
      if [[ -n "$image_digest" ]]; then
        digest_only="${image_digest#*@}"
        if [[ ",$running_digests," == *"$digest_only"* ]]; then
          note "running: image digest matches pinned digest"
        else
          mark_drift "running image digests [$running_digests] do not include pinned $digest_only"
        fi
      fi
    else
      [[ "$expect_running" == "true" ]] && mark_drift "container $container_name is $container_state, expected running"
    fi
  else
    container_state="not-created"
    if [[ "$expect_running" == "true" ]]; then
      mark_drift "container $container_name does not exist, expected running"
    else
      note "running: container $container_name not created (expected: not running yet)"
    fi
  fi
elif [[ -n "$container_name" ]]; then
  mark_drift "docker unavailable; cannot inspect $container_name"
else
  note "running: no CONTAINER_NAME declared; container checks skipped"
fi

# Locally built images have no registry RepoDigest. Release construction can
# instead bind one or more container names to Docker's content-addressed image
# ID, joining the tracked recipe commit to the exact bytes launched on-host.
for key in "${!dep[@]}"; do
  [[ "$key" == LOCAL_IMAGE_ID_* ]] || continue
  local_image_record="${dep[$key]}"
  local_container="${local_image_record%%=*}"
  expected_local_image_id="${local_image_record#*=}"
  if [[ ! "$local_container" =~ ^[A-Za-z0-9_.-]+$ \
    || ! "$expected_local_image_id" =~ ^sha256:[a-f0-9]{64}$ ]]; then
    mark_drift "$key is malformed"
    continue
  fi
  if ! actual_local_image_id="$(docker inspect --format '{{.Image}}' "$local_container" 2>/dev/null)"; then
    mark_drift "local-image container $local_container does not exist"
  elif [[ "$actual_local_image_id" == "$expected_local_image_id" ]]; then
    note "running: local image ID matches for $local_container"
  else
    mark_drift "local-image container $local_container uses $actual_local_image_id, expected $expected_local_image_id"
  fi
done

# --- container runtime configuration ----------------------------------------

# A container can run the pinned image yet differ from its release: an extra
# Compose file (COMPOSE_FILE), a changed command, an added bind mount, or a
# systemd drop-in that reapplies such overrides. When DEPLOYMENT records the
# expectations below, compare them with the running containers. Releases that
# record none of these keys skip this section entirely.

# Prints one container's normalized runtime view as tab-separated lines:
#   args <compact JSON array> | mount <dest|source|ro-or-rw> | label <key> <value>
container_runtime_view() {
  docker inspect "$1" 2>/dev/null | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)[0]
except Exception:
    sys.exit(1)
print("args\t" + json.dumps(data.get("Args") or [], separators=(",", ":")))
for m in data.get("Mounts") or []:
    source = "volume:" + m.get("Name", "") if m.get("Type") == "volume" else m.get("Source", "")
    print("mount\t%s|%s|%s" % (m.get("Destination", ""), source, "rw" if m.get("RW") else "ro"))
labels = (data.get("Config") or {}).get("Labels") or {}
for key in ("com.docker.compose.project", "com.docker.compose.project.working_dir", "com.docker.compose.project.config_files"):
    print("label\t%s\t%s" % (key, labels.get(key, "")))
'
}

release_path_for() {
  # self -> the current release; otherwise a retained release commit.
  if [[ "$1" == self ]]; then printf '%s\n' "$deploy_root/releases/$source_commit"
  else printf '%s\n' "$deploy_root/releases/$1"; fi
}

expand_mount_spec() {
  # Expand ${DEPLOY_ROOT} and ${RELEASE:...} and print one sorted entry per line.
  local spec="$1" entry
  [[ -z "$spec" ]] && return 0
  tr ';' '\n' <<< "$spec" | while IFS= read -r entry; do
    entry="${entry//\$\{DEPLOY_ROOT\}/$deploy_root}"
    entry="${entry//\$\{RELEASE:self\}/$deploy_root/releases/$source_commit}"
    while [[ "$entry" =~ \$\{RELEASE:([a-f0-9]{40})\} ]]; do
      entry="${entry//\$\{RELEASE:${BASH_REMATCH[1]}\}/$deploy_root/releases/${BASH_REMATCH[1]}}"
    done
    printf '%s\n' "$entry"
  done | sort
}

declare -A expected_release_for=()
declare -A runtime_checked_release=()
runtime_expectations=0
for key in "${!dep[@]}"; do
  [[ "$key" == CONTAINER_RELEASE_* || "$key" == CONTAINER_ARGS_* \
    || "$key" == CONTAINER_MOUNTS_* || "$key" == SYSTEMD_UNIT_* ]] && runtime_expectations=1
done

if (( runtime_expectations )) && ! command -v python3 >/dev/null 2>&1; then
  mark_drift "python3 unavailable; cannot check container runtime configuration"
elif (( runtime_expectations )); then
  compose_project="${dep[COMPOSE_PROJECT]:-}"

  # Compose provenance: which release's compose.yaml created each container.
  for key in "${!dep[@]}"; do
    [[ "$key" == CONTAINER_RELEASE_* ]] || continue
    record="${dep[$key]}"
    name="${record%%=*}"
    release_ref="${record#*=}"
    if [[ ! "$name" =~ ^[A-Za-z0-9_.-]+$ || ! "$release_ref" =~ ^(self|[a-f0-9]{40})$ ]]; then
      mark_drift "$key is malformed"
      continue
    fi
    expected_release_for["$name"]="$release_ref"
    expected_dir="$(readlink -m "$(release_path_for "$release_ref")")"
    if ! view="$(container_runtime_view "$name")"; then
      mark_drift "container $name (expected from release $release_ref) does not exist"
      continue
    fi
    project_label="$(awk -F'\t' '$1 == "label" && $2 == "com.docker.compose.project" { print $3 }' <<< "$view")"
    workdir_label="$(awk -F'\t' '$1 == "label" && $2 == "com.docker.compose.project.working_dir" { print $3 }' <<< "$view")"
    files_label="$(awk -F'\t' '$1 == "label" && $2 == "com.docker.compose.project.config_files" { print $3 }' <<< "$view")"
    if [[ -n "$compose_project" && "$project_label" != "$compose_project" ]]; then
      mark_drift "container $name belongs to Compose project '${project_label:-none}', expected '$compose_project'"
    fi
    if [[ "$(readlink -m "${workdir_label:-/nonexistent}")" != "$expected_dir" ]]; then
      mark_drift "container $name was created from ${workdir_label:-an unknown directory}, expected release $release_ref ($expected_dir)"
    fi
    if [[ "$files_label" != "$expected_dir/compose.yaml" ]]; then
      mark_drift "container $name was created with Compose files '${files_label:-none}', expected only $expected_dir/compose.yaml"
    else
      note "running: $name created from release $release_ref compose.yaml only"
    fi
    # A retained release still serves files to a running container, so it must
    # exist and stay intact even though current points elsewhere.
    if [[ "$release_ref" != self && "$release_ref" != "$source_commit" \
      && -z "${runtime_checked_release[$release_ref]+x}" ]]; then
      runtime_checked_release["$release_ref"]=1
      retained_dir="$deploy_root/releases/$release_ref"
      if [[ ! -f "$retained_dir/SHA256SUMS" ]]; then
        mark_drift "retained release $release_ref (used by $name) is missing or has no SHA256SUMS"
      elif (cd "$retained_dir" && sha256sum --check --quiet SHA256SUMS >/dev/null 2>&1) \
        && [[ "$(sed 's/^[a-f0-9]\{64\}  //' "$retained_dir/SHA256SUMS" | sort)" \
          == "$(cd "$retained_dir" && find . -type f ! -path './SHA256SUMS' -print | sort)" ]]; then
        note "release: retained $release_ref checksums OK (used by $name)"
      else
        mark_drift "retained release $release_ref (used by $name) fails its checksums"
      fi
    fi
  done

  # Every container in the project needs an explicit expectation.
  # A failed listing is drift, never an empty project.
  if [[ -n "$compose_project" ]]; then
    if ! project_containers="$(docker ps -a --filter "label=com.docker.compose.project=$compose_project" --format '{{.Names}}' 2>/dev/null)"; then
      mark_drift "cannot list containers in Compose project $compose_project (docker ps failed)"
    else
      while IFS= read -r project_container; do
        [[ -z "$project_container" ]] && continue
        if [[ -z "${expected_release_for[$project_container]+x}" ]]; then
          mark_drift "container $project_container in Compose project $compose_project has no recorded release expectation"
        fi
      done <<< "$project_containers"
    fi
  fi

  # Exact container arguments.
  for key in "${!dep[@]}"; do
    [[ "$key" == CONTAINER_ARGS_* ]] || continue
    record="${dep[$key]}"
    name="${record%%=*}"
    expected_args="${record#*=}"
    if ! view="$(container_runtime_view "$name")"; then
      mark_drift "container $name (args expectation) does not exist"
      continue
    fi
    actual_args="$(awk -F'\t' '$1 == "args" { print $2 }' <<< "$view")"
    if [[ "$actual_args" == "$expected_args" ]]; then
      note "running: $name args match"
    else
      mark_drift "container $name args $actual_args differ from expected $expected_args"
    fi
  done

  # Exact mounts.
  for key in "${!dep[@]}"; do
    [[ "$key" == CONTAINER_MOUNTS_* ]] || continue
    record="${dep[$key]}"
    name="${record%%=*}"
    if ! view="$(container_runtime_view "$name")"; then
      mark_drift "container $name (mounts expectation) does not exist"
      continue
    fi
    expected_mounts="$(expand_mount_spec "${record#*=}")"
    actual_mounts="$(awk -F'\t' '$1 == "mount" { print $2 }' <<< "$view" | sort)"
    if [[ "$actual_mounts" == "$expected_mounts" ]]; then
      note "running: $name mounts match"
    else
      mark_drift "container $name mounts [$(tr '\n' ';' <<< "$actual_mounts")] differ from expected [$(tr '\n' ';' <<< "$expected_mounts")]"
    fi
  done

  # systemd units: no drop-ins and no Compose environment overrides.
  for key in "${!dep[@]}"; do
    [[ "$key" == SYSTEMD_UNIT_* ]] || continue
    unit="${dep[$key]}"
    if [[ ! "$unit" =~ ^[A-Za-z0-9@._-]+\.service$ ]]; then
      mark_drift "$key is malformed"
      continue
    fi
    if ! command -v systemctl >/dev/null 2>&1; then
      mark_drift "systemctl unavailable; cannot inspect $unit"
      continue
    fi
    # Any failed inspection is drift, never "no drop-ins". systemctl show
    # succeeds with empty values for a unit that does not exist, so the unit
    # must also be loaded.
    if ! load_state="$(systemctl show -p LoadState --value "$unit" 2>/dev/null)"; then
      mark_drift "cannot inspect systemd unit $unit (systemctl show LoadState failed)"
      continue
    fi
    if [[ "$load_state" != loaded ]]; then
      mark_drift "systemd unit $unit is ${load_state:-in an unknown state}, expected loaded"
      continue
    fi
    if ! dropins="$(systemctl show -p DropInPaths --value "$unit" 2>/dev/null)"; then
      mark_drift "cannot read drop-ins of systemd unit $unit (systemctl show DropInPaths failed)"
      continue
    fi
    if ! environment="$(systemctl show -p Environment --value "$unit" 2>/dev/null)"; then
      mark_drift "cannot read environment of systemd unit $unit (systemctl show Environment failed)"
      continue
    fi
    unit_ok=1
    if [[ -n "${dropins//[[:space:]]/}" ]]; then
      mark_drift "systemd unit $unit has drop-ins: $dropins"
      unit_ok=0
    fi
    if grep -Eq '(^|[[:space:]])COMPOSE_(FILE|PROJECT_NAME|PROFILES)=' <<< "$environment"; then
      mark_drift "systemd unit $unit sets a Compose override in its environment"
      unit_ok=0
    fi
    (( unit_ok )) && note "systemd: $unit has no drop-ins or Compose overrides"
  done
fi

# --- host runtime executable integrity --------------------------------------

# Some semantically load-bearing executables are intentionally host-managed
# rather than copied into a role release (for example bun and the custom Caddy
# build). A root-owned sha256sum manifest makes that boundary explicit and
# detects replacement without pretending the whole base OS is immutable.
runtime_sums="$deploy_root/config/RUNTIME_SHA256SUMS"
if [[ -f "$runtime_sums" ]]; then
  runtime_count="$(grep -Ec '^[a-f0-9]{64}  /' "$runtime_sums" || true)"
  if [[ "$runtime_count" -eq 0 ]]; then
    mark_drift "runtime executable manifest is empty or malformed"
  elif sha256sum --check --quiet "$runtime_sums" >/dev/null 2>&1; then
    note "runtime: $runtime_count host executables checksums OK"
  else
    mark_drift "host runtime executable checksum mismatch"
  fi
else
  note "runtime: no host executable manifest declared"
fi

# --- installed host file integrity ------------------------------------------

# Role-owned files copied or generated outside the release (for example a
# systemd fragment or /etc/caddy/caddy.json) are distinct from executables in
# RUNTIME_SHA256SUMS. The install step records their absolute paths here.
installed_sums="$deploy_root/config/INSTALLED_SHA256SUMS"
if [[ -f "$installed_sums" ]]; then
  installed_count="$(grep -Ec '^[a-f0-9]{64}  /' "$installed_sums" || true)"
  if [[ "$installed_count" -eq 0 ]]; then
    mark_drift "installed file manifest is empty or malformed"
  elif sha256sum --check --quiet "$installed_sums" >/dev/null 2>&1; then
    note "installed: $installed_count host files checksums OK"
  else
    mark_drift "installed host file checksum mismatch"
  fi
else
  note "installed: no host file manifest declared"
fi

# --- configuration hash ------------------------------------------------------

actual_config_hash="$(config_hash)"
recorded_config_hash=""
[[ -f "$deploy_root/config/CONFIG_SHA256" ]] && recorded_config_hash="$(< "$deploy_root/config/CONFIG_SHA256")"
if [[ -n "$actual_config_hash" ]]; then
  if [[ -z "$recorded_config_hash" ]]; then
    mark_drift "config hash not recorded (run: deployment-status.sh --record-config)"
  elif [[ "$actual_config_hash" == "$recorded_config_hash" ]]; then
    note "config:  hash OK"
  else
    mark_drift "config hash changed since last --record-config"
  fi
else
  note "config:  no config directory"
fi

# --- data state (report only, never drift) -----------------------------------

db_path="${dep[DB_PATH]:-}"
if [[ -n "$db_path" && -e "$deploy_root/$db_path" ]]; then
  db_abs="$deploy_root/$db_path"
  db_mtime="$(date -u -r "$db_abs" +%Y-%m-%dT%H:%M:%SZ)"
  zone_count="n/a"
  if command -v sqlite3 >/dev/null 2>&1; then
    zone_count="$(sqlite3 "file:$db_abs?mode=ro" 'SELECT COUNT(*) FROM domains;' 2>/dev/null || echo "n/a")"
  fi
  note "db:      $db_path mtime $db_mtime  zones: $zone_count"
fi

# --- verdict -----------------------------------------------------------------

if [[ ${#drift[@]} -eq 0 ]]; then
  note "drift:   none"
  exit 0
fi

for d in "${drift[@]}"; do
  note "drift:   $d"
done
[[ "$mode" == "verify" ]] && exit 1
exit 0
