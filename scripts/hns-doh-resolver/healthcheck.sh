#!/bin/sh
# Readiness gate for the hnsd SPV resolver.
#
# A plain "does it answer root NS" probe is NOT a sync gate: hnsd can answer from
# partial chain state while still catching up, which would serve stale HNS
# ownership/resource data. hnsd exposes real status over its Hesiod (HS class)
# API on the root nameserver port, so gate on that instead.
#
#   synced.chain.hnsd    -> boolean, must be "true"
#   time.tip.chain.hnsd  -> unix timestamp of the chain tip, must be recent
set -eu
# The pinned Alpine runtime uses BusyBox ash, which supports pipefail.
set -o pipefail

NS_PORT="${HNSD_NS_PORT:-5351}"
MAX_TIP_AGE="${HNSD_HEALTH_MAX_TIP_AGE_SECONDS:-21600}"

hs_txt() {
  dig +short +time=3 +tries=1 @127.0.0.1 -p "$NS_PORT" -c HS -t TXT "$1" 2>/dev/null \
    | tr -d '"' | head -1
}

synced="$(hs_txt synced.chain.hnsd)"
if [ "$synced" != "true" ]; then
  echo "hnsd not synced (synced.chain.hnsd=${synced:-<no answer>})" >&2
  exit 1
fi

tip_time="$(hs_txt time.tip.chain.hnsd)"
case "$tip_time" in
  ''|*[!0-9]*)
    echo "hnsd tip time unavailable or non-numeric: ${tip_time:-<no answer>}" >&2
    exit 1
    ;;
esac

now="$(date -u +%s)"
age=$((now - tip_time))
if [ "$age" -lt 0 ]; then
  echo "hnsd tip time is in the future by $((-age))s; refusing to report healthy" >&2
  exit 1
fi
if [ "$age" -gt "$MAX_TIP_AGE" ]; then
  echo "hnsd tip is stale: ${age}s old (max ${MAX_TIP_AGE}s)" >&2
  exit 1
fi

exit 0
