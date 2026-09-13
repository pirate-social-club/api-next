#!/usr/bin/env bash
# Playback-only local API launch for the resume verification. No uploads, no
# remote R2 binding session; signed playback and the local database stay real.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

export PATH="/home/t42/.nvm/versions/node/v24.14.0/bin:/home/t42/.bun/bin:$PATH"
export CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_CONTROL_PLANE="postgres://postgres:postgres@127.0.0.1:55437/song_local_e2e"
export WRANGLER_SEND_METRICS=false
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=2048}"

exec "$root/node_modules/.bin/wrangler" dev \
  -c "$root/.tmp/local-pair/wrangler.resume-e2e.json" \
  --ip 127.0.0.1 --port 8788 --log-level info \
  --var PRIVY_JWKS_URL:https://auth.privy.io/api/v1/apps/cmsw5pis300b80cladbxx7bsr/jwks.json \
  --var PRIVY_JWT_AUDIENCE:cmsw5pis300b80cladbxx7bsr \
  --var CORS_ORIGIN:http://localhost:8787 \
  --var PIRATE_API_PUBLIC_ORIGIN:http://127.0.0.1:8788
