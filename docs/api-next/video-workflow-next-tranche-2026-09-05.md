## Terminal sweep checkpoint, 2026-09-05

Final validation passed with exit zero: 19 focused PostgreSQL tests (180
assertions), `bun run check`, and the full ordinary test suite (2981 Bun,
20 Node and 133 Workerd tests). Script-check reported zero findings across
three changed configuration files. Named tests, command exit statuses and
log digests are retained in `evidence/video-execution-2026-09-05/resolution-stage-facts-sweep-validation.json`;
raw logs remain temporary. The full PostgreSQL gate is deferred to PR preparation.

Terminal reconciliation now executes under the submission row lock and observed
event sequence. Unaccepted submitting or started attempts enter required with
workflow_terminal evidence and an atomic retry prohibition. With no attempt,
the submission receives the ordinary technical failure. All five accepted
stage facts leave the submission unchanged for the decision fence.

Initial attempt creation takes the same submission lock and rejects a failed,
superseded or source-mismatched parent. Existing attempt reads remain available
for reconciliation. This serializes the no-attempt failure against allocation;
a PostgreSQL test proves that allocation after that failure is rejected.
The focused suite also covers unaccepted started work, all five accepted facts,
and an event-sequence change during Workflow inspection.

One terminal category needs disposition before runner dispatch is complete:
allocated-only work, or partially accepted facts with no unconfirmed encode.
The sweep returns deferred and leaves the submission untouched. It does not
label such work as provider failure. A terminal Workflow ID cannot be reused;
the proposed recovery is a distinct durable analysis continuation retaining the
same creation revision, attempt identities and accepted facts. The alternative
is explicit operator recovery. Neither policy is activated by this checkpoint.
The owner was asked to choose while independent validation continued.

The first focused run exposed SQL parameter inference ambiguity; explicit casts
fixed it. The first full ordinary suite exposed the new stage-facts import
missing from Workerd's explicit aliases; those aliases are now included in the
three affected harness configurations. No contract, schema, Workflow binding,
provider credential or enablement change is included.

## Stage-fact checkpoint, 2026-09-05

The application now validates closed snapshots for probe, audio, frames,
recognition and safety. Persisted envelopes retain the stage, adapter revision,
snapshot and sealed artifact receipts. Audio and frame receipts carry digest,
size and content type; their references and hashes must match the snapshot.
The store reloads submission authority under a row lock, fences its event
sequence and revisions, and shares its immutable insert with reconciliation.
Identical canonical-JSON digests replay successfully; divergent winners fail.

The reader validates every envelope. Derived-bucket recovery verifies its
receipts by HEAD and rejects missing objects or mismatched digest, size or
content type. This proves recovery of an accepted fact, not recovery from a
seal that committed before the fact did; the runner must close that separate
window before its acceptance claim. No schema amendment was necessary.

Validation passed with exit zero: six application validator tests (17
assertions), 21 combined publication PostgreSQL and artifact-recovery tests
(149 assertions), and `bun run check`. The initial check exposed a formatter
second-pass change and a test assertion type mismatch; both were fixed.
The public contract and enablement remain unchanged.

## Resolution checkpoint, 2026-09-05

`resolveAttemptReconciliation` now locks and event-sequence-fences the submission,
checks the creation-bound attempt, and resolves completion or confirmed failure.
Completion inserts a first-winner stage fact with a canonical JSON digest match
on replay; a divergent winner rolls the entire transaction back. Unresolved
Workflow termination keeps the attempt required and the retry prohibition set.
The prohibition is cleared only after no pending or required attempt remains.
A prior confirmed failure survives another capability's later completion.

The publication PostgreSQL suite covers completion with a persisted probe fact,
confirmed failure, unresolved Workflow termination, multiple attempts, stale
sequence rejection, and divergent-fact rollback. Application-level per-stage
validation is the next commit; the resolution operation is not composed or
exposed to callers yet. No schema or contract changed. `bun run check` passed;
the focused PostgreSQL exit status is recorded at the preservation checkpoint.
The full PostgreSQL gate remains due at pull-request preparation, as instructed.

## Reconciliation review disposition, 2026-09-05

Validation for this pending-state correction: the publication PostgreSQL suite
passed eight tests and 92 assertions. `bun run check` and `bun run test` passed
on rerun. The initial check found a formatting error, corrected before rerun;
the initial unit suite failed the existing Megapot request-pacing timing test.
No timing assertion was changed. The full PostgreSQL suite was not rerun for
this branch-only correction; its preceding persistence checkpoint has separate
full-suite evidence. No migration, public contract or enablement changed.
The control plane had unrelated writer changes during this checkpoint, so this
note is retained here pending serialized task-record integration.

Pending reconciliation is an attempt-only observation. It preserves the submission
snapshot and event sequence, leaving an analysis submission processing. Escalation
to required atomically fails the submission and prohibits retry. A subsequent
pending observation cannot downgrade required or clear that prohibition. The
publication PostgreSQL test now exercises both pending and that no-downgrade rule.

Required reconciliation remains an activation blocker until the public contract
can truthfully distinguish an unconfirmed provider submission from confirmed
provider failure. The proposed reason is `provider_submission_unconfirmed`, with
`retryable: false`; client copy should say that processing needs verification,
not that encoding failed. This is a proposed contract disposition, not a ratified
waiver or a released client change. The reviewed transition must carry exact
operation-scoped breaking-change exceptions against its pull-request base under
`docs/api-next/openapi-breaking-change-waivers.md`, coordinated with delivery's
client release. Generic probe/transform failure copy is not accepted for staging.

Resolution is still unimplemented. Its transaction must lock and fence the same
submission and attempt, retain uncertainty evidence, and accept only authenticated
confirmed completion or failure. Completing one attempt must not clear another
attempt's unresolved prohibition. Once all uncertainty is resolved, confirmed
completion resumes analysis without spending an author retry; confirmed failure
restores the ordinary failure and retry policy. A validated, creation-bound stage
fact must be recoverable before the runner proceeds. The acceptance test must
exercise required reconciliation through resolution and accepted stage fact,
including a rollback and a stale event-sequence write. Neither an enum value nor
a database constraint supplies this behavior by itself.

The real-fetch Workerd status API regression test is already present in
`tests/workerd-http/video-workflow-status-runtime.test.ts` from `914ef07b`.
Workflow class/bindings, resolution, durable runner and composed fault-injection
acceptance remain open; the video path stays disabled.

# Video Workflow next tranche

## Attempt reconciliation and stage storage — 2026-09-05

Control-plane decision 1a5ffa728d928f904626b86374e95af992567598 authorizes
amending the unmerged, unapplied 0120 before the pull request. The lane's
ordinary inventory at edit time was 0110 through 0119 plus its reserved
0120_video_workflow_execution.sql; no later file was present. The existing
refusal guards remain. Checksums, schema baseline and reset inventory were
regenerated. No migration was run against a deployed environment.

The attempt owns reconciliation_state, first_uncertainty_at, last_observation
and reconciliation_evidence_ref. States are none, pending, required and
resolved; uncertainty requires an allocated provider identity in submitting
or started, a structured observation and private evidence. The submission
snapshot now carries reconciliationRequired. The reconciliation store updates
the attempt and submission under one transaction and the observed event
sequence, retaining the original uncertainty time. A failed snapshot write
rolls the attempt back. It refuses attempts from another lineage or an already
accepted capability. Reconciliation writes submission-unconfirmed evidence and
a processing_failed snapshot with retryable false. Both retry commands and
the projection enforce the snapshot fact; no public reason field was added.

Historical snapshots missing the fact decode false because 0120 refuses
historical attempts; malformed values fail closed. A database constraint also
requires a true snapshot fact to agree with the non-retryable failure columns.
The new media_video_stage_facts table keys immutable accepted JSON snapshots
by submission, video revision, creation revision and stage, retaining analysis
and adapter revisions. Its SQL bounds and first-winner behavior are tested.
Stage-specific validation and the runtime fact writer/reader remain pending;
a table alone is not accepted-stage execution evidence.

Seventeen focused PostgreSQL tests passed with 124 assertions. The migration
case initially exposed PostgreSQL CHECK's null semantics: a JSON null status
could pass an incomplete predicate. Explicit JSON type checks now reject that
case. The transaction fault injection asserts SQLSTATE P0001 at the snapshot
update and proves the earlier attempt write rolled back. Both direct retry
store calls are tested, including a poster-specific failure with the separate
uncertainty fact retained. Existing publication and attempt drills also passed.
Full check and ordinary test commands passed. The first full PostgreSQL run
failed only because the foundation's explicit table list omitted the new
stage-facts table. After correcting that inventory, all 14 foundation tests
passed and the full command passed on rerun: 35 isolated and 343 general cases.
The [validation inventory](evidence/video-execution-2026-09-05/reconciliation-validation.json)
records command outcomes, summaries and log digests; raw temporary logs are
not archived. Script-check found no issues. The local secret-boundary audit
found no violations before preservation.

The runner and sweep do not yet call the new reconciliation transaction. The
next tranche must route terminated instances with unresolved provider attempts
to it, implement safe resolution without clearing another attempt's retry
fence, and enforce authority when persisting provider submission intent. The
current attempt advance still fences its attempt binding, not the submission's
current status under a shared row lock. Before enabling effects, test an old
creation paused before submitting while an author retry advances creation:
the old writer must be refused before issuing another provider start. The
runner must recover a sealed result after R2 succeeds and the fact write fails;
sharing a durable step does not make those effects atomic. The existing seal
method HEADs a deterministic R2 key before fetching bytes, but observe first
requires provider status/output descriptors, and probe metadata is only read
from a temporary URL. The recovery drill must remove those descriptors and
URLs too; an R2 HEAD-only success fixture does not establish complete recovery.
Publication-only
replacement instances must use a distinct logical identity and the same
publication executor, skipping capability work when retained analysis matches.
The class, bindings, provider composition and drills through the real
entrypoint remain open. Video analysis remains disabled.

## Workers redirect correction — 2026-09-05

Preserved as 914ef07ba49db615be61545a2fb98caadef99199. The
[record amendment](evidence/video-execution-2026-09-05/workers-redirect-record.patch)
was applied in control-plane commit 1a5ffa7 and is historical; do not reapply.

The previous authenticated lookup passed redirect error to global fetch.
A new Workerd test using the real Request/fetch path and a local network stub
reproduced the runtime rejection before the stub was reached: Invalid redirect
value, must be one of follow or manual. The transport now uses manual and
rejects every status except 200 or the existing, separately verified 404 path
before decoding a response. Redirects are never followed. Both Workerd cases
then passed, including a redirect target that receives no request or token.
Twenty-three focused unit/composition/config tests passed with 122 assertions.
Full check and test commands passed, including all 133 workerd tests. The
local secret-boundary audit found no violations across the seven changed
files; script-check reported no findings and one size advisory. No PostgreSQL
suite was repeated for this transport/config correction.

Both staging Wrangler files now declare VIDEO_WORKFLOW_READ_TOKEN under
secrets.required and the account, Workflow name and script variables. The
reserved pair is pirate-video-analysis-staging on
pirate-media-processor-worker-staging. The entrypoint must export exactly
VideoAnalysisWorkflow, matching the authenticated parent check. The later
runner binding contract must assert that same name/script/class combination
across every environment. The video flag remains false; these declarations
do not create the Workflow or provision its read credential.

This is a new Cloudflare API credential held by two Workers. The requirement
is a dedicated token scoped to Workflow reads only, with no write, deployment,
R2 or account-administration access. The current public Workflow and instance
read API documentation lists Workers Scripts Read and Workers Tail Read as
accepted read permissions, not a dedicated Workflows Read permission. Do not
claim the stronger scope exists or silently substitute broader read access.
Before activation, verify the available scope and obtain an explicit owner
disposition if the provider cannot enforce the requested restriction. Token
creation, addition to the staging Infisical inventory and installation on both
Workers are separate authorized mutations, still pending. Inventory evidence
must record the permission/resource scope and consumer names, never token
bytes. No Infisical or Cloudflare mutation occurred in this correction.

The local interpreter's ambiguous-start policy remains interim. Observation
returns not_found for an unstarted or absent task and the interpreter reports
pending without issuing another start. At the stored runtime deadline the
adapter returns runtime_exceeded, currently mapped to generic probe_failed or
transform_failed with generic failure evidence. That is not proof that the
provider rejected or stopped the job, and is not the requested durable
reconciliation state. The runner must persist distinct submission-unconfirmed
evidence tied to request, creation revision, capability and attempt; retain
the task identity and prevent an author retry from allocating another encode
until reconciliation proves a safe outcome. This correction does not alter
those local-interpreter semantics or claim the reconciliation drill complete.

## Authenticated absence checkpoint — 2026-09-05

Both concrete Worker compositions now use an authenticated read fallback when
binding inspection throws. A structured instance 404 establishes absence only
after a second read verifies the configured Workflow name, script and class.
Authentication errors, rate limits, server failures, malformed or oversized
responses, unknown statuses and a mismatched parent fail closed. Successful
instance reads must carry the expected logical effect identity. Requests use
a fixed API origin, reject redirects and share a five-second timeout.

The fallback follows the [instance read API](https://developers.cloudflare.com/api/resources/workflows/subresources/instances/methods/get/)
and [Workflow read API](https://developers.cloudflare.com/api/resources/workflows/methods/get/).
The structured-404 plus verified-parent rule is this application's recovery
policy; it does not assume a stable binding exception message or error code.
Both Workers require VIDEO_WORKFLOW_ACCOUNT_ID, VIDEO_WORKFLOW_NAME,
VIDEO_WORKFLOW_SCRIPT_NAME and the VIDEO_WORKFLOW_READ_TOKEN secret when video
analysis is enabled. Provisioning and live absence proof remain outstanding.
No authenticated Cloudflare request was made for this checkpoint.

Twenty-three focused tests passed with 98 assertions, including the actual
media-processor composition recovering a thrown binding lookup through fake
HTTP responses. Full check passed. The first full test run failed on two
unchanged Self Pass five-second timeouts; that group passed on an unchanged
rerun, and a subsequent full test command passed, including all 131 workerd
tests. Script-check had no findings and one file-size advisory. The local
secret-boundary audit found no violations. PostgreSQL tests were not repeated
for this transport-only change; the adapter checkpoint's two real-store tests
remain its database evidence.

Control-plane commit 5b911bb411de4331491ebe84eb81d20b8bdba4f2 consolidates the
launch, sequence-fence and adapter checkpoints. The older launch-checkpoint
and recovery-sequence patch files are historical and must not be reapplied.
The adapter split is preserved as 803f850180404d1cd756095d0a39b2f6ced19867.
The granular runner, Workflow class and bindings, publication wakeups, source
grants and concrete analysis providers remain pending. Video stays disabled;
this checkpoint is not staging readiness or end-to-end publication evidence.

## Adapter boundary checkpoint — 2026-09-05

Qencode now exposes allocate, submit and observe on the application-owned
video transform port. Allocate returns a task without issuing a grant; submit
requires persisted submitting and refuses allocated before any effect;
observe never starts a task and reports not_found for an unstarted or absent
job. Existing capability-specific entrypoints delegate to observation only.
Grant-store errors escape as infrastructure failures. Output validation and
immutable sealing remain shared, with creation revision added to artifact
paths so a poster retry cannot reuse the previous creation's sealed output.

The old runTransform helper is removed. The local interpreter persists each
phase before its corresponding effect and no longer converts unknown
attempt-store failures into author-visible media failures. Its initial runtime
fence is created separately when each capability begins; loadOrCreate retains
that capability's original fence on replay. This local interpreter is not a
durable Workflow runner and is not called by Queue consumption.

Thirty focused adapter/interpreter/composition/FFmpeg tests passed. Both
PostgreSQL attempt tests passed 23 assertions, including drill 1 with a real
store: accepted start response lost, persisted submitting restored, status
observed and promoted to started with one start call. Full check and test
commands passed. Script-check reported no findings. No full PostgreSQL gate,
live Qencode job, deployment or rebase ran for this checkpoint. Granular
Workflow steps, bounded reconciliation, publication wakeups and authenticated
Workflow absence recovery remain to be composed and tested.

## Recovery review follow-up — 2026-09-05

Preserved as `66f6bc7bcdd091a999e62c66984fbce905cdaaed`. The
[record amendment](evidence/video-execution-2026-09-05/recovery-sequence-record.patch)
was consolidated by control-plane commit 5b911bb and is historical; do not reapply.

Failure writes now require the observed submission event sequence, exposed by
the PostgreSQL record loader. Both sweep recovery and Queue launch exhaustion
pass that sequence. The store checks it under its row lock and in the update
predicate, preventing a terminal observation from overwriting a concurrent
decision/publication transition. A PostgreSQL test advances the event during
status inspection without changing creation, video or analysis revision and
proves that the stale failure is refused. All six publication repository tests
passed after the fixture also advanced updated_at as required by the trigger.
The full check and test commands passed. After adding an explicit affected-row
assertion to the fenced write, TypeScript and all six PostgreSQL tests passed
again. The full PostgreSQL gate was not rerun for this focused follow-up.
No live provider query, deployment or rebase occurred.

The suggested existing missing-instance classifier is only a type alias;
both concrete song and video compositions pass an always-false function.
There is no verified production classifier to import. The current official
local binding still catches every status exception and rewrites it to
instance.not_found. Matching that message would not prove absence. A verified
production exception contract or an authenticated explicit-absence lookup is
required before changing this boundary; live lost-launch recovery is not
accepted. No speculative classifier was installed.

The Workflow class and VIDEO_ANALYSIS_WORKFLOW declarations in both Wrangler
files remain pending the runner tranche. Enabling the flag currently fails
construction; binding-contract tests must require every environment binding
when that class lands. The recovery scan performs up to its bounded batch of
status lookups each tick and rotates rows; larger volume will need measured
scheduling rather than assuming this polling cost is free. Queue redeliveries
can reach the DLQ while an expired launch awaits the sweep. Operators must
consult current PostgreSQL state: those transport messages can remain after
successful recovery and do not independently prove submission failure.

The adapter split and runner have not changed in this follow-up. Preserve
per-capability deadlines on attempts and allow only decide-and-publish to call
acceptTrustedVideoAnalysis. Allocate/submit/observe and their real-store tests
remain the first runner change.

## Launch checkpoint validation — 2026-09-05

Source checkpoint `82926a28c250e59e1832439a7b2c25873c941cf9` preserves this
tranche. The [checkpoint record patch](evidence/video-execution-2026-09-05/launch-checkpoint-record.patch)
was consolidated by control-plane commit 5b911bb and is historical; do not reapply.

The final `bun run check` passed. `bun run test` passed 2,959 unit, 20 Node
and 131 workerd tests. Earlier runs exposed an obsolete FFmpeg test that still
expected Queue delivery to execute analysis, and missing package exports and
workerd source aliases. Those were corrected before the successful full run.
The local secret-boundary audit found no violations across 40 changed files;
script-check reported no findings and one existing size advisory.

The full `bun run test:postgres` command exited 1: the isolated partition
passed, and the general partition reported 336 passes and one failure. The
catalog comparison used physical column ordinals, which retain a gap after
0120 drops the old column; a normalized baseline cannot retain that gap.
The comparison now checks visible column order while retaining all schema
attributes. The entire foundation suite then passed 14 tests, and verification
of all isolated run-specific sentinels passed. This continuation does not
change the failed full command's exit code; remote PostgreSQL CI remains owed.

The [validation inventory](evidence/video-execution-2026-09-05/launch-validation.json)
preserves sentinel contents, command outcomes and log digests. Raw logs remain
under the recorded temporary paths and are not archived. The
[record amendment](evidence/video-execution-2026-09-05/launch-only-record-amendment.patch)
already landed as control-plane commit 05e6e820 and must not be reapplied.
No rebase, push, provider call or deployment occurred.

## Launch-only conversion — 2026-09-05

The Queue consumer now launches a deterministic Workflow and never calls the
old analysis interpreter. The outbox uses a short launch lease and separate
launch attempts, markLaunched, retry-wait, exhaustion and missing-instance
facts; defer and completion are removed. A create response lost after
acceptance converges through createBatch on redelivery. Database errors after
create remain database failures rather than consuming the failed-create path.
Before exhausting three failed create calls, inspect the existing instance:
three lost responses do not prove three rejected launches. Unknown lookup
errors leave reconciliation pending rather than permitting an unsafe retry.

Recovery reloads PostgreSQL authority first, then checks instance status.
Confirmed missing instances become eligible for Queue dispatch; terminal
instances without an outcome record transform_failed with the exact observed
Workflow status in private evidence. An expired launch claim is reconciled
under its old fence after inspection, without incrementing the counter or
creating an instance. The bounded scan rotates observed rows so the first page
of long-running instances cannot starve later work. A failed final outcome
write or lost exhaustion fence remains recoverable. The jobs tick invokes
this recovery before dispatch; full class/Binding registration remains part
of the runner composition tranche.

The PostgreSQL terminal drill reproduced two existing failure-writer defects:
SQLSTATE 42703 for the missing failure_evidence_ref column, then SQLSTATE 23514
for media_post_submissions_shape because required failure metadata was absent.
The unmerged 0120 now includes the private evidence column; its checksum and
baseline were regenerated. Failure writes now include retry metadata and the
last safe phase. They also fence creation, video and analysis revision, so an
old launch cannot fail a newer attempt. This necessary publication-store fix
precedes, and does not implement, the later transactional publication wakeups.

Ten focused PostgreSQL cases passed after these repairs, including missing
and terminal recovery, the expired launch completion fence, and the migration
guards. A composed makeMediaProcessorQueueWorker test uses the real launcher
adapter with a fake binding that accepts create and loses its response. This
is the launch half of drill 3, not publication/encode acceptance.

Production absence classification remains an explicit proof gap. The
[Workers API](https://developers.cloudflare.com/workflows/build/workers-api/#get)
documents a missing-instance exception without a distinct stable error shape.
The inspected [local SDK binding](https://github.com/cloudflare/workers-sdk/blob/main/packages/workflows-shared/src/binding.ts)
maps any status exception to instance.not_found, so that emulator message alone
does not distinguish transport failure from absence. Keep the production
classifier fail-closed until authenticated absence evidence is verified. Fake
missing/terminal tests establish repository behavior, not that live exception
contract. No provider, deployment or staging operation ran for this tranche.

## Latent adapter/store mismatch at 6bd80bf9 — 2026-09-05

Tip 6bd80bf9 is intentionally inconsistent at the submit boundary. The real
attempt store rejects allocated directly to started. Qencode resumeJob still
issues the grant and starts the provider from allocated, then returns started;
the analysis caller tries to persist that forbidden transition after the
external effect. Its broad capability catch converts the repository error
into probe_failed or transform_failed. Neither the analysis fake store nor
adapter-only tests exercise this composition. Keep it disabled; green unit
tests do not prove safe submission at this tip.

The first runner commit must split the adapter into allocate, submit and
observe operations. The runner durably persists submitting before submit.
Recovery from submitting observes status without blindly submitting again.
Separate provider/media outcomes from repository failures: a transient
database error must retry the durable operation, not become an author-visible
terminal media failure. Prove the boundary with the real attempt store and a
fake provider before enabling composition. The launch-only conversion is
independent and must not execute this old analysis path. Rebase again only
at PR preparation, with a fresh migration inventory.

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
