#!/usr/bin/env bash
set -euo pipefail

# Prove that the certificate currently served by the gateway is authorized by
# every managed TLSA owner through each authoritative serving path. During a
# rollover, old and new TLSA associations may coexist; the live SPKI must match
# at least one association at every owner.

probe_address="${HNS_DANE_PROBE_ADDRESS:-}"
probe_host="${HNS_DANE_PROBE_HOST:-}"
servers_csv="${HNS_DANE_SERVERS:-}"
owners_csv="${HNS_DANE_TLSA_OWNERS:-}"
dig_bin="${HNS_DANE_DIG_BIN:-dig}"

# shellcheck source=lib/dig-retry.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/dig-retry.sh"
openssl_bin="${HNS_DANE_OPENSSL_BIN:-openssl}"
probe_bin="${HNS_DANE_SPKI_PROBE_BIN:-}"

[[ -n "$probe_address" ]] || { echo "HNS_DANE_PROBE_ADDRESS is required" >&2; exit 2; }
[[ -n "$probe_host" ]] || { echo "HNS_DANE_PROBE_HOST is required" >&2; exit 2; }
servers_csv="${servers_csv//[[:space:]]/}"
owners_csv="${owners_csv//[[:space:]]/}"
[[ -n "${servers_csv//,/}" ]] || { echo "HNS_DANE_SERVERS must contain a server" >&2; exit 2; }
[[ -n "${owners_csv//,/}" ]] || { echo "HNS_DANE_TLSA_OWNERS must contain a check" >&2; exit 2; }

IFS=',' read -r -a servers <<< "$servers_csv"
IFS=',' read -r -a owners <<< "$owners_csv"

if [[ -n "$probe_bin" ]]; then
  live_spki="$($probe_bin "$probe_address" "$probe_host")"
else
  live_spki="$({
    "$openssl_bin" s_client -connect "${probe_address}:443" -servername "$probe_host" < /dev/null 2>/dev/null \
      | "$openssl_bin" x509 -pubkey -noout \
      | "$openssl_bin" pkey -pubin -outform DER 2>/dev/null \
      | "$openssl_bin" dgst -sha256 -hex
  } | awk '{print $NF}')"
fi
live_spki="${live_spki//[[:space:]]/}"
live_spki="${live_spki,,}"
[[ "$live_spki" =~ ^[a-f0-9]{64}$ ]] || { echo "invalid live SPKI digest" >&2; exit 1; }

failures=()

for raw_server in "${servers[@]}"; do
  server="${raw_server//[[:space:]]/}"
  [[ -n "$server" ]] || continue
  for raw_owner in "${owners[@]}"; do
    owner="${raw_owner//[[:space:]]/}"
    [[ -n "$owner" ]] || continue
    if ! dig_with_retry answer "$dig_bin" +time=5 +tries=1 +noall +answer "@$server" "$owner" TLSA; then
      failures+=("$server $owner TLSA query $answer")
      continue
    fi
    associations="$(awk '
      $4 == "TLSA" && $5 == 3 && $6 == 1 && $7 == 1 {
        digest = ""
        for (field = 8; field <= NF; field++)
          digest = digest $field
        print tolower(digest)
      }
    ' <<< "$answer")"
    if [[ -z "$associations" ]]; then
      failures+=("$server $owner has no TLSA 3 1 1 association")
    elif ! grep -Fxq "$live_spki" <<< "$associations"; then
      failures+=("$server $owner does not authorize live SPKI $live_spki")
    else
      printf 'ok: %s %s authorizes live SPKI %s\n' "$server" "$owner" "$live_spki"
    fi
  done
done

if (( ${#failures[@]} > 0 )); then
  printf 'DANE SPKI health failure: %s\n' "${failures[@]}" >&2
  exit 1
fi
