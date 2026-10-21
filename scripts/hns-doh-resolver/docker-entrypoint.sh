#!/bin/sh
set -eu
# The pinned Alpine runtime uses BusyBox ash, which supports pipefail.
set -o pipefail

# Both listeners stay on loopback. hnsd must never be publicly reachable: an
# open recursive resolver on UDP is a DDoS amplification vector. Public exposure
# is DoH only, terminated by Caddy and rate-limited by dnsdist in front of this.
#
# -r is the recursive resolver clients use; -n is hnsd's internal authoritative
# root server. Both are pinned here rather than passed through compose so an env
# edit cannot silently bind either to a public address.
HNSD_POOL_SIZE="${HNSD_POOL_SIZE:-4}"
HNSD_RS_HOST="${HNSD_RS_HOST:-127.0.0.1:5350}"
HNSD_NS_HOST="${HNSD_NS_HOST:-127.0.0.1:5351}"

case "$HNSD_RS_HOST" in
  127.0.0.1:*|\[::1\]:*) ;;
  *) echo "refusing to start: HNSD_RS_HOST must be loopback, got $HNSD_RS_HOST" >&2; exit 1 ;;
esac
case "$HNSD_NS_HOST" in
  127.0.0.1:*|\[::1\]:*) ;;
  *) echo "refusing to start: HNSD_NS_HOST must be loopback, got $HNSD_NS_HOST" >&2; exit 1 ;;
esac

exec hnsd \
  --pool-size "$HNSD_POOL_SIZE" \
  --rs-host "$HNSD_RS_HOST" \
  --ns-host "$HNSD_NS_HOST" \
  --prefix /var/lib/hnsd \
  --user-agent "pirate-hns-doh-resolver:1.0.0" \
  "$@"
