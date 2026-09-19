#!/usr/bin/env bash
# Starts the local Study/Karaoke harness Worker on http://127.0.0.1:8788 against
# the disposable PostgreSQL created by reset-local-db.sh. Foreground process.
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
repo_root=$(cd "$script_dir/../.." && pwd -P)
wrangler="$repo_root/node_modules/.bin/wrangler"

if [[ ! -x $wrangler ]]; then
  printf 'wrangler not found at %s; run bun install in the api-next worktree first\n' "$wrangler" >&2
  exit 1
fi

database_container=${HARNESS_PG_CONTAINER:-study-karaoke-harness-pg17}
if ! docker inspect -f '{{.State.Running}}' "$database_container" >/dev/null 2>&1; then
  printf 'database container %s is not running; run reset-local-db.sh first\n' "$database_container" >&2
  exit 1
fi

bun "$script_dir/keys.ts"

mkdir -p "$script_dir/.local"
printf '%s\n' "$$" > "$script_dir/.local/harness.pid"
exec "$wrangler" dev \
  --config "$script_dir/wrangler.jsonc" \
  --ip 127.0.0.1 \
  --port 8788
