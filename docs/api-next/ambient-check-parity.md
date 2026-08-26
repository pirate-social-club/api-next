# Ambient check parity

Status: first advisory slice drafted on 2026-08-26. No live Ambient run or
required-check substitution has occurred.

GitHub Actions with Blacksmith remains the preferred api-next executor. The
Ambient plan is an independent fallback for executor outages. During the
GitHub-primary transition its result is advisory and cannot satisfy the live
ruleset, whose required contexts are emitted by GitHub Actions.

## First slice

`.radicle/ambient.yaml` now provisions checksum-pinned Bun 1.4.0 and Node
24.14.0 through trusted pre-plan actions. The deployed `bun_get` action builds
the lockfile-bound cache, and the plan VM performs
`bun install --frozen-lockfile --offline` without a network route.

Radicle supplies a committed source archive without `.git`. The repository's
`check:migrations:worktree` guard invokes `git ls-files --others` so the plan
creates a synthetic Git repository and commits the complete shipped snapshot
before running `bun run check`. This makes every delivered migration part of
the disposable index. It is not real repository history and must never be used
as the OpenAPI baseline.

The slice records the `bun run check` exit status and elapsed seconds. It does
not retry a failing repository command.

## Hosted parity inventory

| Hosted `check` step | Ambient state | Remaining proof |
| --- | --- | --- |
| Bun 1.4.0 and dependency install | Drafted | Live networkless cache-consumption run against api-next |
| `bun run check` | Drafted | Successful guest result and time/memory observation |
| `bun run test` | Excluded | Host and all four Workerd groups must run from the offline cache |
| Repeated `bun run check:fresh` | Excluded | Add only when mirroring the hosted job as a complete contract |
| `bun run check:breaking` | Excluded | Ship and verify the exact pull-request base commit and select it explicitly |
| Jobs Worker Wrangler dry run | Excluded | Prove the pinned command makes no Internet socket or DNS attempt |
| HTTP Worker Wrangler dry run | Excluded | Prove the pinned command makes no Internet socket or DNS attempt |

The required `postgres17` job is intentionally outside this plan. Its
checksum-bound PostgreSQL distribution, loopback-only guest service, sentinel
suite, and 60-minute broker budget are owned by
`api-next-ambient-postgres17-gate`.

## Trust and rollout boundary

The candidate-controlled plan cannot approve a change to itself. This first
implementation must land through healthy required GitHub checks or the already
documented break-glass ceremony. Later fallback decisions must use a
base-protected or host-pinned gate-contract digest and bind exact repository,
head SHA, base SHA, executor, attempt, and terminal proof.

No ruleset, GitHub App, broker, credential, provider, database, deployment, or
runtime state is changed by this slice.
