# DATA metadata rating and immutable preparation

New song IP metadata uses pirate-data-metadata-v2 with content_rating; the NFT
metadata includes the Content rating trait. Both general and adult_18 are
explicit. Video v1 already carries these fields and retains its encoder.
Public IPFS delivery is unchanged. No age proof or viewer facts are added.

Migration 0184 pins the whole canonical document pair before either artifact
is recorded. Concurrent preparation returns the same pair. Existing v1 hashes
select the old encoder; an unreconstructable artifact fails closed. A retry
cannot rewrite historical bytes after an authority or rating change.

The focused encoder and chain tests passed 48 tests. Baseline regeneration
passed with 180 migrations. The complete check passed after fixing an unused
export and a widened fixture literal; those failed attempts are retained.
The first full unit run then failed only the render-host shard pin. Updating
the computed CI shard was followed by 11 focused shard tests and a fresh
full unit run: 4,164 passed, zero failed across 598 files. Node passed 20.
All five workerd configurations passed separately: 82, 74, 2, 10 and 15 tests.
The complete DATA registration PostgreSQL suite passed seven tests and 96
assertions against a task-owned socket-mounted PostgreSQL 17 database. The
container and socket were cleaned up. Runtime cancellation diagnostics remain
in the workerd log; the commands and all five configurations exited zero.

The full check precedes only the final CI shard-pin correction; the fresh
full unit run includes it. This is component-by-component evidence, not a
claim that the four PostgreSQL partitions or remote secret-boundary gate ran.
Historical rating reconciliation, cache handling and live acceptance remain
open. Nothing was enabled, pushed or deployed.
