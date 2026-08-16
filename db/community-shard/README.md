# db/community-shard

Squashed SQLite baseline + forward migrations for per-community D1 shards
(api-next 000 §4). Lane B owns this directory (001 §4): the checksummed
migration fixtures feed the N-1 schema-compatibility harness.

`schema.sql` is the generated squashed baseline. The 160 forward migrations
under `migrations/` are copied as compatibility fixtures from the reviewed old
template, and `migrations/checksums.json` pins their SHA-256 contents. The
test-only harness in `packages/testing/src/community-schema.ts` verifies the
manifest before applying any fixture and can build a database through the
previous migration for N-1 checks.
