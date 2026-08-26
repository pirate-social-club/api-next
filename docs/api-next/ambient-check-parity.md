# Ambient check parity

Status: hosted `check`-job parity reached for every step except
`check:breaking`, proven by a network-isolated workstation rehearsal on
2026-08-26. No live Ambient run and no required-check substitution has
occurred.

GitHub Actions with Blacksmith remains the preferred api-next executor. The
Ambient plan is an independent fallback for executor outages. During the
GitHub-primary transition its result is advisory and cannot satisfy the live
ruleset, whose required contexts are emitted by GitHub Actions.

## Plan shape

`.radicle/ambient.yaml` provisions checksum-pinned Bun 1.4.0 and Node 24.14.0
through trusted pre-plan actions. The deployed `bun_get` action builds the
lockfile-bound cache, and the plan VM performs
`bun install --frozen-lockfile --offline` without a network route.

Radicle supplies a committed source archive without `.git`. The repository's
`check:migrations:worktree` guard invokes `git ls-files --others`, so the plan
creates a synthetic Git repository and commits the complete shipped snapshot
before running any gate. This makes every delivered migration part of the
disposable index. It is not real repository history and must never be used as
the OpenAPI baseline.

Ambient 0.16 stops a plan at the first failed action, so each gate records its
exit status and elapsed seconds and a final summary action fails the job after
every gate has had a chance to run. This mirrors the Solid plan contract.

## Hosted parity inventory

| Hosted `check` step | Ambient gate | Rehearsed result |
| --- | --- | --- |
| Bun 1.4.0 and dependency install | Plan action 1 | 496 packages installed offline from the lockfile-bound cache in 1 s |
| `bun run check` | `01-check` | Pass, 40 s |
| `bun test packages apps scripts` | `02-test-host` | Pass, 7 s; 1874 passed, 283 skipped, 0 failed across 303 files |
| `bun run test:workerd` | `03-test-workerd` | Pass, 98 s; all four Workerd groups, 9 tests across 6 files |
| Repeated `bun run check:fresh` | `04-check-fresh` | Pass, 1 s |
| Jobs Worker Wrangler dry run | `05-wrangler-jobs` | Pass, 3 s |
| HTTP Worker Wrangler dry run | `06-wrangler-http` | Pass, 3 s |
| `bun run check:breaking` | Excluded | Fails as designed on the snapshot: `Unable to resolve baseline commit "HEAD^1"` |

Aggregate gate time was 152 s with a 1.09 GiB peak resident set, measured on
three pinned CPUs to approximate the 3-CPU, 5 GiB guest. That is far inside the
60-minute broker `max_run_time`, so the runtime budget question belongs to the
Postgres 17 gate and not to this one.

`check:breaking` stays excluded until the exact pull-request base commit is
shipped and selected explicitly. The synthetic snapshot commit has no parent,
and absence of the baseline must fail rather than degrade to a default.

## Rehearsal method and its limits

The plan's shell bodies were extracted from the YAML and executed unmodified
except for two substitutions: the workstation's identically pinned Node
24.14.0 and Bun 1.4.0 replaced the guest paths under `/ci/deps`, and a local
directory replaced `/ci/src`. The source tree was the exact tracked file set,
delivered without `.git`. Execution ran inside an unprivileged network
namespace pinned to three CPUs. The namespace held zero routes, refused
outbound TCP, and resolved no DNS name.

Three differences from the guest remain, and each is why a live run is still
required. The cache was populated by workstation Bun from this lockfile rather
than by the deployed `bun_get` action, so `bun_get`'s output shape is proven
for Solid but not yet for api-next. The workstation kernel, filesystem and CPU
model differ from the Haswell-noTSX guest. And loopback was up in the
namespace, whereas the guest has no network at all.

The Wrangler gates carry one further caveat. With telemetry, error reporting
and the version banner disabled, a `strace -f` route-less rehearsal of both dry
runs still issued DNS queries for exactly one name, `api.github.com`, and both
dry runs still succeeded. `bun run wrangler --version` under the same trace
issued none, so the query belongs to the deploy dry-run path in Wrangler
4.123.0, not to process startup. This differs from the Solid gate, whose trace
was clean under the same suppression variables; the cause is unattributed. The
absent guest network is therefore the control that makes these gates offline.
They are not proven network-free, and the exclusion note in the plan says so.

The required `postgres17` job is intentionally outside this plan. Its
checksum-bound PostgreSQL distribution, loopback-only guest service, sentinel
suite and budget are owned by `api-next-ambient-postgres17-gate`.

## Trust and rollout boundary

The candidate-controlled plan cannot approve a change to itself. This
implementation must land through healthy required GitHub checks or the already
documented break-glass ceremony. Later fallback decisions must use a
base-protected or host-pinned gate-contract digest and bind exact repository,
head SHA, base SHA, executor, attempt and terminal proof.

No ruleset, GitHub App, broker, credential, provider, database, deployment or
runtime state is changed by this slice.
