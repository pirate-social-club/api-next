# Nationality and adult gates final local verification

This evidence belongs to API commit
`edd957c713f8654d341ac4ec1a956d26ba63f428`. The worktree was clean after
the verification. Nothing was pushed, enabled, deployed, or applied to a
shared database.

`bun run check` passed. It verified the 187-migration manifest and regenerated
baseline, dependency and HTTP boundaries, contracts, and the immutable
`@pirate/api-client` 0.79.0 package. The package artifact is
`artifacts/api-client/pirate-api-client-0.79.0.tgz` with SHA-256
`85488f318432c4ee3e124f16be406acc4a762c4953fc8f1cc58f0a2cc6e19c27`.

`bun run test` passed as one chained invocation: 4,181 unit tests, 20 Node
tests, and all five Workerd configurations with 82, 74, 2, 10, and 15 tests.
The intentional negative Workerd cases print exception text while passing.

The required PostgreSQL partitions ran serially against a task-owned
PostgreSQL 17 container over host networking. The four audited general shards
passed 209, 168, 185, and 195 tests. They recorded three expected skips in
total and no failures. The isolated namespace suite passed 35 tests, all 41
general completion markers verified, and the recovery partition passed seven
tests with 4,003 assertions. The container was removed afterward.

An earlier Unix-socket partition attempt passed 208 tests and skipped one, but
its embedded Workerd video gate failed because Cloudflare sockets require a
host-and-port address. Two Docker published-port attempts then reset their
first connection because this host's Docker proxy is not reliable. Host
networking supplied the same loopback TCP URL used by CI without that proxy.
The retained failed log establishes the setup failure; it is not acceptance
evidence. The corrected run then exposed three older tests that attempted to
lower an adult rating or expected a pre-cascade row count, plus a stale
foundation catalog. Commits `70efac515008020f0ccb093a2c875d5890600d43` and
`edd957c713f8654d341ac4ec1a956d26ba63f428` repaired those regressions before
the final complete run.

This is complete local API evidence. The trusted secret-boundary gate still
requires pull-request context. Real Self and ZKPassport document acceptance,
deployment, cache invalidation, retained-content reconciliation, and staging
acceptance remain external rollout work.
