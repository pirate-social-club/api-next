#!/usr/bin/env bash
set -euo pipefail
umask 077

# Query the public HTTPS path. This proves expected A-record continuity, not
# independent DNSSEC validation or hnsd consensus. Keep those separate gates.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
endpoint="${HNS_DOH_ENDPOINT:-}"
probe_name="${HNS_DOH_PROBE_NAME:-app.pirate}"
expected_ipv4="${HNS_DOH_EXPECTED_IPV4:-}"
timeout_seconds="${HNS_DOH_TIMEOUT_SECONDS:-15}"
attempts="${HNS_DOH_ATTEMPTS:-3}"
base_delay="${HNS_DOH_BASE_DELAY_SECONDS:-2}"

if [[ "$endpoint" != https://* || "$endpoint" == *$'\n'* || "$endpoint" == *$'\r'* || "$endpoint" == *'?'* || "$endpoint" == *'#'* ]]; then
  echo "HNS_DOH_ENDPOINT must be an HTTPS URL without a query or fragment" >&2
  exit 2
fi
for value in "$timeout_seconds" "$attempts" "$base_delay"; do
  [[ "$value" =~ ^[0-9]{1,2}$ ]] || { echo "invalid DoH retry budget" >&2; exit 2; }
done
timeout_seconds=$((10#$timeout_seconds))
attempts=$((10#$attempts))
base_delay=$((10#$base_delay))
if (( timeout_seconds < 1 || attempts < 1 || attempts > 5 ||
      timeout_seconds * attempts + base_delay * attempts * (attempts - 1) / 2 > 110 )); then
  echo "DoH retry budget must fit within 110 seconds" >&2
  exit 2
fi

# Configuration is validated before any request. No expected address is
# inferred from an old example or a DNS response supplied by the probe itself.
encoded="$(python3 "$here/dns-wire-health.py" query --name "$probe_name" --expected-ipv4 "$expected_ipv4")"
stderr_file="$(mktemp)"
trap 'rm -f -- "$stderr_file"' EXIT

last_error=""
for (( attempt=1; attempt<=attempts; attempt++ )); do
  # The validator bounds its stdin before parsing. curl bounds total request
  # time; pipefail refuses transport failure even if valid bytes arrived first.
  # The final two metadata lines come from curl, not the DNS response body.
  if detail="$( {
    curl --disable --silent --show-error --fail --max-time "$timeout_seconds" \
      --header 'accept: application/dns-message' \
      --write-out $'\n%{http_code}\n%{content_type}\n' \
      --url "${endpoint}?dns=${encoded}" \
      | python3 "$here/dns-wire-health.py" check --name "$probe_name" --expected-ipv4 "$expected_ipv4"
  } 2>"$stderr_file")"; then
    printf 'ok: %s resolved %s: %s\n' "$endpoint" "$probe_name" "$detail"
    exit 0
  fi
  last_error="$(tr '\n' ' ' < "$stderr_file")"
  (( attempt >= attempts )) || sleep "$(( base_delay * attempt ))"
done
printf 'DoH health failure: %s could not resolve %s after %d attempts; last: %s\n' \
  "$endpoint" "$probe_name" "$attempts" "$last_error" >&2
exit 1
