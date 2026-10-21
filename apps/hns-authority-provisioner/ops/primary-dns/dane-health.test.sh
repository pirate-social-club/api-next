#!/usr/bin/env bash
set -euo pipefail

role_dir="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
fail() { echo "FAIL: $1" >&2; exit 1; }
digest=5c8ddd3dbf63dbab698c726708b06177adda4a21416c675197f97e3b27ab20d8

cat > "$work/probe" <<EOF
#!/usr/bin/env bash
printf '%s\n' '$digest'
EOF
cat > "$work/dig" <<EOF
#!/usr/bin/env bash
if [[ "\${DIG_MODE:-healthy}" == mismatch ]]; then
  printf '%s\n' '_443._tcp.app.pirate. 300 IN TLSA 3 1 1 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
elif [[ "\${DIG_MODE:-healthy}" == missing ]]; then
  exit 0
elif [[ "\${DIG_MODE:-healthy}" == wrapped ]]; then
  printf '%s\n' '_443._tcp.app.pirate. 300 IN TLSA 3 1 1 5c8ddd3dbf63dbab698c72670 8b06177adda4a21416c675197f97e3b 27ab20d8'
else
  printf '%s\n' '_443._tcp.app.pirate. 300 IN TLSA 3 1 1 $digest'
fi
EOF
chmod +x "$work/probe" "$work/dig"

common=(
  HNS_DANE_PROBE_ADDRESS=192.0.2.1
  HNS_DANE_PROBE_HOST=app.pirate
  HNS_DANE_SERVERS=192.0.2.53
  HNS_DANE_TLSA_OWNERS=_443._tcp.app.pirate.
  HNS_DANE_SPKI_PROBE_BIN="$work/probe"
  HNS_DANE_DIG_BIN="$work/dig"
)

env "${common[@]}" bash "$role_dir/bin/check-dane-spki.sh" >/dev/null \
  || fail "matching SPKI failed"
env "${common[@]}" DIG_MODE=wrapped bash "$role_dir/bin/check-dane-spki.sh" >/dev/null \
  || fail "wrapped TLSA digest failed"
if env "${common[@]}" DIG_MODE=mismatch bash "$role_dir/bin/check-dane-spki.sh" >/dev/null 2>&1; then
  fail "mismatched SPKI passed"
fi
if env "${common[@]}" DIG_MODE=missing bash "$role_dir/bin/check-dane-spki.sh" >/dev/null 2>&1; then
  fail "missing TLSA passed"
fi

grep -Fq 'OnFailure=pirate-hns-dane-health-alert.service' \
  "$role_dir/systemd/pirate-hns-dane-health.service" || fail "health unit lacks alert hook"
grep -Fq 'OnUnitActiveSec=1h' "$role_dir/systemd/pirate-hns-dane-health.timer" \
  || fail "health timer is not hourly"
grep -Fq 'alert-on-failure.sh' "$role_dir/systemd/pirate-hns-dane-health-alert.service" \
  || fail "alert unit does not use authenticated alert path"
for check in dane rrsig; do
  for suffix in '' '-alert'; do
    grep -Fxq "EnvironmentFile=/srv/pirate-hns-authdns/config/$check-health.env" \
      "$role_dir/systemd/pirate-hns-$check-health$suffix.service" \
      || fail "$check success and failure must use the same dedicated credential environment"
  done
  grep -Fq 'ExecStartPost=' "$role_dir/systemd/pirate-hns-$check-health.service" \
    || fail "$check health unit lacks success delivery"
  grep -Fxq "HNS_HEALTHCHECK_URL_FILE=/etc/pirate-healthchecks/hns-$check.url" \
    "$role_dir/env/$check-health.env.example" \
    || fail "$check environment lacks its separate private ping URL file"
done

# Invalid normalized lists must refuse before DNS or certificate work.
cat > "$work/no-work" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' called >> "$ZERO_WORK_LOG"
exit 99
EOF
chmod +x "$work/no-work"
for setting in HNS_DANE_SERVERS HNS_DANE_TLSA_OWNERS; do
  for value in '' ',' ' , , ' $'\n ,\t,\r\n'; do
    : > "$work/calls"
    if env "${common[@]}" HNS_DANE_SPKI_PROBE_BIN="$work/no-work" HNS_DANE_DIG_BIN="$work/no-work" \
      ZERO_WORK_LOG="$work/calls" "$setting=$value" \
      bash "$role_dir/bin/check-dane-spki.sh" >/dev/null 2>&1; then
      fail "$setting accepted an empty normalized list"
    else
      result=$?
      [[ "$result" -eq 2 ]] || fail "$setting did not refuse during configuration validation"
    fi
    [[ ! -s "$work/calls" ]] || fail "$setting performed work before refusing"
  done
done

echo "DANE SPKI health checks passed"
