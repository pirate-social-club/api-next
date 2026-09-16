# Activity persona preparation evidence — 2026-09-16

Local-only evidence for the preparation tranche on
`feat/activity-participation-authority`. No publication, merge, deployment,
staging or database mutation, provider call, credential use or client release
occurred. The PostgreSQL runs used a disposable local `postgres:17` container
and per-test disposable schemas.

## Commands, results and exit codes

| Command | Result | Exit |
| --- | --- | --- |
| `bun run db:generate:baseline` | regenerated `schema.sql` and `test-reset.sql` with the renamed migration and the new preparation action table | 0 |
| `bun run check:baseline:fresh` | baseline, reset SQL and foundation catalog fresh | 0 |
| `bun scripts/check-postgres-migration-worktree.ts` | 188 migrations consistent | 0 |
| `bun test packages/platform-cf/src/activity-participation-preparation.pg.test.ts` | 2 pass, 0 fail, 28 assertions | 0 |
| `bun test karaoke-persona-boundary.pg.test.ts postgres-foundation.pg.test.ts study-v2-lifecycle.pg.test.ts study-v2-foundation.pg.test.ts` | 18 pass, 0 fail, 293 assertions | 0 |
| `bun test activity-qualification-repository.pg.test.ts persona-repository.pg.test.ts persona-community-binding-migration.pg.test.ts` | 23 pass, 0 fail, 219 assertions | 0 |
| `bun test packages/contracts/src` | 198 pass, 0 fail, 1665 assertions | 0 |
| `bun test packages/application/src/use-cases apps/http-worker/src` | 520 pass, 16 skip, 0 fail, 1682 assertions | 0 |
| `bun run test:unit` | 4454 pass, 1 skip, 0 fail, 27117 assertions | 0 |
| `bun run check` | every stage passes through `check:fresh`; `verify:api-client` fails because the coordinated immutable client release is deliberately not cut from this lane | 1 |

The `verify:api-client` failure is expected and is a coordination item, not a
code defect: `scripts/verify-api-client-package.ts` pins the current release
and requires the packed client to match an immutable ledger artifact, while
this lane is forbidden from publishing a client. The branch proposes generated
client 0.82.0 in `packages/api-client/package.json`; the release-ledger entry,
immutable `artifacts/api-client/pirate-api-client-0.82.0.tgz` and handoff JSON
must be cut by the client owner at integration.

Biome reports the same 55 warnings and 5 infos as current main with zero
errors. The failing first runs are retained below: fixture mistakes
(presentation foreign key, stale presentation replay, future-dated streak pin,
`rows` assertions) and the shard-pin mismatch caused by the branch's added
PostgreSQL suite.

## Retained failing runs

`focused-preparation-pg-first/second/third.log` are the retained red runs of
the new composed test while fixtures were corrected. `unit-suite-first.log` is
the first full unit run, failing only the PostgreSQL manifest/pin tests that my
new tracked suite and the computed shard owner require; `check-first.log` is
the pre-format `check` run.

## Scope statement

The restricted-runtime-role case creates `api_next_app` (if absent), grants
only schema usage and object privileges, and runs preparation plus the whole
never-joined Study v2 journey through a connection whose `role` option is
`api_next_app`. No superuser behavior is exercised by the claims.

The above is local proof only. It is not live acceptance, not an independent
review, and not a claim that the current Staging runtime implements the
boundary.
