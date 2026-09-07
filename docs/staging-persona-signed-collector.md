# Signed collector implementation checkpoint

This tranche provides the default, read-only collector entrypoint and its
private signed-journal storage. It does not establish a live fence or complete
the runner task. No provider setting, Worker deployment, marker, source object
or staging database was changed. Video remains disabled.

## Execution and trust

Build one self-contained stdin program with
`rtk proxy bun scripts/build-karaoke-collector.ts --output <new-private-absolute-file>`.
The build refuses external implementation imports and unresolved dynamic
imports. Node and Bun runtime modules remain runtime dependencies. PostgreSQL's
optional native binding is explicitly unavailable. Imported diagnostic mains
are disabled at build time; only the collector argument protocol executes.
The existing operator CLI still hashes and executes the verified bytes on
stdin, authenticates Access and invokes the real reconciliation verifier.

The child receives its private configuration path through
KARAOKE_LIVE_COLLECTOR_CONFIG. Its strict schema is in
scripts/staging-karaoke-collector-config.ts. It references the private operator
configuration, signing-key file, inspection origin, journal directory, retained
journal head, residual-disposition file, six baseline artifact IDs and independently reviewed maintenance
pins. Configuration, assertion, bundle and signing key must remain outside both
evidence directories. The child rereads the private files and verifies the
bundle digest. It independently authenticates Access before provider reads.
No credential is written to output, a journal artifact or an argument.

The journal is a signed hash chain with an independently retained head. Evidence
files are content-addressed, immutable and mode 0600 in an owned mode-0700
directory. Writes are anchored to an open directory descriptor. A writer lock
is exclusive; an abandoned lock is not automatically removed. Replacing the
signed head is atomic. Invalid ordering does not advance it. A broken fence
cannot return to held in the same epoch; reset verification must precede
retirement, and retirement must precede release. The journal preserves every
per-object pass and rejects rollback below the independently retained prefix.
Cryptographic validity alone does not establish the truth of an observation.

The signer derives its manifest from retained scoped passes, fresh object
inspection and fresh key non-reuse checks. It retains those readbacks, runs the
actual reconciliation verifier before signing, and rejects journal changes
while collecting. Missing, stale or failed observations never replace the
previous signed manifest. Original false installation quiescence is retained.
Even an eligible result carries executionAuthorized=false.

## Concrete readers

The maintenance composition reads the ingress fence first, then the reviewed
Worker deployments, Cloudflare producer controls, external service snapshots
and the database fence. All four queues must be paused. Cron lists must be
empty. Every Workflow instance page is read, including paused and waiting
instances; only complete, errored and terminated are admitted. Workflow class
and owning script must match the fixed staging inventory. The video Workflow
is included when registered, even while its product flag is false.

External snapshots use authenticated SSH with host-key checking on the three
already inventoried hosts. The remote read-only program hashes merged unit
configuration, environment files, live process identity and independently
selected deployed source files. It checks process-to-unit cgroup identity and
rereads unit properties. A held service must be inactive and masked with no
remaining process in its unit cgroup. Every snapshot must match its separately
reviewed source/destination pin twice. New observations cannot select their own
accepted pins. The known production provisioner remains outside staging stop
authority; this reader has no stop, restart or mask command.

SQL non-reuse binds the old account and attempt to immutable session and
recording identity. Before reset that identity must match its retained baseline.
After reset the attempt and exact key must be absent from sessions, recordings
and learner-audio artifacts. Cross-account rows and key aliases fail closed.
Null authority requires retained authenticated non-deletion history; a missing
current row or empty inspection is not that history.

The R2 observer has only GET and HEAD. It verifies the fixed staging bucket
before and after each exact-key observation, exhausts multipart pagination,
retains adjacent-prefix entries without authorizing their deletion, and rejects
missing markers, malformed XML, DTDs, wrong prefixes and missing provider
request identifiers. Its XML parser is pinned to fast-xml-parser 5.11.1. This
reader is ready for pass production; the signing command consumes retained
passes rather than performing cleanup.

Ingress and deployment reads each have a fifteen-second ceiling, Cloudflare
producer reads twenty seconds, each R2 observation fifteen seconds, and each
SSH invocation twenty seconds with a remote fifteen-second alarm. External
hosts are read concurrently, twice each. The parent imposes sixty seconds on
the whole collection. A slow collection is refused; no individual limit
extends that admission window. Status inventory and per-object SQL reads are
scaling limits to measure during the live proof.

## Verification and live observations

The initial composed check exposed a stale Config reference after extracting
the shared operator schema, then a type-only import. Both were corrected before
the passing check. Repository check subsequently passed with the unchanged
41 warnings and two informational diagnostics. The self-contained bundle test
executes the real stdin program and confirms that missing live configuration
produces only its expected denial, without running imported diagnostic mains.
The positive signing tests use fixture observations and the real journal,
private writer, Access verifier, signed adapter and reconciliation verifier;
they are not live provider evidence.

The PostgreSQL 17 non-reuse, database-collector and session-drain suites passed:
10 tests, 31 assertions, exit 0. The disposable local database used one CPU,
512 MiB and a temporary data filesystem and was stopped immediately afterward.
The dependency audit passed with the existing accepted moderate uuid advisory
and below-threshold elliptic observation; no new policy action was required.
The changed-script check passed with zero findings.
The serial ordinary command passed with 3,458 unit tests, 20 Node tests and
179 Workerd tests, exit 0. The main Workerd configuration used its one-worker
setting; the smaller configurations used their existing pool settings. No Bun,
Node, Workerd or PostgreSQL process remained after the run. No full PostgreSQL
baseline gate or required remote CI is claimed by this checkpoint.

Read-only staging target binding succeeded on September 7 at
08:25:12.143Z against database mvydkmmwh5x4, branch syu03e00w3ux and Hyperdrive
8cb7658a0f7143359c1becfec6a15c23, with caching disabled. This was identity
verification only. The provider reports PostgreSQL 18.6. The current operator
credential has neither pg_read_all_stats nor pg_monitor; therefore it cannot
satisfy the retained full-visibility drain guard. No unidentified session was
present in that read, and the earlier refused PID remains unattributed.

The cached Cloudflare credential returned 403 for organization and user reads.
The Access application inventory was readable and empty. No issuer or exact
human subject was inferred, and no Access policy was changed. The configured
browser connection could not find its Chrome executable; no new browser was
started. A request for an existing authenticated browser or private operator
configuration/assertion path remains pending.

## Remaining runner work

The default signer and authenticated initial fence/baseline recorder are
implemented. The commands which originate reconciliation-pass, reset and
release journal entries still need integration with the maintained-fence runner. Do not seed
those entries from fixtures or re-sign submitted booleans. External source and
destination classification must finish before its pins can be provisioned.
The operator identity, private signing configuration, reviewed runtime versions
and sufficient session visibility are not yet available. No default live
collection or sixth restore has run.

The final rehearsal must exercise a video-capable API/Solid descendant pair,
separately from the original ba0fd445/0119 reset artifacts. Complete replay,
interrupted replay/recovery, reviewed live fencing/reset and the at-least-24-hour
retention follow-up remain gates. Synthetic and real video publications follow
the completed reset; they cannot be interleaved with it. This checkpoint does
not waive any of those gates or close the execution task.


## Initial fence recording

The explicit `--record-fence` command in
`scripts/staging-karaoke-record-fence-cli.ts` reuses the operator CLI launcher and invokes the
verified stdin bundle's `record-karaoke-fence` command. It authenticates Access
in both parent and child, requires an initial configuration with no journal head
and no baseline or pass history, and verifies the separately retained owner
residual disposition. The default composition reads the actual ingress-first
maintenance fence, all six authenticated object snapshots and each object's
target-bound PostgreSQL identity. Every positive fence property and freshness
must be proved. A null authority is refused until an independent non-deletion
history adapter exists; current emptiness does not manufacture that evidence.

Only after all six observations succeed does the recorder append signed begin
and fence-observed events. It retains the random parent challenge, original
snapshots including false quiescence, and six immutable identity baselines.
The parent verifies the resulting journal and challenge rather than accepting
stdout as success. Repeated initialization cannot replace the existing journal.
An interruption between the two head writes remains an unestablished journal
for explicit recovery; it does not grant reset authority. The returned head
and baseline identifiers must be retained outside the journal before normal
collection. There is no marker installation, bucket cleanup, reset or release
operation in this command.

The new tests exercise authenticated recording with provider-bound doubles,
real private files and the real signed journal. They cover refusal before any
journal head on wrong subject, wrong challenge, a failed fence, missing
authority or unavailable SQL. The positive case retains six snapshots with
false quiescence and refuses repeated initialization. The first test run failed
because the older fixture used a generic bucket; the fixture was corrected to
the fixed staging bucket without weakening production admission. These are
local tests, not live fence evidence.

A metadata-only September 7 inspection of all folders in the staging Infisical
project found no additional Cloudflare Access/operator credential. The existing
operator folder contains the PostgreSQL operator and runtime URLs only among
the relevant credential classes. Secret values were not printed or copied.


The initial integration check failed when the new command pulled the full Node
collector into the Worker-binding type-check graph. The recording CLI is now a
separate entrypoint sharing only the verified-byte launcher with the verifier
CLI. A dedicated persona-collector TypeScript gate was added to the ordinary
check command; it covers the default bundle, recording CLI and associated
tests. It exposed three previously unchecked type errors in the retained reader
code: the stream reader's required Bun extension, a TextDecoder encoding alias,
and an ingress-plan literal widening. They were corrected without changing
provider admission or runtime pins. The full check then passed with the same
41 warnings and two informational diagnostics.


Final local fence-recorder gates passed: check, 3,460 unit tests, 20 Node tests
and 179 Workerd tests, each exit 0. The ordinary test command's constituent
suites were run serially; every Vitest invocation explicitly used maxWorkers=1
and fileParallelism=false at nice level 10. The Workerd HTTP suite emitted its
expected negative-path exception diagnostics while all 73 tests passed. No
fresh PostgreSQL baseline, remote CI, default live recorder, restore or reset
result is claimed. The source remains an implementation checkpoint, not the
rehearsal gate requested for video.


## Observation-pass integration and database-version boundary

The explicit `scripts/staging-karaoke-record-pass-cli.ts` accepts post-fence or
pre-reset observation passes. It reuses the authenticated recording context
and verified-stdin launcher. The child obtains fresh maintained-fence, six
object inspections and SQL non-reuse observations through the same concrete
readers as the signer. Its R2 reader makes only bucket HEAD, multipart GET and
exact-key HEAD requests. It verifies the fence again after the reads and calls
the existing reconciliation verifier before recording any pass. A present
object or exact-key upload produces incomplete, never an invented cleanup
receipt. Adjacent-prefix objects are retained as evidence but are not counted
as the target or authorized for deletion.

The journal append now supports an exact-current-head compare-and-set under
its existing writer lock. Pass recording uses it for every appended entry, and
the initial fence's second entry uses it as well. The independently retained
prefix remains the rollback boundary; it is no longer confused with the exact
head required for a write. Partial pass recording retains any accepted prefix
and grants no reset authority. The parent requires exactly six new signed
entries, the same challenge and requested phase, fresh timestamps and the real
verifier's acceptance of the complete chain. An exit code alone is insufficient.
Original false quiescence remains unchanged, including when pre-reset becomes
eligible. The result still carries executionAuthorized=false.

The private child additionally needs KARAOKE_COLLECTOR_R2_ACCESS_KEY_ID and
KARAOKE_COLLECTOR_R2_SECRET_ACCESS_KEY with read access to the fixed staging
learner-audio bucket. These are prerequisites, not newly provisioned values or
authorization to reuse the ingress-bucket credential. No credential enters a
journal artifact or command argument. The command does not abort uploads,
delete objects, install or retire markers, execute the reset, or release a
producer. Cleanup, reset/release-origin integration and post-retirement passes
remain to be connected before this runner is complete.

The namespace identifier, generation and frozen inventory digest now come from
the installation module in both fence recording and signing. No namespace,
inventory or runtime pin changed. The dedicated collector type-check now also
covers the pass recorder and its parent verifier. This exposed previously
untyped R2 helper uses of a DOM-only BufferSource name and TextDecoder alias;
the byte-input type now comes from the actual crypto API signature, without
copying potentially large request bodies, and decoding uses utf-8. The R2
fetch port describes only its invoked request operation rather than requiring
Bun's unrelated preconnect extension.

Staging was observed running PostgreSQL 18.6 on September 7. The video migration
and composed PostgreSQL evidence retained so far is from PostgreSQL 17. This
is an explicit compatibility validation gap, not proof of incompatibility and
not evidence of an observed upgrade event. The authorized rehearsal and video
window must record the actual server version with the release SHAs, applied
migration ledger and query/fixture results. A PostgreSQL 17 local pass does not
close the 18.6 staging obligation. Neither database privileges nor Access
configuration has been supplied, and no live provider operation or rehearsal
was performed for this checkpoint.


The observation-pass focused suites passed through the real signed journal,
real R2 observer with a fake HTTP transport, Access verification with fixture
keys, and both child and parent reconciliation verification. They prove clean
post-fence to pre-reset progression, retained false quiescence, incomplete
object/multipart remnants, adjacent-prefix exclusion, a changed journal, a lost
final fence, missing authority, wrong operator, wrong challenge and expired
parent evidence. The exact-head journal test proves that a stale writer cannot
replace a concurrent advance. No actual R2 request was sent by these tests.

The expanded TypeScript check initially rejected DOM-only crypto types,
inferred target literals and the test transport's missing Bun preconnect
extension, then an optional method in a test assertion. Those were corrected;
the collector type-check and repository check passed afterward. No broadening
of runtime input acceptance was used to silence them. The final repository
check retained 41 existing warnings and two informational diagnostics. The
ordinary unit suite passed 3,466 tests and 16,010 assertions, exit 0. This
checkpoint changes no SQL statement or migration, and claims no new PostgreSQL
17/18 provider acceptance or remote CI run.


The serial Node and Workerd constituents also passed: 20 Node tests and 179
Workerd tests, exit 0. Every Vitest invocation explicitly used one worker and
disabled file parallelism at nice level 10. Expected negative-path HTTP and
stream-cancellation diagnostics were retained in the logs; no test failure was
reclassified as success. No owned test process remains. Other lanes' existing
development servers were neither stopped nor claimed as this task's cleanup.
Script-check and whitespace verification passed with zero findings.


Cleanup-pass checkpoint — 2026-09-07. The default stdin program accepts
record-karaoke-cleanup through the same verified-stdin boundary and challenge
protocol; scripts/staging-karaoke-record-cleanup-cli.ts is its explicit parent.
Cleanup runs only in the post-fence phase. For each frozen object it observes,
cleans and re-observes. The cleaner (scripts/staging-karaoke-r2-cleaner.ts)
derives every action from the verified before-observation: it aborts exactly
the observed uploads of the exact karaoke key and deletes that key only when
its head was present. Adjacent keys sharing the prefix are never removal
authority, and the action list is empty when nothing was observed.

Each action retains its provider response receipt with status and request ID.
A non-2xx/404 delete-side response records a failed action and an incomplete
receipt instead of a silent retry. A response without a request receipt aborts
the command because truthful evidence cannot be constructed; the same boundary
exists in the read-only observer. The pass preserves the initial and final
maintained-fence checks, challenge retention, exact-head append guards and the
real reconciliation verifier, and its result still denies execution authority.
The parent reuses the pass attestation verifier with the fixed post-fence
phase.

The child requires the observer's read credential pair plus a separate cleanup
pair (KARAOKE_CLEANUP_R2_ACCESS_KEY_ID / KARAOKE_CLEANUP_R2_SECRET_ACCESS_KEY)
that signs only delete-side requests. Neither value is provisioned here, and a
read-scoped pair cannot clean.

Focused tests passed through the real signed journal, real observer and
cleaner with a fake delete-capable transport, and fixture Access keys. They
cover cleaned-to-empty progression with retained neighbor uploads, not-found
abort recovery, mismatched observation refusal, wrong operator and absent
authority refusal before any bucket action, a lost final fence after
successful actions with recovery from actual provider state, preserved failed
attempts followed by a completing retry, a concurrent journal advance refusing
appends without discarding history, and a broken fence refusing cleanup. No
actual R2 request was sent by these tests. The collector type-check and
touched-file Biome checks passed. Reset, retirement and release journal-origin
commands, post-retirement and next-day passes, actual rehearsal and live
fencing remain unfinished; no live provider operation occurred.


Milestone-origin checkpoint — 2026-09-07. The reset, retirement and release
journal origins are implemented and tested. A shared helper
(scripts/staging-karaoke-journal-manifest.ts) composes the signed journal into
the reconciliation manifest and runs the real verifier; every origin command
admits only from the state that verifier establishes, then appends one signed
entry under the challenge protocol, exact-head guard and sixty-second bound.

recordKaraokeResetVerification admits only when the verifier finds all six
targets pre-reset complete, retains the trusted completion evidence
(staging-karaoke-reset-completion-v1: verifiedAt, serverVersion,
terminalMigration, ledgerDigest, exact zero persona counts,
personaEvidenceDigest), a fresh maintained fence, six active-marker
inspections and after-reset SQL non-reuse. The completion must postdate the
last signed entry. recordKaraokeRetirementCompletion (wired as
record-karaoke-retirement with its dedicated CLI) originates all-retired from
fresh retired-marker readbacks after verifier-confirmed retirement passes; a
regressed marker refuses it. recordKaraokeFenceRelease originates released
from the trusted fence-release binding, observing the last held fence
in-command so fence evidence cannot postdate release, independently reading
back all six retired markers, and writing the journal entry at the release
evidence time.

The observation pass now accepts retirement and follow-up phases: retired
markers and installation receipts, after-reset non-reuse, and a follow-up that
requires a recorded release and cites the historical retained fence and
release evidence instead of a fresh fence claim. The verifier's genuine
24-hour boundary rejects an early follow-up before any append.

The reset-completion and fence-release ports have no live bindings yet; wiring
them to the phased executor and the maintained-fence release is part of the
live ceremony composition and remains recorded work. Recording a milestone
never executes it, and every result still denies execution authority.

Focused milestone tests passed through the real signed journal, real
verifier, fixture Access keys and a fake R2 transport: the full ceremony from
fence through 24-hour follow-up with observed-stable retention, the 24-hour
and recorded-release requirements, reset admission/zero-count/state guards,
and retirement/release state and marker guards including a regressed marker.
Adjacent suites (observation, cleanup, fence, signing, journal, adapter, CLI)
reran green. The collector type-check and touched-file Biome checks passed.
No live provider operation, rehearsal, reset or release occurred.


Review-fix checkpoint — 2026-09-07. Independent source inspection of the two
prior checkpoints found two cleanup defects and an unresolved release-recovery
design; all three are corrected here, and the earlier "complete" wording is
withdrawn. Correct status: cleanup and milestone recording are implemented as
checkpoints; cleanup interruption safety and concrete reset/release
integration remain unfinished.

Cleanup evidence durability now precedes mutation. Before any provider write
the pass durably retains a content-addressed intent artifact (exact key,
observed upload IDs, head state); after every single attempt it retains the
result as it happens, including an "uncertain" outcome when a request was sent
without a verified response receipt. These fsynced sidecars survive timeout,
later-target failure, lost final fence, concurrent journal advance and
process death even when the journal never advances; re-observing an empty
bucket can no longer erase the action history. A phase-eligibility guard now
refuses cleanup while any target's latest receipt is beyond post-fence, so a
backward transition cannot mutate R2 before the verifier would reject it. A
regression proves cleanup after pre-reset admission performs zero provider
writes, and another proves interrupted cleanup retains durable intent and
action sidecars before recovery.

The release origin is now three durable stages: intent (last held-fence proof
retained before the binding runs), execution (evidence retained immediately
after it), and recovery readback (the retry completes from the retained record
without a held fence or a second binding invocation, preserving the actual
release time bounded after the all-retired milestone). New tests cover
successful release followed by inspection failure and by append failure; both
recover with the preserved release time in the signed journal entry. Distinct
retained releases refuse recovery as ambiguous. The concrete reset/release
composition remains unfinished source work: the completion and release ports
still have fixture bindings only and must be bound to independently verified
target identity, approved release/checksum pins, exact ledger and executor
evidence with server version, SQLSTATE and failing-stage retention, without
accepting supplied success claims.


Second review-fix checkpoint — 2026-09-07. A further inspection found three
release defects in the first review-fix checkpoint; all three are corrected
here and the narrower completion claim is adopted for cleanup too.

Uncertain execution now recovers: when a signed release intent exists, no
executed record does, and the fence can no longer be observed held, the
command reconciles read-only against an intent-bound observation port
(reconcileReleasedFence) and never invokes the executing binding again.
Recovery evidence is authenticated: every release sidecar is Ed25519-signed
with the pinned collector key, must hash to its content-addressed filename,
and must bind this ceremony's epoch, bucket, residual disposition and a
journal predecessor inside the current lineage; an executed record must
reference its signed intent. Fabricated unsigned records, bytes renamed under
a foreign digest, and correctly signed cross-ceremony records each refuse.

Journal timing separates recording time from actual release time: the
released entry is stamped at recording time, preserving monotonicity even
when a concurrent writer signed after the actual release, while the signed
release evidence preserves the actual release time. The shared verifier now
accepts a release-evidence time at or before the recorded release instead of
requiring equality; its fixture needed no change. A test exercises an actual
later-timestamped append and proves sorted, monotonic history after recovery.

Cleanup sidecars now carry explicit attribution: every attempt records its
intent artifact digest and an attemptedAt timestamp, and the stale
immediate-append function comment is corrected. Automated reconciliation of
retained cleanup sidecars into later passes remains unfinished and is not
claimed. Concrete reset/release bindings also remain unfinished source work.


Third review-fix checkpoint — 2026-09-07. A third inspection found the
uncertain path unreachable with the concrete fence readers, the uncertain
branch still bounded by the last journal entry, and the verifier still using
recording time as the operational release boundary. All three are corrected.

Recovery selection now precedes any fence observation: an authenticated
pending signed intent is the only uncertain-execution trigger, it is passed
explicitly to the read-only reconciliation port, and a throwing fence reader
no longer blocks recovery (tested). A refuted reconciliation falls through to
the normal held-fence path, and a pending intent without a reconciliation
binding surfaces a distinct unresolved error. The uncertain branch's lower
time boundary is now the retirement milestone, matching retained-execution
recovery, so a lost response plus a later concurrent append plus read-only
reconciliation recover together (tested, with monotonic history).

The manifest's operational releasedAt now derives from the authenticated
release evidence inside the released entry — in the journal-state helper, the
observation pass, the signing collector and the pass verifier — never from
the entry's recording timestamp, and the shared verifier again requires exact
agreement with that time. A missing release-evidence artifact in a released
entry refuses. Delayed recording therefore classifies receipts by the actual
release time, and conflicting earlier evidence times cannot satisfy the
comparison. Concrete reset/release bindings remain unfinished source work;
automated cleanup-sidecar reconciliation also remains unfinished and
unclaimed.


Fourth review-fix checkpoint — 2026-09-07. A fourth inspection found that a
failed reconciliation could fall through to another execution. Corrected: the
reconciliation port now returns explicit intent-bound dispositions (released,
positively verified not-executed, unresolved). Only a durable signed
not-executed disposition closes a pending intent and permits one fresh
execution under full admission; a held fence alone never does. Timeouts,
malformed evidence and artifact-persistence failures remain unresolved —
signing and persistence sit outside any outcome handling — and each of the
three cases is tested to invoke the executing binding zero times while the
fence reads held. A pending intent without a reconciliation binding is
rejected before any fence reader runs. Concrete reset/release bindings and
automated cleanup-sidecar reconciliation remain unfinished.

Release disposition correction — 2026-09-07. Invalid signed pending intents
now refuse before any current fence read or release execution. Fresh execution
explicitly accepts only fresh or positively resolved not-executed state.
The scanner uses one record-kind check for both discovery and admission, so
signed not-executed records undergo the same scope and lineage checks and
remain effective after restart. Interruption after the disposition is durable
but before fresh admission no longer reopens the closed intent.

Three regressions failed against 6b05edad before the correction: invalid
intent execution, lost closure on restart, and ignored foreign-lineage
not-executed evidence. All three pass after the correction. The shared
milestone fixture and recovery refusal tests were extracted so the original
milestone suite is below 600 lines. The adjacent five-suite run passed 38
tests with 4,654 assertions before the final test-only extraction.

Final repository check passed with the existing 41 warnings and two
informational diagnostics. The ordinary test constituents passed serially
at nice 10: 3,495 unit tests with 20,115 assertions, 20 Node tests and
80/73/2/9/15 Workerd tests. Every Vitest invocation used one worker with
file parallelism disabled. The harness retained its missing-RPC-secret
warnings, HTTP denial diagnostics and video stream-cancellation diagnostic;
all suites exited zero. Collector type-check, touched-file Biome,
changed-script enforcement and whitespace checks passed.

This corrects the two reviewed source defects. Concrete live reset/release
bindings and automated cleanup-sidecar reconciliation remain unfinished.
No new PostgreSQL 17/18.6 or remote CI acceptance, provider mutation,
rehearsal, reset or release is claimed.

Cleanup-history integration — 2026-09-07. Cleanup intent and attempt sidecars
are now signed with the pinned collector key and bind the exact journal
predecessor, target scope and residual disposition. Cleanup and observation
passes authenticate discovered history before acting and carry the exact
signed originals into their new evidence sets. Current bucket emptiness still
comes only from fresh provider reads. An uncertain response stays uncertain;
an intent without an attempt result is not promoted to a successful action.

Original files are retained. Unsigned older sidecars require explicit review,
not automatic re-signing. Bad signatures, digest changes (including a renamed
record kind), foreign lineage and broken intent/action attribution refuse.
Tests exercise interrupted cleanup through a later pre-reset pass, lost abort
responses, unsigned and foreign-lineage history, and hidden-kind tampering.
This adds authenticated audit-history carry-forward, not a new provider
operation. Concrete live reset/release bindings remain unfinished.

Verification passed: repository check with the existing 41 warnings and two
informational diagnostics; final unit suite 3,499 tests and 20,258 assertions;
Node 20 tests; Workerd 80/73/2/9/15 tests; collector type-check, touched-file
Biome and changed-script enforcement. Checks ran at nice 10 and every Vitest
invocation used one worker without file parallelism. An HTTP Worker invocation
was mistakenly started before the preceding suite exited, interrupted with
exit 130, then rerun serially to its passing 73-test result. No PostgreSQL or
remote CI gate was run for this checkpoint. No live provider mutation occurred.

Executor handoff correction — 2026-09-07. Parent pass admission and attestation
now use the phase's actual journal state: held for post-fence/pre-reset,
reset or retired for retirement, and released for follow-up. The previous
unconditional held-state check made the last two CLI phases unusable. A
full-ceremony fixture exercises the parent verification for all four phases;
its advanced test clock is not a live 24-hour observation.

The phased executor now emits completion facts from its admitted SQL
connection after the existing full verification: actual server version,
schema identity, exact 119-entry checksum ledger, reviewed artifact digests,
and zero persona-evidence counts. Its process-owned completion reader rejects
copied result objects, overlapping reads and reads after release verification
starts. A failed read retains the failed reset marker. This is an internal
handoff, not a durable signed completion command or a live admission path.

Fresh-fence callbacks receive the executor's actual transaction identity and
whether final reset verification has succeeded. The transaction-safe drain
reader never starts or rolls back that transaction, and still excludes only
its own connection. The standalone observer retains its existing behavior.
No post-reset ACL exception, extra-session exemption or release operation is
introduced. The maintained database collector and authenticated reset/release
commands still need concrete composition; this checkpoint does not claim it.

A local instrumented PG17 replay refused an active autovacuum worker under
the unchanged all-other-sessions guard. It passed after autovacuum was disabled
only in the task-owned disposable local server. This is diagnostic evidence,
not authority to suppress provider sessions or change a staging setting. The
ordinary executor regression checks the transaction handoff; the separate
drain suite checks admission. Provider session classification remains a
rehearsal prerequisite. SQLSTATE retention now also handles the actual Effect
migration error's sqlState field without emitting its label or driver text.

The executor now has a persistent type-check project included by the existing
collector gate. It uses the repository's normal application type environment;
the collector's smaller environment cannot type-check the migration runner's
full application imports correctly. Strict optional-property checking also
identified and corrected an explicit undefined policy argument in grant
restoration without changing its grant semantics.

Local verification passed 11 PostgreSQL reset/recovery and drain tests with
2,039 assertions, 3,501 unit tests with 20,461 assertions, 20 Node tests and
179 Worker tests. All heavy checks were serial at nice 10, with one Vitest
worker and no file parallelism. The local server was PostgreSQL 17.11 with
25 connections, 64 locks per transaction and prepared transactions disabled;
the drain suite therefore exercised its prepared-transactions-disabled case,
not a newly enabled two-phase transaction case. The temporary containers and
their scratch volumes were removed after fixture databases were dropped.
No PostgreSQL 18.6, remote CI or live end-to-end acceptance is claimed.


Reset-binding checkpoint — 2026-09-07. The concrete reset binding exists as
source: scripts/staging-karaoke-reset-binding.ts binds the journal origin's
completion port to readCompletedStagingReset, so only an execution object
this process actually completed can supply completion evidence — submitted
JSON, a matching literal or a foreign execution refuses inside the executor.
The origin-level refusal is tested with the journal unchanged; the executor
pg suite already proves the owned readback (server version, pinned terminal
migration, zero persona counts, ledger) and the spread-copy refusal. The
binding lives in the executor type environment, which is why it is checked by
the executor project rather than the collector's smaller one. The concrete
release OPERATION — performing and independently verifying the approved fence
release across ingress, producers and database writes — remains unfinished
source work; the origin's intent/execution/recovery contract and its explicit
dispositions are the interface it must satisfy.


Release-operation checkpoint — 2026-09-07. The concrete release operation
exists as source. scripts/staging-karaoke-release-operation.ts validates a
strict reviewed restoration plan (ingress application, queue resume list,
serving worker versions, reviewed grant digest), refusing an incomplete plan
before any mutation and naming the missing decision. Surfaces restore in
fixed order — ingress, producers, database — through thin executor ports the
live composition binds to the collectors' authenticated transports; every
attempt reports through onAttempt so the caller retains authenticated,
intent-bound evidence before and after. A failed surface leaves the result
unresolved with its completed receipts; the operation never retries and the
release time is the last confirmed surface restoration. An explicit
released-state observation path answers restored/fenced/uncertain per
surface without weakening held-fence validation.
scripts/staging-karaoke-release-binding.ts is the thin binding: it closes
over the plan, surfaces, observers, evidence store and signing readers,
exposes the origin's verifyFenceRelease/reconcileReleasedFence ports, and
owns no disposition logic — unresolved operations throw to the origin, and
reconciliation requires three authenticated retained receipts for a release
time, never reconstructing it from current state. Composition tests prove
success across surfaces, an uncertain surface leaving the journal retired
with no second execution, interruption between surfaces recovering through
read-only reconciliation without re-execution, and all-fenced reconciling as
not-executed. The remaining gap to live use is binding the surface executor
ports and released-state observers to the actual provider transports, and
obtaining the reviewed serving-version restoration values; the reviewed
grant digest and queue identities already exist in recorded approvals.

Release-claim correction — 2026-09-07. The preceding operation checkpoint is
historical, not the current acceptance statement. Fenced surfaces with no
receipts never prove non-execution. Only the durable exclusive cancellation
claim can support that disposition. Surface order is a required reviewed
plan field, not the historical code default. The strict schema is now actually
decoded before attempts, including duplicate-target refusal.

The origin now signs the plan digest and a unique intent nonce. Its executing
and reconciling bindings receive that signed intent's content digest, and the
evidence store authenticates the referenced intent before granting a claim.
Both file and directory fsync precede a grant; independent-process tests cover
execution/cancellation races and interruption at each persistence boundary.
The earlier implementation opened the directory but did not fsync it.

A cancelled intent remains permanently closed. A fresh intent can proceed
only by referencing its signed not-executed disposition and atomically
replacing the exact cancelled claim under the journal lock. Both old and new
claim bytes are archived before replacement. Tests cover successor races,
process death with the lock retained, and successful fresh execution through
the real origin. No interrupted lock is automatically removed.

Successful operations independently observe ingress, producers and database
restoration before producing a release result. Provider transports, live
stdin/runtime wiring and parent verification remain unfinished source work.
The confirmation-time versus operational-release-boundary contract remains
open, as do exact-SHA independent review and the recorded live prerequisites.
No provider mutation, rehearsal, deployment or enablement occurred.

Release-claim verification receipt — 2026-09-08. The final local unit gate
passed 3,532 tests with 22,437 assertions. Node passed 20 tests and the five
Worker constituents passed 80, 73, 2, 9 and 15 tests. All heavy gates ran
serially at nice 10, with one Vitest worker and file parallelism disabled.
The final repository check passed with the existing 41 warnings and two
infos; script-check reported zero findings across ten changed script files.
PostgreSQL 17, PostgreSQL 18.6, remote CI and independent review were not run
for this checkpoint. Publication is not claimed.

The control-plane task check observed 422 valid records and zero warnings.
Its checkout concurrently contained unrelated active-writer edits, so the
runner's authoritative task-record update remains pending rather than racing
that writer. These product-local notes preserve the implementation receipt.

Live transport composition still needs an exact approved ingress reversal,
not merely an Access application ID: removing a reset-created application
and restoring a pre-existing policy are different security changes. Neither
was selected or executed here. The approved surface order, serving-version
pins, private Access configuration and session-visible database connection
also remain gates. Missing configuration does not close the unfinished
transport, command-wiring or release-timestamp contract work.

## Concrete release transport composition

The release stdin command is `record-karaoke-release`. Its parent is
`scripts/staging-karaoke-record-release-cli.ts --config <private-file>
--assertion-file <private-file> --release-fence`. It uses the pinned collector
bundle from an api-next checkout as the working directory, so the immutable
approved Git artifacts can be read independently of the stdin module location.
It uses the operator assertion path exactly like the other recording commands.
The parent requires a fresh challenge, approved plan digest, one signed
released journal entry and the real reconciliation verifier. An exit code
alone never establishes release. All results retain executionAuthorized false.

`KARAOKE_LIVE_RELEASE_CONFIG` points outside both evidence directories to a
private `staging-karaoke-live-release-v1` file. It carries the release plan,
approvedPlanDigest and restoration directives. The plan's restorationDigest
hashes the schema-decoded restoration object; approvedPlanDigest hashes the
schema-decoded plan, both through JSON.stringify and SHA-256. Shape and a
self-consistent digest are not owner approval: use the exact recorded approved
values. The live composition requires database, producers, ingress order and
the same ingress application and queue identities as the maintained fence.

Database restoration reuses the approved privilege compiler and catalog-safe
grant executor, checks the complete runtime-reachable grant digest including
PUBLIC and SET ROLE paths before commit, then proves it on an independent
connection. It restores CONNECT only to the independently bound runtime role
under the explicit restoreRuntimeConnect directive. The private restoration
input binds targetBindingDigest. Failure evidence retains internal stage and
SQLSTATE without driver messages or credentials.

Producers restore the four reviewed Worker versions before resuming the four
named staging queues. Mutation responses and independent deployment IDs must
agree; two queue scans must agree. Ingress supports an explicitly reviewed
policy restoration or removal of the exact reset-created application. Both
require complete inventory and exact configuration digests. Neither choice is
inferred from current state or selected by this source checkpoint.

Each surface refuses to produce a receipt without proving its effect. Signed
surface evidence retains the bounded provider proof alongside its digest.
Transport errors are never restored state. The live observer may report fenced
only after the existing complete maintained-fence collector succeeds.

The clock distinctions and remaining independent-review question are in
`staging-karaoke-release-time-contract.md`. No source-level time claim approves
rehearsal. The concrete private values, verified Access pointer and
session-visible database connection remain live prerequisites. No live command
or provider mutation is authorized by these implementation notes.

## Reset-to-release integration hold

Concrete transport wiring exposed an existing incompatible grant contract.
`executePhasedStagingReset` calls `verifyFinal(true)` in its final replay batch,
restores reviewed runtime grants, and subsequently requires those grants in
`verifyApprovedStagingRuntime`. In contrast, `observeMaintainedDatabaseFence`
requires schema_access, table_access, sequence_access and definer_access all
false. `recordKaraokeResetVerification` invokes that real fence reader before
the owned completion binding, and retirement and release admission use it too.
Consequently a successfully reconstructed runtime grant set cannot pass these
journal admissions. Correct Access configuration and session visibility do
not resolve this source-level contradiction.

This hold is separate from the private configuration prerequisites. Resolving
it changes the reviewed reset-to-release grant handoff: retaining the existing
ACL-denial fence requires keeping runtime grants denied through reconstruction
and deferring restoration to release, including treatment of migration/default
grants and completion verification. Alternatively, a different phase-specific
fence needs explicit review; CONNECT denial must not be silently substituted
for the current collector contract. No such semantic change is made here.
The concrete CLI is not admitted for rehearsal or live use until this is
resolved and the exact resulting source has independent review.

Checkpoint verification on 2026-09-08: repository check passed with the existing
41 warnings and two infos; both persona type-check projects and changed-file
script-check passed. The final unit run passed 3,548 tests with 22,849 assertions
at nice 10. Node tests passed 20 and the five serial Worker suites
passed 80, 73, 2, 9 and 15. The new local PostgreSQL grant-readback test passed.
The full PostgreSQL 17.11 run did not complete: the general suite reached its
900000 ms limit and reported `general PostgreSQL suite failed with exit 143`.
This is not PostgreSQL acceptance and provides no PostgreSQL 18.6 evidence.
Publication, remote checks and independent review remain pending. The local
test database was stopped; no live provider mutation or rehearsal occurred.
The control-plane record update was deferred because unrelated records in
that checkout were being edited by another writer.
