#!/bin/sh
set -eu
# The pinned Alpine runtime uses BusyBox ash, which supports pipefail.
set -o pipefail

api_key_file="${HSD_API_KEY_FILE:-/run/secrets/hsd_api_key}"

if [ ! -r "$api_key_file" ]; then
  echo "hsd observer API key is not readable at $api_key_file" >&2
  exit 1
fi

HSD_API_KEY="$(tr -d '\r\n' < "$api_key_file")"
if [ "${#HSD_API_KEY}" -lt 32 ]; then
  echo "hsd observer API key must contain at least 32 characters" >&2
  exit 1
fi
export HSD_API_KEY

# --no-wallet is a command-line-only hsd preprocessor option. Keep both it and
# --no-dns fixed here so a compose/env edit cannot silently widen this keyless
# observer into a wallet or DNS-serving role.
exec node /opt/hsd/bin/hsd --no-wallet --no-dns "$@"
