# Ambient check parity

Status: hosted `check`-job parity reached for every step except
`check:breaking`, proven by a network-isolated workstation rehearsal on
2026-08-26. Two live Ambient attempts exposed consecutive trusted pre-plan
verifier defects before candidate code ran. A third attempt proved both
repairs, installed all 496 packages, delivered the exact Git checkout and
entered the networkless plan VM. It then exposed two guest-portability gaps:
the pinned Bun payload lacked the `bunx` alias used by a committed check script,
and the slower Haswell guest exceeded Vitest's 5-second default in two Self SDK
tests. The plan now supplies a guest-local alias to the same pinned Bun binary
and runs the same four Workerd configs with a bounded 30-second per-test
ceiling. Exact local probes passed both corrections. A successful replacement
live run is still required. No required-check substitution has occurred.

GitHub Actions with Blacksmith remains the preferred api-next executor. The
Ambient plan is an independent fallback for executor outages. During the
GitHub-primary transition its result is advisory and cannot satisfy the live
ruleset, whose required contexts are emitted by GitHub Actions.

## Plan shape

`.radicle/ambient.yaml` provisions checksum-pinned Bun 1.4.0 and Node 24.14.0
through trusted pre-plan actions. The deployed `bun_get` action builds the
lockfile-bound cache, and the plan VM performs
`bun install --frozen-lockfile --offline` without a network route. A
guest-local `bunx` symlink points to that exact pinned Bun binary; it does not
introduce another executable or a network route.

The deployed adapter clones the Radicle repository, checks out the trigger
commit and archives that checkout for the Ambient source drive. The deployed
source calls the broker's `get_sources`, which performs `git clone` followed by
`git checkout`, and the Ambient adapter tars that complete directory. A
retained VPS `src.tar` contains `.git`, including refs and objects. The plan
therefore requires Git metadata, a clean checkout and resolvable parent history
instead of synthesizing an index when the delivery contract is broken.

Ambient 0.16 stops a plan at the first failed action, so each gate records its
exit status and elapsed seconds and a final summary action fails the job after
every gate has had a chance to run. This mirrors the Solid plan contract.

## Hosted parity inventory

| Hosted `check` step | Ambient gate | Rehearsed result |
| --- | --- | --- |
| Bun 1.4.0 and dependency install | Plan action 1 | 496 packages installed offline from the lockfile-bound cache in 0.48 s |
| `bun run check` | `01-check` | Pass, 39 s |
| `bun test packages apps scripts` | `02-test-host` | Pass, 12 s; 1874 passed, 283 skipped, 0 failed across 303 files |
| `bun run test:workerd` | `03-test-workerd` | Same four configs with a 30-second guest test ceiling; the exact hosted command passed rehearsal in 89 s, with 84 tests across 25 files |
| Repeated `bun run check:fresh` | `04-check-fresh` | Pass, less than 1 s |
| Jobs Worker Wrangler dry run | `05-wrangler-jobs` | Pass, 2 s |
| HTTP Worker Wrangler dry run | `06-wrangler-http` | Pass, 2 s |
| `bun run check:breaking` | Excluded | The exact pull-request base SHA is not yet supplied to the plan |

Aggregate gate time was 144 s, wall time was 145.61 s and peak resident set was
1,109,592 KiB, measured on three pinned CPUs to approximate the 3-CPU, 5 GiB
guest. That is far inside the 60-minute broker `max_run_time`, so the runtime
budget question belongs to the Postgres 17 gate and not to this one.

`check:breaking` stays excluded until the exact pull-request base commit is
selected explicitly. Delivered history supplies `HEAD^1`, but that is not
necessarily the pull-request base for a multi-commit or stale branch. Absence
of the exact baseline must fail rather than degrade to a guessed default.

## Rehearsal method and its limits

The first rehearsal extracted the plan's shell bodies from the YAML and ran
them unmodified except for two substitutions: the workstation's identically
pinned Node 24.14.0 and Bun 1.4.0 replaced the guest paths under `/ci/deps`, and
a local directory replaced `/ci/src`. Its source was the exact tracked file set
but deliberately omitted `.git`, following the earlier mistaken archive
assumption. It proved the gate commands, offline dependency consumption and
resource budget, but not the adapter's source-delivery path. Execution ran
inside an unprivileged network namespace pinned to three CPUs. The namespace
held zero routes, refused outbound TCP, and resolved no DNS name.

A corrective rehearsal then repeated all eight actions against a full
temporary clone. The candidate changes were captured in rehearsal-only commit
`cdcbed8b0b4fb8a3df6d13d138859fa98fda8f6e`, on parent
`c519e4c62ed6e118a6c8460ec13de86997e92842`, so the plan saw a clean `.git`, a
resolvable parent and 557 commits. The same pinned tools and cache replaced the
guest paths, and unique temporary HOME, runner and status paths prevented
cross-run state. The command bodies were otherwise unchanged. The namespace
again had zero routes and failed DNS. All eight actions and all six gates
passed. This run also corrected the first record's Workerd count: nine tests
across six files described only the fourth Vitest invocation, while all four
groups total 84 tests across 25 files.

The checksum-sealed corrective harness, candidate plan and complete log are at
`/home/t42/Documents/agents/archive/api-next-ambient-real-checkout-rehearsal-2026-08-26/`.

The first live attempt proved that `bun_get` installed all 496 api-next
packages, including both GitHub-backed lock entries, but its
post-install verifier incorrectly sent their `github:` sources through the
registry semantic-version path. After that repair, the second attempt passed
both Git-backed entries and then rejected the legitimate registry package
`https-proxy-agent@5.0.1` because its name starts with `http`. The verifier now
binds GitHub sources to a hexadecimal revision, exact cache tag, `.bun-tag` and
lockfile SHA-512 field; ordinary registry names remain valid while URL-shaped
sources still fail closed. Registry tarball checksum handling is unchanged.

The third attempt, broker run `126a1497-8f3a-426b-b36d-98ebc4c36e8f`, proved
the corrected verifier and the actual trust boundary. The pre-plan installed
496 packages, and the plan VM had no network device, consumed the dependency
drive read-only and verified delivered head
`74438ebcf019852863d2df25eb2d7fcb5efaf5ab`. Four gates passed. `01-check`
failed only because `bunx` was absent, and `03-test-workerd` passed its first 73
tests before two Self SDK tests exceeded the 5-second default. A local probe of
the new alias completed strict Effect diagnostics across 426 files with zero
errors or warnings. The affected Self config passed with the new 30-second
ceiling.

The workstation kernel and filesystem still differ from the Haswell-noTSX
guest. Loopback was also up in the rehearsal namespace, whereas the guest has
no network at all. Those differences, plus the two plan corrections, require
one replacement live success.

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

No ruleset, GitHub App, credential, provider, database, product deployment or
runtime state is changed by this slice. The trusted Ambient executor was
rebuilt and redeployed under its separate control-plane task after the first
live attempt exposed the verifier defect.
