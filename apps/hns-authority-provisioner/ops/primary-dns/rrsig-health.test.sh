#!/usr/bin/env bash
set -euo pipefail

role_dir="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fail() { echo "FAIL: $1" >&2; exit 1; }

cat > "$work/dig" <<'EOF'
#!/usr/bin/env bash
if [[ "${DIG_MODE:-healthy}" == "rollover" ]]; then
  printf 'app.pirate. 300 IN RRSIG A 13 2 300 %s 20260701000000 12345 pirate. signature\n' "$DIG_FIXTURE_EXPIRATION"
elif [[ "${DIG_MODE:-healthy}" == "missing" ]]; then
  printf 'app.pirate. 300 IN A 94.103.168.161\n'
elif [[ "${DIG_MODE:-healthy}" == "expiring" ]]; then
  printf 'app.pirate. 300 IN RRSIG A 13 2 300 20260720000000 20260701000000 12345 pirate. signature\n'
else
  printf 'app.pirate. 300 IN RRSIG A 13 2 300 20260820000000 20260701000000 12345 pirate. signature\n'
fi
EOF
chmod +x "$work/dig"

common=(
  HNS_RRSIG_SERVERS=192.0.2.1
  HNS_RRSIG_CHECKS=app.pirate.:A
  HNS_RRSIG_MIN_REMAINING_SECONDS=604800
  HNS_RRSIG_NOW_EPOCH=1784419200
  HNS_RRSIG_DIG_BIN="$work/dig"
)

env "${common[@]}" bash "$role_dir/bin/check-rrsig-expiry.sh" >/dev/null \
  || fail "healthy signature failed"
if env "${common[@]}" DIG_MODE=missing bash "$role_dir/bin/check-rrsig-expiry.sh" >/dev/null 2>&1; then
  fail "missing RRSIG passed"
fi
if env "${common[@]}" DIG_MODE=expiring bash "$role_dir/bin/check-rrsig-expiry.sh" >/dev/null 2>&1; then
  fail "expiring RRSIG passed"
fi

grep -Fq 'OnFailure=pirate-hns-rrsig-health-alert.service' \
  "$role_dir/systemd/pirate-hns-rrsig-health.service" || fail "health unit lacks alert hook"
grep -Fq 'Environment=DEPLOY_ROOT=/srv/pirate-hns-authdns' \
  "$role_dir/systemd/pirate-hns-rrsig-health.service" || fail "health unit lacks deploy root"
grep -Fq 'OnUnitActiveSec=1h' "$role_dir/systemd/pirate-hns-rrsig-health.timer" \
  || fail "health timer is not hourly"
grep -Fq 'alert-on-failure.sh' "$role_dir/systemd/pirate-hns-rrsig-health-alert.service" \
  || fail "alert unit does not use authenticated alert path"

# Immediately after the weekly rollover, the secondary may hold a signature
# with just under seven days remaining. The owned six-day default accepts that
# normal lag but still refuses a signature already below six days.
for remaining in 604799 518399; do
  expiration="$(date -u -d "@$((1784419200 + remaining))" +%Y%m%d%H%M%S)"
  if env -u HNS_RRSIG_MIN_REMAINING_SECONDS \
    HNS_RRSIG_SERVERS=192.0.2.1 HNS_RRSIG_CHECKS=app.pirate.:A \
    HNS_RRSIG_NOW_EPOCH=1784419200 HNS_RRSIG_DIG_BIN="$work/dig" \
    DIG_MODE=rollover DIG_FIXTURE_EXPIRATION="$expiration" \
    bash "$role_dir/bin/check-rrsig-expiry.sh" >/dev/null 2>&1; then
    [[ "$remaining" -eq 604799 ]] || fail "under-six-day signature was accepted"
  else
    [[ "$remaining" -eq 518399 ]] || fail "normal weekly rollover lag falsely alarmed"
  fi
done
# Invalid normalized lists must refuse before DNS or certificate work.
cat > "$work/no-work" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' called >> "$ZERO_WORK_LOG"
exit 99
EOF
chmod +x "$work/no-work"
for setting in HNS_RRSIG_SERVERS HNS_RRSIG_CHECKS; do
  for value in '' ',' ' , , ' $'\n ,\t,\r\n'; do
    : > "$work/calls"
    if env "${common[@]}" HNS_RRSIG_DIG_BIN="$work/no-work" \
      ZERO_WORK_LOG="$work/calls" "$setting=$value" \
      bash "$role_dir/bin/check-rrsig-expiry.sh" >/dev/null 2>&1; then
      fail "$setting accepted an empty normalized list"
    else
      result=$?
      [[ "$result" -eq 2 ]] || fail "$setting did not refuse during configuration validation"
    fi
    [[ ! -s "$work/calls" ]] || fail "$setting performed work before refusing"
  done
done

echo "RRSIG health checks passed"
