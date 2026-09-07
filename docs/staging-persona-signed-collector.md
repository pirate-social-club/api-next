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
