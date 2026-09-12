#!/usr/bin/env bash
# Local launch for the processing chain of the song onboarding journey:
# the jobs worker (outbox -> queue dispatch on demand) and the media processor
# worker (queue consumer -> local MediaProcessingWorkflow). One multi-worker
# wrangler dev session with a shared persist directory connects the queue.
#
# Provider credentials are fetched from Infisical at launch into an ignored,
# mode-0600 .dev.vars. No provider call happens until a queue message flows.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

export PATH="/home/t42/.nvm/versions/node/v24.14.0/bin:/home/t42/.bun/bin:$PATH"
export CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_CONTROL_PLANE="postgres://postgres:postgres@127.0.0.1:55437/song_local_e2e"
export WRANGLER_SEND_METRICS=false
export CI=true
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=1536}"

jobs_vars="$root/.tmp/local-pair/jobs/.dev.vars"
umask 077
cat > "$jobs_vars" <<'JOBS'
COMMUNITY_PURCHASE_FUNDING_RPC_URL="http://127.0.0.1:1/disabled"
MEGAPOT_V2_RPC_URL="https://base-sepolia-rpc.test"
JOBS

media_vars="$root/.tmp/local-pair/media-processor/.dev.vars"
: > "$media_vars"
for name in ACRCLOUD_ACCESS_KEY ACRCLOUD_ACCESS_SECRET ELEVENLABS_API_KEY OPENAI_API_KEY OPENROUTER_API_KEY; do
  value="$(infisical secrets get "$name" --projectId fac45f92-9450-42fb-8c2f-f20d043fdfab --env staging --path /services/api-next --plain 2>/dev/null || true)"
  if [ -z "$value" ]; then
    echo "missing Infisical value for $name" >&2
    exit 1
  fi
  printf '%s="%s"\n' "$name" "$value" >> "$media_vars"
done
unset value
echo "provider secret names loaded into $media_vars (values not printed)"

exec "$root/node_modules/.bin/wrangler" dev \
  -c "$root/.tmp/local-pair/jobs/wrangler.json" \
  -c "$root/.tmp/local-pair/media-processor/wrangler.json" \
  --persist-to "$root/.tmp/local-pair/workers-state" \
  --test-scheduled --ip 127.0.0.1 --port 8790 --log-level info
