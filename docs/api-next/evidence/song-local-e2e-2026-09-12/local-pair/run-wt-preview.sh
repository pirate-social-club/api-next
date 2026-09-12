#!/usr/bin/env bash
# Serves the built Solid runtime from this worktree root on 8787.
# The single preview process runs the built Worker in workerd.
set -euo pipefail
root="/media/t42/codedrive/Code/pirate-workspace/.worktrees/pirate-web-solid/solid-song-onboarding-e2e"
export PATH="/home/t42/.nvm/versions/node/v24.14.0/bin:$PATH"
export NODE_OPTIONS="--max-old-space-size=1024"
export WRANGLER_SEND_METRICS=false
export SOLID_API_NEXT_FIXTURE_ORIGIN="http://127.0.0.1:8788"
export RAYON_NUM_THREADS=2
cd "$root"
exec node node_modules/vite/bin/vite.js preview \
  --host 127.0.0.1 --port 8787 --strictPort
