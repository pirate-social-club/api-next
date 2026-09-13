# Creator nationality ceremony flow verification

The lane continued from `57671534` and landed three commits on
`feat/nationality-gated-join-and-handle-qualification`:

- `44627e03` exposes the creator nationality progress and next actions in the
  creation state machine and projects the optional-route requirement map.
- `f44474c6` routes the generic start variant through the creation resolver,
  replays or advances the append-only ceremony generation, and refuses
  superseded ceremony ids at the boundary.
- `daa460f2` issues, resets, projects, and settles the creator ceremony at
  intent create and update, guards commit against an unsatisfied or superseded
  requirement, and classifies the new suite for shard accounting.

Nothing was pushed, no pull request was opened, and no deployment, live
migration, or provider ceremony was performed. The control-plane task record
still needs the coordinator's synchronization.

## Verification

`bun run check` passed at the final commit `daa460f2`. `bun run test:node`
passed 20 of 20 tests.

`bun run test:unit` ran 4,066 tests across 584 files. Two unrelated timing
tests failed under host contention and pass when run focused: the Megapot
pacing assertion and a karaoke release-journal timeout. The two PostgreSQL
partition-discovery tests pass with the new suite classified.

A disposable PostgreSQL 17 container owned by this task ran the focused
suites over a Unix socket volume with `--set=fsync=off
--set=max_locks_per_transaction=512`, 1.5 CPU and 1.5 GiB caps. The lock
capacity read back as 51,200 entries. Results: the new five-test creation
nationality flow suite passed (issuance, projection, both-provider starts,
generation-fenced switching, stale completion refusal, completion, commit
persistence, rollback with zero community rows, changed-allowlist fresh
proof, Palm-only preservation, fail-closed missing authoring); the completion
and ceremony-store suites passed 8 of 8; the existing creation repository
suite passed 8 of 8. The suite sentinel is
`/tmp/api-next-control-plane-postgres-creation-nationality-flow-suite-complete`.
The container and its socket directory were removed on completion.

Not run: the workerd configurations, the four-shard PostgreSQL partitions,
the trusted remote secret-boundary gate, and staging acceptance. The evidence
lifetime decision remains an acceptance blocker, and production still
constructs the creation store and resolver without `nationality_authoring`, so
a nationality-gated creation fails closed until that server-resolved wiring
lands.
