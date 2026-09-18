#!/usr/bin/env bash
# Recreates the disposable harness PostgreSQL (bounded to 1 CPU / 512 MB).
# Destructive by design: it removes only the named harness container.
#
# The container runs with host networking, bound to 127.0.0.1, because
# connections through a published docker port were observed to be terminated
# before the PostgreSQL protocol could complete on this host. The harness
# Worker and the seed script both address 127.0.0.1:5432 directly.
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
schema="$script_dir/../../db/postgres/schema.sql"
container=${HARNESS_PG_CONTAINER:-study-karaoke-harness-pg17}

if [[ ! -f $schema ]]; then
  printf 'schema baseline not found: %s\n' "$schema" >&2
  exit 1
fi

docker rm -f -v "$container" >/dev/null 2>&1 || true
docker run -d \
  --name "$container" \
  --network host \
  --cpus=1 \
  --memory=512m \
  -e POSTGRES_PASSWORD=postgres \
  postgres:17 -c listen_addresses=127.0.0.1 >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
# The image entrypoint runs a temporary server during initialization; wait for
# the real one before applying anything.
ready=0
for _ in $(seq 1 60); do
  if docker exec "$container" psql -U postgres -d postgres -tAc "SELECT 1" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if (( ready != 1 )); then
  printf 'harness database did not become ready\n' >&2
  exit 1
fi

# The control plane pins search_path to `api_next,pg_catalog` per transaction,
# so the baseline must live in an `api_next` schema.
docker exec "$container" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q \
  -c "CREATE SCHEMA IF NOT EXISTS api_next" >/dev/null
docker exec -i "$container" env PGOPTIONS="-c search_path=api_next" \
  psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q < "$schema" >/dev/null
tables=$(docker exec "$container" psql -U postgres -d postgres -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='api_next'")
printf 'harness database ready: %s (127.0.0.1:5432, api_next, %s tables)\n' "$container" "$tables"
