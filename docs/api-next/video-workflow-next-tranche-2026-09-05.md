# Video Workflow next tranche

This records the supplied checkpoint review and the resulting implementation
order for `api-video-execution-completion`. The control-plane amendment landed
in `82da717` after the other writer checkpointed. That record reserves
`0120_video_workflow_execution.sql` for execution. The migration is now written
and locally tested as described below; no wire contract changed or provider
was enabled.

## Ownership, rebase and migration checkpoint — 2026-09-05

Control-plane commit `8fb4707f` records the shared ownership in both lanes,
including execution's transactional publication wakeups and delivery's rule
to allocate its migration only after 0120 merges. The historical ownership
patch needed its delivery context refreshed because that record had gained
the projection checkpoint; existing evidence was preserved.

Execution rebased without conflicts onto main
`ba0fd44529d834f491879126cdb8c67c4ec9fcdc`, producing pre-migration tip
`4f8a2bbf2d5dfb42a176c95a9063f2087ae051f7`. At that exact tip, the ordinary
migration inventory contained 119 SQL files, ending in
`0119_hns_root_health_renewal.sql`; no 0120 file existed. Delivery was at
`223df3a9` and HNS deployment at `7d3c8aae`. No helper worktree was opened.

Migration 0120 locks the two affected tables before its refusal checks. It
rejects all historical attempts, old poll_wait/running leases, and historical
outbox outcomes whose launch meaning cannot be inferred. Only untouched
pending intents convert. The request-ID primary index survives unchanged;
creation-bound uniqueness and submitting are admitted. Launch metadata and
launch-attempt accounting replace the old delivery schema. This schema is a
prerequisite for the following repository commits, not an independently
deployable runtime checkpoint.

The normal baseline generator completed successfully. The focused PostgreSQL
17 migration suite passed five tests covering atomic refusal, expired old
leases, primary-index preservation, creation uniqueness, submitting and an
untouched pending intent. These tests use a private schema and roll back each
case; they do not establish staging preflight counts or Workflow reachability.

The following attempt-store change binds both request-ID derivation and SQL
replay predicates to creation revision. Allocation may be written only from
an empty attempt; subsequent transitions are allocated to submitting to
started, or an idempotent same-phase write. Job identity and the original
deadline remain fenced. The focused PostgreSQL store test passed 15
assertions, including a separate fresh creation row and replay of the prior
started job. Its drill 7 name identifies only this store boundary; terminal
provider failure, author retry and changed poster output still need composed
proof. TypeScript and 18 analysis/transform tests passed. The old Queue runner
and Qencode submit path have not yet adopted these transitions, so their
composition remains intentionally disabled and is not accepted by this test.

The broad check first caught a missing creationRevision in the Worker
composition fixture. After correcting that fixture, `bun run check` passed,
including both TypeScript projects, bindings, migration consistency and client
0.61.0 provenance. `bun run test` passed 2,956 unit, 20 Node and 131 workerd
tests. The local secret-boundary audit found no violations across 27 changed
tracked files. The full PostgreSQL gate was not run for this intermediate
schema conversion: the old outbox repository still targets retired columns
and must be converted next. The six focused PostgreSQL tests above passed;
they are not a substitute for that gate or remote CI.

The migration-loader/isolation-manifest check initially failed because the
new suite file was untracked; after staging it, all eight tests passed. The
checkpoint record amendment was applied after the control-plane writer
checkpointed and is committed as `559361e5`; the preserved patch is historical
and must not be reapplied. The register check passed 346 task files with two
existing overdue-review warnings. The task-owned PostgreSQL container was
stopped after focused validation. No live migration or provider call occurred.

The historical [execution-record amendment](evidence/video-execution-2026-09-05/execution-record-amendment.patch)
passed its applicability check and was applied before the final reservation,
allocated-job preflight, and replay-index requirements were added. It must not
be reapplied. The authoritative record now includes the final PostgreSQL
qualification and the Solid integration note.

## Corrections established from the tree

Migration 0114 has a transform-attempt uniqueness constraint on
`(submission_id, video_revision, analysis_revision, capability)`. Changing only
the request ID to include creation revision will still violate that constraint
after a failed attempt. The next migration must persist creation revision and
replace that uniqueness rule with creation-bound uniqueness. Preserve analysis
revision as evidence, rather than treating it as author-retry identity.

The same migration must admit `submitting` in `provider_job_phase`, with
monotonic transitions and exact provider-job/deadline fences. Existing rows
must not be assigned a guessed creation revision from the current submission.
Identify an unambiguous historical outbox association or retain the attempt
for reconciliation; the migration preflight must expose ambiguous rows.

The [read-only transform preflight](evidence/video-execution-2026-09-05/transform-attempt-preflight.sql)
reports phase counts without disclosing provider job identifiers and rejects
any `allocated` attempt with a stored job ID. The expected staging count is
zero, but no staging query has established that yet. A nonzero result requires
explicit reconciliation before adopting `submitting` semantics; do not relabel
those rows automatically. This check is additional to historical creation-
revision provenance checks, not a replacement for them.

Local preflight validation used PostgreSQL 17 and a connection-local temporary
table: an empty ledger with its request-ID primary index passed, an allocated
stored job was rejected, and a missing request-ID primary index was rejected.
The first connection attempt to the previous full-suite container failed with
`57P03`, database starting up, before any preflight SQL ran. A fresh minimal
container supplied these three checks. No staging query, numbered migration,
or full application test suite ran for this preflight-only change.

Retain the `request_id` primary key and its valid index. `loadOrCreate` first
selects that unique request ID and then checks every binding column; the
primary index already bounds that lookup to at most one row. Replacing the
separate retry-uniqueness constraint must not drop this index or remove those
binding predicates. Prove exact replay, changed-binding rejection and distinct
creation retries in the migration/repository tests; no redundant wide replay
index is needed solely because the other uniqueness rule changes.

The inspected main and three other api-next worktrees end their ordinary
migration inventory at 0119. The HNS deployment worktree is clean and its 0119
file is already present on main. A fresh inventory after the control-plane
handoff still found 0120 free; `82da717` reserves it for execution. Other
migration writers must use a separately checked later number. The current
video worktree predates newer main commits and needs a checked integration
base before the migration is implemented.

Cloudflare excludes duplicate retained IDs from `createBatch` results. After
retention expires, an ID can be reused. PostgreSQL must therefore prevent
replaying completed effects both while a terminal instance exists and after
it disappears. See the [Workers API contract](https://developers.cloudflare.com/workflows/build/workers-api/#createbatch).

## Launch and execution authority

Settle the database state machine before writing the runner. The analysis
outbox becomes launch delivery only. Its proposed transitions are
`pending -> launching -> launched`, with `retry_wait` after a transport failure
and `exhausted` after the bounded launch-failure budget. An expired launch claim
is fenced and recoverable. `launched` records the logical identity, physical
instance ID and launch acknowledgement; it does not mean analysis succeeded.
Provider polling does not occupy `poll_wait`, renew a queue lease, or increment
launch attempts. Preserve existing provider jobs and deadlines during the
conversion; do not map historical `delivered` blindly to successful execution.

Submission state and accepted facts remain execution authority. A persisted
execution outcome or reconciliation evidence must be independently readable
from launch acknowledgement. A failure to persist that outcome leaves work
eligible for reconciliation. The exact relational shape and conversion of
existing rows must be reviewed together with the repository changes; an enum
change alone is not a runnable migration.

The queue consumer claims the intent, reloads authority, calls deterministic
create, treats `already_exists` as convergence, records the instance under
the claim fence, and acknowledges. Crash after accepted create before the
database acknowledgement reuses the same identity. Launch exhaustion cannot
authorize a new encode. Prove the queue's delivery budget cannot suppress
database-eligible recovery; the cron can enqueue a new transport message.

The sweep reads PostgreSQL outcome first. Existing outcomes are never
relaunched. A confirmed missing instance with resumable current authority is
redispatched through the queue; the sweep never creates directly. A retained
terminal instance without an outcome causes fenced failure/reconciliation
evidence, not recreation of the same retained ID. Transport errors and unknown
statuses do not prove absence. An explicit author retry after confirmed
terminal failure advances creation revision and obtains a new instance.
Uncertain provider acceptance is not such a failure and must not permit retry.

## Runner and wakeups

Use identifier-only steps and reload PostgreSQL authority before every effect.
First verify the immutable object's identity against the seal digest facts.
For each capability, allocate, persist submission intent, start, poll through
bounded uniquely named status steps and durable sleeps, then accept persisted
outputs. Each capability has its own persisted deadline; redelivery does not
reset it. `submitting` is stored before `start_encode2`. Recovery uses
authenticated status; bounded unresolved acceptance records reconciliation
evidence and never blindly submits again. Retain the allocation-success/lost-
persistence drill as a separate ambiguity boundary.

Then run recognition, safety, and the existing decision/publication fence.
Check current revision and eligibility before accepting every result. A
publication-only retry uses already accepted facts and must not create fresh
probe/audio/frame jobs merely because its creation revision advanced.

Use the song publication event pattern for manual review. The runner waits
for `publication`; approval and publication-only retry atomically persist a
wakeup intent. Queue delivery converges the instance and sends the event when
appropriate. Event payloads carry identifiers; PostgreSQL determines whether
publication is allowed. Duplicate or early events cannot bypass open holds.
Missing-instance recovery resumes from accepted state, including a review wait.

This supersedes the record's proposal for a separate publication processor
outbox kind. Durable wakeup rows still need event identity and their own
delivery acknowledgement. The schema must support multiple wakeups without
overwriting the immutable analysis launch row. Reuse the song delivery/event
mechanism; do not introduce a second publication execution path or treat
notification acceptance as publication success.

## Provider composition and acceptance

Compose concrete providers after the runner is executable with fake transports.
Use a dedicated source-gateway Worker with request-URL logging disabled and
durable exact-object grants. Reuse image moderation for sealed JPEGs, with
caption policy preserved. Ratify Qencode sample output policy and container
support before composing ACR. Membership loss retains typed internal evidence
and prevents publication; do not invent a public action or disguise it as
`publication_failed` before the wire disposition is ratified.

The acceptance test drives the queue Worker and actual Workflow entrypoint
through analysis to publication with injected fake transports and no test-side
publish call. Add separate fault cases for accepted start response loss,
publication commit before acknowledgement, membership loss, and fresh retry
after terminal provider failure. Last-hold approval must publish through its
event even when the author makes no further request for an hour.

## Upload lifetime proposal and Solid integration note

The supplied review recommends a reservation lifetime in seconds of
`min(21600, 3600 + ceil(declared_bytes / 32768))`: one hour of interruption
allowance plus transfer time at 32 KiB/s, capped at six hours. A 500 MiB source
receives 19,600 seconds (5 hours, 26 minutes, 40 seconds). The reviewer
explicitly reserves ratification for the owner; these concrete values remain
a recommendation until that disposition is recorded in the execution record.
The current runtime still uses one hour.

The server computes and persists the reservation deadline once. Part URLs
remain valid for at most one hour, capped by remaining reservation life;
renewal never extends the reservation. Existing expiry columns suffice, but
reservation creation currently copies the gateway's URL expiry, so those
values must be separated in the application when the policy is implemented.
After reservation expiry, reopening must return the typed expiry outcome and
require source reselection rather than silently starting another upload.

Pair adoption with verified storage cleanup: either an incomplete-multipart
bucket lifecycle rule with an explicit few-day age, or a scheduled abort of
expired issued/claimed reservations with no manifest. Do not infer deployed
lifecycle configuration from a database deadline. A few-day lifecycle rule
provides eventual cleanup, not a six-hour storage-retention guarantee. A
scheduled abort must fence against finalize, tolerate an already absent
upload, retry failures durably and record completion only after storage
confirms it. Protect manifest-bearing/sealing work and its recovery identity.
Keep completed ingress-object cleanup distinct from incomplete-upload abort.

Acceptance must cover the size formula and hard cap, independent initial URL
expiry, exact renewal replay without deadline extension, typed expiry on
reopen, abandoned claimed uploads, cleanup retry and a finalize/cleanup race.
No lifecycle configuration or scheduled cleanup has been verified by this
recommendation checkpoint.

For Solid, single-part renewal after claim works on `8d3aef46`, not yet on
main or staging. The one-hour hard ceiling remains. A renewal racing finalize
can still return 500; treat it as ambiguous and re-read submission/reservation
state before retrying. Do not discard receipts or assume the upload failed.
This is an integration note for the active writer, not a claim of direct
notification or authorization to edit the Solid worktree.
