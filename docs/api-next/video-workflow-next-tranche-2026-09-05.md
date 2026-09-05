# Video Workflow next tranche

This records the supplied checkpoint review and the resulting implementation
order for `api-video-execution-completion`. It is a proposed control-plane
amendment, preserved in the owned worktree while another writer has dirty
control-plane records. It does not reserve a migration number, change a wire
contract, or enable a provider.

The prepared [execution-record amendment](evidence/video-execution-2026-09-05/execution-record-amendment.patch)
passes `git apply --check` against the current control-plane record. Recheck
applicability and writer ownership before applying it; the check is not an
authority handover. It includes the final PostgreSQL qualification and the
Solid integration note.

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

The inspected main and three other api-next worktrees end their ordinary
migration inventory at 0119. The HNS deployment worktree is clean and its 0119
file is already present on main. Thus 0120 is the next observed candidate,
not an established reservation. Recheck all active migration writers and
record ownership before adding it; the current video worktree predates newer
main commits and needs a checked integration base.

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

Propose a reservation lifetime derived from declared byte length and a
conservative throughput floor, plus a fixed interruption allowance, clamped
between a minimum and a hard maximum measured in hours. One-hour renewable
part URLs are capped by remaining reservation life. The throughput floor,
allowance and maximum require owner disposition; this note selects no values.
The server computes and persists the deadline once. Renewals cannot extend it;
cleanup must cover expired multipart uploads and ingress objects. Existing
expiry columns suffice.

For Solid, single-part renewal after claim works on `8d3aef46`, not yet on
main or staging. The one-hour hard ceiling remains. A renewal racing finalize
can still return 500; treat it as ambiguous and re-read submission/reservation
state before retrying. Do not discard receipts or assume the upload failed.
This is an integration note for the active writer, not a claim of direct
notification or authorization to edit the Solid worktree.
