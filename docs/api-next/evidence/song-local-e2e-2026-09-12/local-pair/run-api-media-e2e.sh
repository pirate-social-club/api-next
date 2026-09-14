#!/usr/bin/env bash
# Local API launch for the media-enabled song onboarding journey.
# Uses the prepared overlay: remote R2 ingress/immutable bindings, uploads and
# playback enabled. Provider-side CORS and Privy origin additions must already
# be approved and applied; this script performs no provider change.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

export PATH="/home/t42/.nvm/versions/node/v24.14.0/bin:/home/t42/.bun/bin:$PATH"
export CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_CONTROL_PLANE="postgres://postgres:postgres@127.0.0.1:55437/song_local_e2e"
export WRANGLER_SEND_METRICS=false
export CI=true
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=2048}"

exec "$root/node_modules/.bin/wrangler" dev \
  -c "$root/.tmp/local-pair/wrangler.local-e2e.json" \
  --ip 127.0.0.1 --port 8788 --log-level info \
  --var PRIVY_JWKS_URL:https://auth.privy.io/api/v1/apps/cmsw5pis300b80cladbxx7bsr/jwks.json \
  --var PRIVY_JWT_AUDIENCE:cmsw5pis300b80cladbxx7bsr \
  --var CORS_ORIGIN:http://localhost:8787 \
  --var PIRATE_API_PUBLIC_ORIGIN:http://127.0.0.1:8788
