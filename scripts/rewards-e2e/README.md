# Isolated Rewards E2E tooling

This tooling belongs to the isolated Base Sepolia acceptance stack. Its standing
spending authority is recorded in the task's owner-authorization.json. It does
not operate shared staging or mainnet.

The spending ledger reserves before submission and persists outside the
resettable database. Failed or uncertain sends retain their reservations.
Returned balances do not replenish the cumulative authorization automatically.

The separate HTTP entrypoint is tests/rewards-e2e/entry.ts. Its compiled
identity pin reads the actual SQL role and checks the isolated API origin before application
initialization. Simulated claim verification is limited to development and
reward-claim intents, binds each subject to its actor, and is labelled in the
provider presentation and response header. Normal staging, production and jobs
artifact graphs must exclude the stub.

Run `bun run verify:rewards-e2e-build` to check graph exclusion, package the test
artifact through Wrangler without uploading it, and verify the copied
artifact's refusals in workerd. This uses a synthetic local role pin. It is a
build check, not a funded E2E run or a deployed-resource identity check.

The controlled contract source is infra/megapot/repeatable-e2e-fixture. It
supports predetermined wins and losses and an operator settlement after a
purchase. The runner must enforce drawing-advance.mjs before invoking that
settlement: a confirmed jobs purchase, the pinned jobs Worker's first receipt
read, and an independently canonical receipt are mandatory. A losing drawing
still returns a nonzero settled draw reference, matching the production sweep
reader; its ticket has tier zero.

The finish line is consecutive full win and loss runs on identical pinned API
and Solid releases. Both activity kinds must earn shares, the ticket must be
purchased and read before settlement, and claims, payouts, onward sends or
refunds must finish with nothing owed. Claim pending is a failure. The command
orchestration and hosted-resource setup remain under implementation; these
component checks do not close acceptance.

The hosted bootstrap applies at most twenty migrations per transaction and checks
the exact committed ledger before every batch. This bounds PostgreSQL lock use.
A failed batch leaves the bootstrap receipt unfinished; ordinary bootstrap
refuses a second attempt. Inspect the exact target, ledger and receipt before
recovery. Previously committed batches remain committed.

`configure-runtime.ts` requires independently pinned admin and runtime
credentials and a completed bootstrap receipt. It verifies the actual runtime
SQL identity, refuses elevated roles, applies application grants with the
maintained Rewards denials, and then checks the entire runtime money permission
inventory and exact source ledger. Credential values belong only in the
isolated Infisical folder and temporary runtime workflows.

`worker-plan.mjs` replaces the current configurations' writable bindings with
the isolated resources and leaves rewards off. It refuses unknown storage and
remote Durable Object targets. `prepare-worker-build.mjs` requires the tracked
plans to match, embeds the runtime role pin, and checks that jobs exclude
simulated verification. The deployment environment is `rewards-e2e`.

`seed-fixtures.ts` reads only the preserved isolated database. It imports the
three fixture identities, the published song, its policy and media evidence,
and the Study corpus into an empty, checksum-verified target. It excludes old
sessions, attempts, qualifications and money. The transaction temporarily
suspends an explicit list of account provisioners and media insertion guards
that require a newly issued upload or next revision. Foreign keys, snapshot
checks, mutation guards and rewards guards remain active. Deferred checks are
flushed before every suspended guard is restored and the transaction commits.
A populated target refuses automatic reset.

`prepare-solid-artifact.mjs` verifies all 324 files against independently
reviewed Solid release 8baa1948 before copying its build. The isolated site
proxies only the isolated API and disables HNS ingress. It requires no shared
frontend build or source mutation. These preparations do not establish live
Rewards acceptance.


The first dark HTTP deployment refused because Hyperdrive supplies a pool
username in its connection string. That username is not the origin SQL role.
The resource guard now compares a fresh read-only current_user result with the
compiled SQL role digest on every request. It does not cache a mutable origin
or accept the pool username as authority. Shared origins and nondevelopment
environments refuse before a database connection.

The receipt observer subscribes only to the isolated jobs Worker before rewards
are enabled. It retains public identifiers and never persists the private tail
URL or full log payload. Gaps, malformed observations, expiry and failed cleanup
are reported. Drawing advancement requires a captured transactionReadSequence
of one from the pinned Worker and attestation, linked to the confirmed database
purchase and independently canonical receipt. A later read cannot substitute.

Run preparation readback with `bun run e2e:rewards`. Set
`REWARDS_E2E_EVIDENCE_ROOT` to the durable authority package containing
owner-authorization.json, database-identity.json and spending-ledger. Set
`REWARDS_E2E_SOLID_ROOT` to the canonical Solid repository and
`REWARDS_E2E_KARAOKE_WAV` to the accepted fixture microphone WAV. The command
loads both approved Infisical folders in memory. Run `bun run e2e:rewards --execute`
to execute win and loss sequentially on the same committed, serving API and
Solid release. An interrupted invocation retains its lock and all single-use
markers for recovery; it never replays an uncertain signature.

Future runner branches use the reviewed `provision-branch.ts` helper merged in
PR #549, commit 79caabb98645e25c225dc302fb716ab148dcb24d. First run its read-only
plan, then `bun scripts/rewards-e2e/provision-branch.ts rewards-runner-YYYYMMDD
--execute --receipt=/absolute/durable/branch-receipt.json`. Independently verify the receipt before credentials or Hyperdrive.
The helper pins the organization, database, PostgreSQL 17, PS_5_AWS_ARM and
zero replicas. Existing runner branch l8mhyb0fxy54 was resized to zero replicas
under completed provider change 8w2whwejklwt. The current runner reuses that branch.
It does not create or delete paid database resources.

The canonical backing audio is copied byte-for-byte into
`pirate-media-immutable-megapot-e2e-staging`, with SHA-256
`51afd9db7bb1e0be27c0d1fd4c55741d0570027dd6c20a6f087388e971c62d08`.
Its GET/HEAD CORS policy permits only the isolated frontend. Playback uses
that bucket and requires an approved managed read credential scoped to it.
The shared staging playback credential refuses this bucket with HTTP 403.
Do not widen that credential or change shared bucket CORS. No funded run
may begin until real isolated Karaoke playback and qualification pass.

Preparation and closeout check the maintained nine shutdown inventory families
and unresolved winner sends across the entire isolated database. A successful
run also verifies the paused brake, disabled flags and owned browser cleanup.
Late evidence and failed receipt-observer cleanup cannot pass acceptance.

Jobs publish commitments through the existing isolated jobs Worker's public
reader at `pirate-jobs-worker-megapot-e2e-staging.piratesocialclub.workers.dev`.
The runner checks the exact origin, bucket binding and a read-only HEAD probe
of a preserved public document. The route accepts only commitment document
paths and GET/HEAD. The bucket's managed r2.dev URL remains disabled and is
not required for publication. An earlier preflight incorrectly required it.

A run that fails after its offer exists does not shut down at once.
`settlement-recovery.mjs` keeps the brake running and both flags on while the
leg settles: an unfunded or shareless offer expires and refunds, a purchased
ticket is settled on the fixture and then refunded or credited, and an unpaid
credit is claimed and paid. Each step is attempted once. A claim the run
already submitted is never repeated; the fixture settlement may be attempted
again because the contract refuses a second one. Recovery is bounded to ten minutes after the
drawing time and at most thirty minutes. The brake is then paused. Flags are
disabled only when the whole shutdown inventory is zero; otherwise they stay
on, the closeout reports the remaining obligations, and the next preparation
refuses until they are reconciled.

Each scenario uses two fixture drawings. The product starts a new leg on the
drawing after the last one the jobs Worker observed, and it requires a live
observation. The runner therefore arms a three-minute empty placeholder, waits
for jobs to observe it, creates and funds the Boost, settles the placeholder
once it is due, and only then arms the outcome drawing and waits for the leg's
pool drawing to open before any activity starts. A fixture left armed by an
earlier failed run is brought forward and settled before the placeholder.

The managed ETH float is reserved against the authorization once, under the
`managed-float` run, because it is one exposure and not a per-run cost. Each
run then reserves only what it sends: the principal, the prize when the fixture
needs funding, and a fee ceiling per fixture transaction. Payouts and refunds
redistribute those amounts and are not reserved again.
