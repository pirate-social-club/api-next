#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
fail() { echo "FAIL: $1" >&2; exit 1; }
service="$here/systemd/pirate-hns-doh-health.service"
alert="$here/systemd/pirate-hns-doh-health-alert.service"
for unit in "$service" "$alert"; do
  grep -Fxq 'EnvironmentFile=/srv/pirate-hns-doh/config/doh-health.env' "$unit" \
    || fail "DoH health success/failure must use the same dedicated environment"
done
grep -Fxq 'HNS_HEALTHCHECK_URL_FILE=/etc/pirate-healthchecks/hns-doh-health.url' \
  "$here/env/doh-health.env.example" || fail "DoH health shares an unrelated task URL"
grep -Fxq 'OnUnitActiveSec=15m' "$here/systemd/pirate-hns-doh-health.timer" \
  || fail "DoH health must retain its fifteen-minute cadence"
grep -Fxq 'RandomizedDelaySec=2m' "$here/systemd/pirate-hns-doh-health.timer" \
  || fail "DoH health jitter differs from its hosted grace budget"
grep -Fxq 'TimeoutStartSec=120' "$service" || fail "DoH probe lacks its execution bound"

# Exercise the declared commands with an unavailable resolver-manager stub.
# Skipping the probe with exit0 must never reset the external health deadline.
command_for() {
  sed -n "s/^$1=\/bin\/bash -c '\(.*\)'$/\1/p" "$2"
}
probe="$(command_for ExecStart "$service")"
success="$(command_for ExecStartPost "$service")"
failure="$(command_for ExecStart "$alert")"
[[ -n "$probe" && -n "$success" && -n "$failure" ]] || fail "unit commands missing"
mkdir -p "$work/current/bin" "$work/fake-bin"
cat > "$work/current/bin/check-doh-health.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo probe >> "$DOH_FIXTURE_EVENTS"
exit "$DOH_FIXTURE_EXIT"
EOF
cat > "$work/current/bin/heartbeat.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo success >> "$DOH_FIXTURE_EVENTS"
EOF
cat > "$work/current/bin/alert-on-failure.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo failure >> "$DOH_FIXTURE_EVENTS"
EOF
cat > "$work/fake-bin/systemctl" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod +x "$work/current/bin/"*.sh "$work/fake-bin/systemctl"
export DEPLOY_ROOT="$work" PATH="$work/fake-bin:$PATH"
for result in 0 1; do
  export DOH_FIXTURE_EXIT="$result" DOH_FIXTURE_EVENTS="$work/events-$result"
  if bash -c "$probe"; then
    bash -c "$success"
  else
    bash -c "$failure"
  fi
  expected=$'probe\nsuccess'
  [[ "$result" == 0 ]] || expected=$'probe\nfailure'
  [[ "$(cat "$DOH_FIXTURE_EVENTS")" == "$expected" ]] \
    || fail "DoH health signalled without the matching completed probe"
done
echo "DoH health has an independent check and requires actual probe completion"
python3 "$here/dns-wire-health.test.py"
