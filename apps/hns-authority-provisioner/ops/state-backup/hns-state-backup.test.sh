#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf -- "$test_root"' EXIT

fake_bin="$test_root/bin"
remote_dir="$test_root/remote"
mkdir -p "$fake_bin" "$remote_dir" "$test_root/spaces/subsd" \
  "$test_root/runtime" "$test_root/dane"

printf 'spaces-state\n' > "$test_root/spaces/subsd/state"
printf 'runtime-state\n' > "$test_root/runtime/state"
printf 'certificate\n' > "$test_root/dane/cert.pem"
printf '{"apps":{"http":{}}}\n' > "$test_root/caddy-effective.json"
ln -s "$test_root/caddy-effective.json" "$test_root/caddy.json"
sqlite3 "$test_root/pdns.sqlite3" 'CREATE TABLE domains (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO domains (name) VALUES ("pirate");'

cat > "$fake_bin/systemctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  is-active)
    exit 0
    ;;
  stop|start)
    printf '%s %s\n' "$1" "$2" >> "$TEST_EVENT_LOG"
    ;;
  *)
    exit 2
    ;;
esac
EOF

cat > "$fake_bin/age" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
output=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --recipient)
      shift 2
      ;;
    --output)
      output="$2"
      shift 2
      ;;
    *)
      exit 2
      ;;
  esac
done
printf 'age\n' >> "$TEST_EVENT_LOG"
cp /dev/stdin "$output"
EOF

cat > "$fake_bin/rclone" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == "copyto" ]]
source_path="$2"
destination="$3"
printf 'rclone %s\n' "$(basename "$source_path")" >> "$TEST_EVENT_LOG"
cp "$source_path" "$TEST_REMOTE_DIR/$(basename "$destination")"
EOF

chmod +x "$fake_bin/systemctl" "$fake_bin/age" "$fake_bin/rclone"

export PATH="$fake_bin:$PATH"
export TEST_EVENT_LOG="$test_root/events"
export TEST_REMOTE_DIR="$remote_dir"
export BACKUP_RCLONE_REMOTE="test:hns"
export BACKUP_AGE_RECIPIENT="age1testrecipient"
export BACKUP_STAGING_ROOT="$test_root/staging"
export PDNS_SQLITE_DB="$test_root/pdns.sqlite3"
export SPACES_DATA_DIR="$test_root/spaces"
export HNS_RUNTIME_STATE_DIR="$test_root/runtime"
export HNS_DANE_CERT_DIR="$test_root/dane"
export HNS_CADDY_CONFIG_FILE="$test_root/caddy.json"
export BACKUP_QUIESCE_UNITS="subsd.service verifier.service spaced.service"
# This stub-based test has no real S3 endpoint; the integration harness
# (ops/vps/hns-local-test) covers BACKUP_RETENTION_VERIFY=true against MinIO.
export BACKUP_RETENTION_VERIFY=false

# Backblaze's SigV4 canonicalization requires the empty GetObjectRetention
# parameter to be explicit. `?retention&...` signs differently and fails with
# SignatureDoesNotMatch even when the uploader has readFileRetentions.
grep -Fq '"$url?retention=&versionId=$version_id"' "$here/hns-state-backup.sh"
grep -Fq 'ExecStartPost=/srv/pirate-hns/current/bin/heartbeat.sh' \
  "$here/systemd/pirate-hns-state-backup.service"

if ! "$here/hns-state-backup.sh" 2> "$test_root/stderr"; then
  cat "$test_root/stderr" >&2
  exit 1
fi
if ! grep -q "retention verification" "$test_root/stderr" && ! grep -q "BACKUP_RETENTION_VERIFY=false" "$test_root/stderr"; then
  echo "expected a loud warning when retention verification is disabled" >&2
  exit 1
fi

expected_events=$'stop subsd.service\nstop verifier.service\nstop spaced.service\nage\nstart spaced.service\nstart verifier.service\nstart subsd.service'
actual_before_upload="$(sed '/^rclone /d' "$TEST_EVENT_LOG")"
if [[ "$actual_before_upload" != "$expected_events" ]]; then
  echo "unexpected quiesce/restart order" >&2
  diff -u <(printf '%s\n' "$expected_events") <(printf '%s\n' "$actual_before_upload") || true
  exit 1
fi

archive="$(find "$remote_dir" -maxdepth 1 -name '*.tar.zst.age' -print -quit)"
checksum="$archive.sha256"
[[ -s "$archive" && -s "$checksum" ]]

(
  cd "$remote_dir"
  sha256sum --check "$(basename "$checksum")"
)

# A single captured listing avoids grep -q racing tar into SIGPIPE under
# pipefail.
archive_listing="$(tar --zstd --list --file "$archive")"
grep -Fxq 'powerdns/pdns.sqlite3' <<< "$archive_listing"
grep -Fq "${SPACES_DATA_DIR#/}/subsd/state" <<< "$archive_listing"
grep -Fq "${HNS_RUNTIME_STATE_DIR#/}/state" <<< "$archive_listing"
grep -Fq "${HNS_DANE_CERT_DIR#/}/cert.pem" <<< "$archive_listing"
tar --zstd --extract --to-stdout --file "$archive" caddy/caddy.json \
  > "$test_root/restored-caddy.json"
cmp "$test_root/caddy-effective.json" "$test_root/restored-caddy.json"

if find "$BACKUP_STAGING_ROOT" -mindepth 1 -maxdepth 1 -type d | grep -q .; then
  echo "backup staging run directory was not cleaned" >&2
  exit 1
fi

echo "hns-state-backup test passed"

# Exercise the actual retention path and observe argv and stdin separately.
cat > "$fake_bin/curl" <<'PY'
#!/usr/bin/python3
import datetime
import json
import os
import shlex
import sys
arguments = sys.argv[1:]
private = os.environ['BACKUP_S3_ACCESS_KEY_ID'] + ':' + os.environ['BACKUP_S3_SECRET_ACCESS_KEY']
assert '--config' in arguments and arguments[arguments.index('--config') + 1] == '-'
assert '--user' not in arguments and all(private not in argument for argument in arguments)
assert all(os.environ['BACKUP_S3_SECRET_ACCESS_KEY'] not in argument for argument in arguments)
assert shlex.split(sys.stdin.read()) == ['user', '=', private]
with open(os.environ['TEST_RETENTION_CALLS'], 'a') as handle:
    handle.write(json.dumps({'secret_absent_from_argv': True, 'stdin_auth_matched': True}) + '\n')
if '--head' in arguments:
    print('HTTP/1.1 200 OK\r\nx-amz-version-id: fixture-version\r\n')
else:
    until = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=35)).isoformat()
    print('<ObjectLockRetention><Mode>COMPLIANCE</Mode><RetainUntilDate>' + until + '</RetainUntilDate></ObjectLockRetention>')
PY
chmod +x "$fake_bin/curl"
export BACKUP_RETENTION_VERIFY=true
export BACKUP_S3_ENDPOINT=https://storage.invalid.example
export BACKUP_S3_REGION=fixture-region
export BACKUP_S3_ACCESS_KEY_ID=fixture-access
export BACKUP_S3_SECRET_ACCESS_KEY='fixture-secret-quote"-slash\-suffix'
export BACKUP_MIN_RETENTION_DAYS=30
export TEST_RETENTION_CALLS="$test_root/retention-calls"
mkdir "$test_root/remote-retention"
export TEST_REMOTE_DIR="$test_root/remote-retention"
"$here/hns-state-backup.sh" >/dev/null
[[ "$(wc -l < "$TEST_RETENTION_CALLS")" -eq 4 ]]
echo "retention readback keeps escaped credentials in stdin, absent from argv"

# Missing routing configuration must refuse before stopping writers or uploading.
before_events="$(cat "$TEST_EVENT_LOG")"
export HNS_CADDY_CONFIG_FILE="$test_root/not-present.json"
if "$here/hns-state-backup.sh" > /dev/null 2> "$test_root/missing-caddy.stderr"; then
  echo "backup accepted a missing active Caddy configuration" >&2
  exit 1
fi
[[ "$(cat "$TEST_EVENT_LOG")" == "$before_events" ]]
grep -Fq 'active Caddy configuration is missing or empty' "$test_root/missing-caddy.stderr"

# Every declared directory must refuse before quiescence, encryption, upload
# and retention readback, including a regular file in place of a directory.
export HNS_CADDY_CONFIG_FILE="$test_root/caddy.json"
before_retention="$(cat "$TEST_RETENTION_CALLS")"
before_remote="$(find "$TEST_REMOTE_DIR" -type f -printf '%f\n' | sort)"
for name in SPACES_DATA_DIR HNS_RUNTIME_STATE_DIR HNS_DANE_CERT_DIR; do
  original="${!name}"
  for kind in absent file symlink; do
    invalid="$test_root/invalid-$name-$kind"
    [[ "$kind" != file ]] || printf 'not a directory\n' > "$invalid"
    [[ "$kind" != symlink ]] || ln -s "$original" "$invalid"
    export "$name=$invalid"
    if "$here/hns-state-backup.sh" > /dev/null 2> "$test_root/missing-directory.stderr"; then
      echo "backup accepted invalid mandatory directory: $name ($kind)" >&2
      exit 1
    fi
    grep -Fxq "mandatory backup input must be an existing non-symlink directory: $name" \
      "$test_root/missing-directory.stderr"
    [[ "$(cat "$TEST_EVENT_LOG")" == "$before_events" ]]
    [[ "$(cat "$TEST_RETENTION_CALLS")" == "$before_retention" ]]
    [[ "$(find "$TEST_REMOTE_DIR" -type f -printf '%f\n' | sort)" == "$before_remote" ]]
  done
  export "$name=$original"
done
echo "missing mandatory sources refuse before quiescence or provider calls"
