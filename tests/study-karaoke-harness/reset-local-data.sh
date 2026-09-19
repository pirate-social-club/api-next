#!/usr/bin/env bash
# Fast fixture reset: truncates the disposable harness database back to its
# baseline rows (db/postgres/test-reset.sql) and re-seeds the harness fixture.
# Keeps the container and the applied schema. Use reset-local-db.sh when the
# container or schema itself must be recreated.
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
reset_sql="$script_dir/../../db/postgres/test-reset.sql"
container=${HARNESS_PG_CONTAINER:-study-karaoke-harness-pg17}

if ! docker inspect -f '{{.State.Running}}' "$container" >/dev/null 2>&1; then
  printf 'database container %s is not running; run reset-local-db.sh first\n' "$container" >&2
  exit 1
fi

docker exec -i "$container" env PGOPTIONS="-c search_path=api_next" \
  psql -1 -U postgres -d postgres -v ON_ERROR_STOP=1 -q < "$reset_sql" >/dev/null
printf 'harness database data reset\n'
bun "$script_dir/seed.ts"
