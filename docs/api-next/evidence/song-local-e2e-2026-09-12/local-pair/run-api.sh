#!/usr/bin/env bash
# Local API (api-next) launch for the song onboarding E2E pair.
# Reads credentials from apps/http-worker/.dev.vars (git-ignored, mode 0600).
# Database is the disposable PostgreSQL 17.11 container on 127.0.0.1:55437.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

export PATH="/home/t42/.nvm/versions/node/v24.14.0/bin:/home/t42/.bun/bin:$PATH"
export CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_CONTROL_PLANE="postgres://postgres:postgres@127.0.0.1:55437/song_local_e2e"
export WRANGLER_SEND_METRICS=false
export CI=true
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=2048}"

# wrangler's secrets.required filter drops undeclared .dev.vars entries, so the
# public Privy and localhost origin settings are passed as explicit vars.
exec nice -n 10 "$root/node_modules/.bin/wrangler" dev \
  -c apps/http-worker/wrangler.jsonc \
  --ip 127.0.0.1 --port 8788 --log-level info \
  --var PRIVY_JWKS_URL:https://auth.privy.io/api/v1/apps/cmsw5pis300b80cladbxx7bsr/jwks.json \
  --var PRIVY_JWT_AUDIENCE:cmsw5pis300b80cladbxx7bsr \
  --var CORS_ORIGIN:http://localhost:8787 \
  --var PIRATE_API_PUBLIC_ORIGIN:http://127.0.0.1:8788
