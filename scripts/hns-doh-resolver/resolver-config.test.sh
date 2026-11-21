#!/usr/bin/env bash
# Static checks for the resolver's Unbound configuration wiring.
#
# hnsd's root answers non-existent names with a synthetic ". NSEC ." proof that
# makes the root look empty; with Unbound's aggressive NSEC that one answer
# denies every real TLD. The image must ship aggressive-nsec: no and the
# entrypoint must pass it to hnsd, without weakening validation.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
fail() { echo "FAIL: $1" >&2; exit 1; }
pass() { echo "ok: $1"; }

conf="$here/unbound.conf"
[[ -f "$conf" ]] || fail "unbound.conf is missing"
# Only the server clause and the one option; anything else needs review here.
settings="$(grep -v -E '^\s*(#|$)' "$conf")"
expected=$'server:\n    aggressive-nsec: no'
[[ "$settings" == "$expected" ]] || fail "unbound.conf must contain exactly 'server:' and 'aggressive-nsec: no' (got: $settings)"
for weakening in val-permissive-mode module-config domain-insecure trust-anchor insecure-lan-zones harden-dnssec-stripped; do
  grep -q -E "^\s*$weakening\s*:" "$conf" && fail "unbound.conf must not set $weakening"
done
pass "unbound.conf disables aggressive NSEC and nothing else"

dockerfile="$here/Dockerfile"
grep -Fxq 'COPY unbound.conf /etc/hnsd/unbound.conf' "$dockerfile" || fail "Dockerfile must copy unbound.conf to /etc/hnsd/unbound.conf"
grep -Fq 'chmod 0444 /etc/hnsd/unbound.conf' "$dockerfile" || fail "Dockerfile must make /etc/hnsd/unbound.conf read-only (0444)"
copy_line=$(grep -n -F 'COPY unbound.conf /etc/hnsd/unbound.conf' "$dockerfile" | cut -d: -f1)
last_from=$(grep -n -E '^FROM ' "$dockerfile" | tail -1 | cut -d: -f1)
(( copy_line > last_from )) || fail "unbound.conf must be copied in the final image stage"
pass "Dockerfile installs the config read-only in the final stage"

entrypoint="$here/docker-entrypoint.sh"
exec_block="$(sed -n '/^exec hnsd/,/"\$@"/p' "$entrypoint")"
grep -Fq -- '--rs-config /etc/hnsd/unbound.conf' <<<"$exec_block" || fail "entrypoint must pass --rs-config /etc/hnsd/unbound.conf to hnsd"
pass "entrypoint passes the config to hnsd"
