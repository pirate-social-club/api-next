#!/usr/bin/env bash
set -euo pipefail

umask 077

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "missing required environment variable: $name" >&2
    exit 1
  fi
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "required command not found: $1" >&2
    exit 1
  fi
}

require_absolute_path() {
  local name="$1"
  local value="${!name:-}"
  if [[ "$value" != /* || "$value" == *$'\n'* ]]; then
    echo "$name must be an absolute single-line path" >&2
    exit 1
  fi
}

profile="${HNS_BACKUP_PROFILE:-primary}"
mandatory_directories=(HNS_RUNTIME_STATE_DIR HNS_DANE_CERT_DIR)
archive_directories=(HNS_RUNTIME_STATE_DIR)
case "$profile" in
  primary)
    mandatory_directories=(SPACES_DATA_DIR "${mandatory_directories[@]}")
    archive_directories=(SPACES_DATA_DIR HNS_RUNTIME_STATE_DIR HNS_DANE_CERT_DIR)
    ;;
  staging-hns)
    if [[ -n "${SPACES_DATA_DIR:-}" ]]; then
      echo "staging-hns profile must not declare SPACES_DATA_DIR" >&2
      exit 1
    fi
    ;;
  *) echo "HNS_BACKUP_PROFILE must be primary or staging-hns" >&2; exit 1 ;;
esac

for name in BACKUP_RCLONE_REMOTE BACKUP_AGE_RECIPIENT BACKUP_RETENTION_VERIFY; do
  require_env "$name"
done

case "$BACKUP_RETENTION_VERIFY" in
  true)
    for name in BACKUP_S3_ENDPOINT BACKUP_S3_REGION BACKUP_S3_ACCESS_KEY_ID \
      BACKUP_S3_SECRET_ACCESS_KEY BACKUP_MIN_RETENTION_DAYS; do
      require_env "$name"
    done
    if ! [[ "$BACKUP_MIN_RETENTION_DAYS" =~ ^[0-9]+$ && "$BACKUP_MIN_RETENTION_DAYS" -ge 1 ]]; then
      echo "BACKUP_MIN_RETENTION_DAYS must be a positive integer" >&2
      exit 1
    fi
    ;;
  false)
    # Without verification a misconfigured bucket silently produces deletable
    # backups. Permit opting out, but never quietly.
    echo "WARNING: BACKUP_RETENTION_VERIFY=false — uploaded objects are NOT checked for provider-enforced retention" >&2
    ;;
  *)
    echo "BACKUP_RETENTION_VERIFY must be exactly 'true' or 'false'" >&2
    exit 1
    ;;
esac

for name in BACKUP_STAGING_ROOT PDNS_SQLITE_DB HNS_CADDY_CONFIG_FILE "${mandatory_directories[@]}"; do
  require_absolute_path "$name"
done

for command in age date flock hostname install mktemp rclone sha256sum sqlite3 stat systemctl tar tr; do
  require_command "$command"
done
if [[ "$BACKUP_RETENTION_VERIFY" == "true" ]]; then
  require_command curl
  require_command sed
fi

if [[ ! -f "$PDNS_SQLITE_DB" ]]; then
  echo "PowerDNS SQLite database not found: $PDNS_SQLITE_DB" >&2
  exit 1
fi
if [[ ! -f "$HNS_CADDY_CONFIG_FILE" || ! -s "$HNS_CADDY_CONFIG_FILE" ]]; then
  echo "active Caddy configuration is missing or empty" >&2
  exit 1
fi
for name in "${mandatory_directories[@]}"; do
  if [[ ! -d "${!name}" || -L "${!name}" ]]; then
    echo "mandatory backup input must be an existing non-symlink directory: $name" >&2
    exit 1
  fi
done
if [[ "$profile" == staging-hns ]]; then
  require_command realpath
  require_command find
  runtime_real="$(realpath -e -- "$HNS_RUNTIME_STATE_DIR")"
  tls_real="$(realpath -e -- "$HNS_DANE_CERT_DIR")"
  runtime_device="$(stat -c %d "$runtime_real")"
  if [[ "$tls_real" != "$runtime_real"/* ||
        "$(stat -c %d "$tls_real")" != "$runtime_device" ]]; then
    echo "staging TLS identity must be inside the mandatory runtime directory" >&2
    exit 1
  fi
  unsupported="$(find "$runtime_real" ! -type d ! -type f -print -quit)"
  if [[ -n "$unsupported" ]]; then
    echo "staging runtime must contain only regular files and directories" >&2
    exit 1
  fi
  devices="$(find "$runtime_real" -printf '%D\n')"
  while IFS= read -r device; do
    if [[ "$device" != "$runtime_device" ]]; then
      echo "staging runtime must not contain another filesystem" >&2
      exit 1
    fi
  done <<< "$devices"
fi

mkdir -p "$BACKUP_STAGING_ROOT"
chmod 0700 "$BACKUP_STAGING_ROOT"

exec 9>"$BACKUP_STAGING_ROOT/backup.lock"
if ! flock -n 9; then
  echo "another HNS state backup is already running" >&2
  exit 1
fi

run_dir="$(mktemp -d "$BACKUP_STAGING_ROOT/run.XXXXXXXX")"
declare -a restart_units=()

restart_quiesced_units() {
  local status=0
  local index
  local -a failed_units=()

  for ((index=${#restart_units[@]} - 1; index >= 0; index -= 1)); do
    if ! systemctl start "${restart_units[$index]}"; then
      echo "failed to restart ${restart_units[$index]} after backup" >&2
      failed_units+=("${restart_units[$index]}")
      status=1
    fi
  done

  restart_units=("${failed_units[@]}")
  return "$status"
}

cleanup() {
  local status=$?

  trap - EXIT INT TERM
  if ! restart_quiesced_units; then
    status=1
  fi

  rm -rf -- "$run_dir"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

mkdir -p "$run_dir/powerdns" "$run_dir/caddy"
# Copy the effective bytes, including when the configured path is a release
# symlink. A saved symlink alone would depend on a separately retained release.
install -m 0600 -- "$HNS_CADDY_CONFIG_FILE" "$run_dir/caddy/caddy.json"
sqlite_snapshot="$run_dir/powerdns/pdns.sqlite3"
if [[ "$sqlite_snapshot" == *"'"* ]]; then
  echo "generated SQLite snapshot path is not safely representable" >&2
  exit 1
fi
sqlite3 "$PDNS_SQLITE_DB" ".backup '$sqlite_snapshot'"
if [[ "$(sqlite3 "$sqlite_snapshot" 'PRAGMA integrity_check;')" != "ok" ]]; then
  echo "PowerDNS SQLite snapshot failed integrity_check" >&2
  exit 1
fi

read -r -a requested_units <<< "${BACKUP_QUIESCE_UNITS:-}"
for unit in "${requested_units[@]}"; do
  if systemctl is-active --quiet "$unit"; then
    restart_units+=("$unit")
    systemctl stop "$unit"
  fi
done

declare -a tar_args=(
  --create
  --zstd
  --file -
  --numeric-owner
  --acls
  --xattrs
  --one-file-system
  -C "$run_dir"
  powerdns
  caddy
)

for name in "${archive_directories[@]}"; do
  path="${!name}"
  # Every declared directory is mandatory. If it disappears after preflight,
  # tar must fail rather than turn a partial archive into a success heartbeat.
  tar_args+=(-C / "${path#/}")
done

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
host="$(hostname -s | tr -cd 'A-Za-z0-9._-')"
archive_name="hns-edge-${host:-unknown}-${timestamp}.tar.zst.age"
archive_path="$run_dir/$archive_name"

tar "${tar_args[@]}" | age --recipient "$BACKUP_AGE_RECIPIENT" --output "$archive_path"
if [[ ! -s "$archive_path" ]]; then
  echo "encrypted backup archive is empty" >&2
  exit 1
fi

# The archive is now a consistent point-in-time image. Restore service before
# network upload so the quiescence window does not include provider latency.
restart_quiesced_units

(
  cd "$run_dir"
  sha256sum "$archive_name" > "$archive_name.sha256"
)
remote_base="${BACKUP_RCLONE_REMOTE%/}"
rclone copyto "$archive_path" "$remote_base/$archive_name" --immutable
rclone copyto "$archive_path.sha256" "$remote_base/$archive_name.sha256" --immutable

# `--immutable` only stops rclone overwriting; real immutability is the
# provider's Object Lock. Prove the provider actually applied it to the objects
# just uploaded — a bucket whose default retention was removed or weakened
# after setup must fail the backup run, not silently produce deletable copies.
curl_retention() {
  local sigv4="$1"
  shift
  local credential="$BACKUP_S3_ACCESS_KEY_ID:$BACKUP_S3_SECRET_ACCESS_KEY"
  if [[ "$credential" == *$'\n'* || "$credential" == *$'\r'* ]]; then
    echo "retention credentials must be single-line" >&2
    return 1
  fi
  credential="${credential//\\/\\\\}"
  credential="${credential//\"/\\\"}"
  printf 'user = "%s"\n' "$credential" | curl --config - \
    --fail --silent --show-error --max-time 30 --aws-sigv4 "$sigv4" "$@"
}

verify_object_retention() {
  local object_key="$1"
  local url="${BACKUP_S3_ENDPOINT%/}/$s3_bucket/$object_key"
  local sigv4="aws:amz:$BACKUP_S3_REGION:s3"

  local head_output version_id
  if ! head_output="$(curl_retention "$sigv4" --head "$url")"; then
    echo "retention verification: HEAD failed for $object_key" >&2
    return 1
  fi
  version_id="$(sed -nE 's/^x-amz-version-id:[[:space:]]*([^[:space:]]+).*$/\1/Ip' <<< "$head_output" | head -n 1)"
  if [[ -z "$version_id" ]]; then
    echo "retention verification: no x-amz-version-id on $object_key (bucket not versioned/locked?)" >&2
    return 1
  fi

  local retention_xml mode retain_until retain_epoch minimum_epoch
  if ! retention_xml="$(curl_retention "$sigv4" "$url?retention=&versionId=$version_id")"; then
    echo "retention verification: GetObjectRetention failed for $object_key" >&2
    return 1
  fi
  mode="$(sed -nE 's/.*<Mode>([^<]+)<\/Mode>.*/\1/p' <<< "$retention_xml" | head -n 1)"
  retain_until="$(sed -nE 's/.*<RetainUntilDate>([^<]+)<\/RetainUntilDate>.*/\1/p' <<< "$retention_xml" | head -n 1)"
  if [[ "${mode^^}" != "COMPLIANCE" ]]; then
    echo "retention verification: $object_key mode is '${mode:-absent}', expected COMPLIANCE" >&2
    return 1
  fi
  if ! retain_epoch="$(date -u -d "$retain_until" +%s 2>/dev/null)"; then
    echo "retention verification: unparseable RetainUntilDate '$retain_until' on $object_key" >&2
    return 1
  fi
  # One hour of slack covers upload duration and clock skew.
  minimum_epoch=$(( $(date -u +%s) + BACKUP_MIN_RETENTION_DAYS * 86400 - 3600 ))
  if (( retain_epoch < minimum_epoch )); then
    echo "retention verification: $object_key locked only until $retain_until, weaker than the ${BACKUP_MIN_RETENTION_DAYS}-day policy" >&2
    return 1
  fi
  echo "retention verified: $object_key COMPLIANCE until $retain_until"
}

if [[ "$BACKUP_RETENTION_VERIFY" == "true" ]]; then
  # Derive bucket and key prefix from the rclone remote itself so the two
  # configurations cannot drift apart: rclone remote form is name:bucket[/path].
  remote_path="${remote_base#*:}"
  s3_bucket="${remote_path%%/*}"
  key_prefix="${remote_path#"$s3_bucket"}"
  key_prefix="${key_prefix#/}"
  if [[ -z "$s3_bucket" || "$remote_path" == "$remote_base" ]]; then
    echo "retention verification: cannot derive bucket from BACKUP_RCLONE_REMOTE '$BACKUP_RCLONE_REMOTE'" >&2
    exit 1
  fi
  for object in "$archive_name" "$archive_name.sha256"; do
    verify_object_retention "${key_prefix:+$key_prefix/}$object"
  done
fi

echo "uploaded encrypted HNS edge snapshot: $archive_name ($(stat -c %s "$archive_path") bytes)"
