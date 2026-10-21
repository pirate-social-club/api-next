#!/usr/bin/env bash
set -euo pipefail

# Verify DNSSEC signatures through each configured authoritative serving path.
# Every configured name/type must return a matching RRSIG whose earliest
# expiration remains above the threshold. This deliberately queries DNS, not
# the PowerDNS database, so a stalled signer or broken serving path alerts.

servers_csv="${HNS_RRSIG_SERVERS:-}"
checks_csv="${HNS_RRSIG_CHECKS:-}"
minimum_seconds="${HNS_RRSIG_MIN_REMAINING_SECONDS:-518400}"
dig_bin="${HNS_RRSIG_DIG_BIN:-dig}"

# shellcheck source=lib/dig-retry.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/dig-retry.sh"
now_epoch="${HNS_RRSIG_NOW_EPOCH:-$(date -u +%s)}"

servers_csv="${servers_csv//[[:space:]]/}"
checks_csv="${checks_csv//[[:space:]]/}"
[[ -n "${servers_csv//,/}" ]] || { echo "HNS_RRSIG_SERVERS must contain a server" >&2; exit 2; }
[[ -n "${checks_csv//,/}" ]] || { echo "HNS_RRSIG_CHECKS must contain a check" >&2; exit 2; }
[[ "$minimum_seconds" =~ ^[0-9]+$ ]] || { echo "invalid RRSIG threshold" >&2; exit 2; }
[[ "$now_epoch" =~ ^[0-9]+$ ]] || { echo "invalid current epoch" >&2; exit 2; }

IFS=',' read -r -a servers <<< "$servers_csv"
IFS=',' read -r -a checks <<< "$checks_csv"

failures=()
for raw_server in "${servers[@]}"; do
  server="${raw_server//[[:space:]]/}"
  [[ -n "$server" ]] || continue
  for raw_check in "${checks[@]}"; do
    check="${raw_check//[[:space:]]/}"
    [[ "$check" == *:* ]] || { failures+=("invalid check '$check'"); continue; }
    name="${check%:*}"
    type="${check##*:}"
    [[ -n "$name" && -n "$type" ]] || { failures+=("invalid check '$check'"); continue; }

    if ! dig_with_retry answer "$dig_bin" +time=5 +tries=1 +dnssec +noall +answer "@$server" "$name" "$type"; then
      failures+=("$server $name $type query $answer")
      continue
    fi
    expirations="$(awk -v covered="$type" '$4 == "RRSIG" && toupper($5) == toupper(covered) { print $9 }' <<< "$answer")"
    if [[ -z "$expirations" ]]; then
      failures+=("$server $name $type has no matching RRSIG")
      continue
    fi

    earliest=""
    while IFS= read -r expiration; do
      [[ "$expiration" =~ ^[0-9]{14}$ ]] || { failures+=("$server $name $type has invalid RRSIG expiry '$expiration'"); continue; }
      expiration_epoch="$(date -u -d "${expiration:0:8} ${expiration:8:2}:${expiration:10:2}:${expiration:12:2}" +%s 2>/dev/null || true)"
      [[ -n "$expiration_epoch" ]] || { failures+=("$server $name $type expiry cannot be parsed"); continue; }
      if [[ -z "$earliest" || "$expiration_epoch" -lt "$earliest" ]]; then
        earliest="$expiration_epoch"
      fi
    done <<< "$expirations"

    if [[ -n "$earliest" ]]; then
      remaining=$((earliest - now_epoch))
      if (( remaining < minimum_seconds )); then
        failures+=("$server $name $type RRSIG expires in ${remaining}s (minimum ${minimum_seconds}s)")
      else
        printf 'ok: %s %s %s RRSIG remaining=%ss\n' "$server" "$name" "$type" "$remaining"
      fi
    fi
  done
done

if (( ${#failures[@]} > 0 )); then
  printf 'RRSIG health failure: %s\n' "${failures[@]}" >&2
  exit 1
fi
