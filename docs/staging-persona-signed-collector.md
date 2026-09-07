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
