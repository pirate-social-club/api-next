#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${DEPLOY_ROOT:-}" || ! -r "$DEPLOY_ROOT/current/DEPLOYMENT" ]]; then
  echo "DEPLOY_ROOT/current/DEPLOYMENT is not readable" >&2
  exit 1
fi
role="$(sed -n 's/^ROLE=//p' "$DEPLOY_ROOT/current/DEPLOYMENT" | head -1 | tr -cd 'A-Za-z0-9._-')"
source_commit="$(sed -n 's/^SOURCE_COMMIT=//p' "$DEPLOY_ROOT/current/DEPLOYMENT" | head -1 | tr -cd 'a-f0-9')"
if [[ -z "$role" || ! "$source_commit" =~ ^[a-f0-9]{40}$ ]]; then
  echo "deployment heartbeat identity is invalid" >&2
  exit 1
fi
tooling_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$tooling_dir/ping-healthcheck.py" --state success --label "$role:$source_commit"
