# Private runner collector protocol

The operator lane owns the private-store reader, Access authentication and CLI
into `verifyKaraokeReconciliation`. The reset-runner lane owns the executable
collector and its provider/SQL observations. The runner implementation is
assigned to the video coordinator following the former runner subagent's
usage-limit stop on 2026-09-07. No live collector or signing key is provisioned
by this document.

## Invocation

The verification CLI executes one independently configured, reviewed collector
bundle under the current Bun runtime, without a shell:

`bun run - collect-karaoke-reconciliation --run-directory <absolute-directory>`

The parent reads and hashes the configured bundle, then sends those exact
verified code bytes on stdin. This avoids a pathname replacement between
verification and execution. The bundle must be self-contained and not resolve
mutable local implementation imports or depend on its file location.

The operator configuration pins the SHA-256 of that executable bundle and an
Ed25519 collector public key. Neither trust value may come from the run
directory. The bundle must include its local implementation dependencies; its
digest is the `collectorSourceDigest` in the attestation. The signing private
key is supplied only through the runner's private operator environment, never
through artifacts, arguments or logs. Existing provider credential mechanisms
remain runner-owned. A signing key alone does not establish truthful evidence:
review the collector source and its actual provider reads before pinning it.

The environment variable `KARAOKE_COLLECTOR_CHALLENGE` contains a bounded JSON
challenge with version
`staging-karaoke-collector-challenge-v1`, a 64-hex random `challenge`,
`operatorSubjectDigest` (SHA-256 of the authenticated human Access subject),
`epoch` and `bucket`. There is no Access assertion in the child input. The
parent first verifies that assertion against independently configured issuer,
audience and subject. Child stdout/stderr are not evidence and are not logged.
The invocation has a sixty-second maximum; failure or timeout aborts admission.

The parent overwrites `KARAOKE_COLLECTOR_SOURCE_DIGEST` with the digest of the
verified stdin bundle and `KARAOKE_COLLECTOR_ACCESS_ASSERTION_FILE` with the
validated private assertion-file path. These override inherited values. The
collector independently checks that file's owner, permissions and absence of
symlinks before using its token as the Access cookie for HTTPS inspection.
No token goes in the challenge, artifacts or child arguments. The collector
must not send a client-authored `cf-access-jwt-assertion` header.

The concrete parent command is
`bun scripts/karaoke-reconciliation-cli.ts --config <private-file> --assertion-file <private-file>`.
Both files and the collector bundle must be outside the evidence directory,
owned by the operator, mode 0600 and free of symlinks/hard links. The config
schema is `staging-karaoke-operator-config-v1` in that CLI. It pins directory,
collector path/digest/public key, epoch, bucket, disposition digest, independently
retained per-object receipt history, and the existing Access operator bindings.
The signed-manifest reader calls the existing verifier and reports
`executionAuthorized: false`, even when reset admission is eligible. This is
not a database command. The child inherits the existing private operator
environment for provider credentials and its signing key; it must never log it.

## Output

The run directory is an existing private mode-0700 directory, owned by the
operator OS user. The collector writes mode-0600 regular files, no symlinks or
hard links. Content-addressed artifacts use `<sha256>.json`, with exact UTF-8
bytes hashed and a maximum size of 262144 bytes each. Previously retained
artifacts are immutable. No prefix delete or data mutation follows from this
collection command; it only collects or composes existing reconciliation
receipts and fresh readbacks.

Write `manifest.signed.json` last, atomically. It contains exactly `payload`
(a JSON string) and `signature` (128 lowercase hex characters, Ed25519 over
the exact UTF-8 payload). Payload is defined by `KaraokeCollectorAttestation`
in `scripts/karaoke-reconciliation-adapter.ts`: version
`staging-karaoke-collector-attestation-v1`, echoed challenge and subject digest,
collector bundle digest, canonical millisecond UTC `observedAt`, and the
existing exact `ReconciliationManifest`. The current collection must complete
within sixty seconds and its observation cannot predate the challenge.

The manifest carries all six exact targets, complete receipt history, all
scope-bound artifact references, and the owner's separately recorded residual
disposition. The operator independently pins that disposition digest and the
prior receipt history; the new manifest may append but never omit or reorder
that prefix. Do not issue a first-run empty-history trust configuration for an
inventory which already has retained passes.

## Facts the runner must actually establish

Read fresh marker state, alarm and socket state for every object using the
authenticated operator/DO boundary. Establish old attempt/key non-reuse from
the database and authority evidence. Derive `currentFenceEpoch` and
`releasedAt` from the runner's maintained ingress/database fence and actual
release records, including reconnect denial, inherited runtime-role privileges
and a drained session inventory. Missing observations prevent signing; never
copy these fields from submitted JSON or infer them from command exit codes.

Use the verifier's exact `FenceEvidence`, `ReleaseEvidence`, R2 observation and
scope envelope schemas. `runtimeIdentityFingerprints` is private supporting
evidence, not a field in `FenceEvidence`; project the exact fields before
encoding and prove the emitted bytes pass the real strict decoder. The
collector must not overwrite an installation receipt's false instance
quiescence value. R2 cleanup and maintained fences remain independently
authorized steps, not side effects of verification.

## Read-only inspection

The operator caller owns `POST /inspect`, with exact-Origin and JSON headers,
behind human Cloudflare Access. The edge supplies the assertion; the caller,
named entrypoint and object independently authenticate it. The exact request
is `KaraokeResetTarget`, with no `state` field. Targets are the frozen six only.
Do not follow redirects or fall back to `/command`.

The response is `KaraokeResetSnapshotSchema` in
`packages/platform-cf/src/karaoke-reset-inspection.ts`. It contains version
`staging-karaoke-reset-inspection-v1`, the four target fields, `observedAt`
(millisecond UTC), `markerState` (`absent`, `invalid`, `active` or `retired`),
nullable `initial`, `current`, nullable `authority` with only `accountId` and
`attemptId`, and nullable `installationReceipt`. Both observations use the
existing installation observation schema. The receipt is the original stored
fact, including false quiescence. Null means absent evidence, not malformed
evidence. Malformed stored authority/receipt fails the operation. Invalid
markers are reported as invalid and remain fenced.

Inspection has no install, cancel, close, retire, PostgreSQL or R2 operation.
It reads existing storage only, including the no-table case, and does not
establish external quiescence or key non-reuse. Non-200 responses fail
collection. The collector must retain raw readbacks and derive its manifest
from them and the runner's authenticated journal, not re-sign caller booleans.

The existing DO constructor is unchanged: first activation of an unfenced
object can initialize its local business schema before any RPC. An already
fenced object skips that initialization, including the no-table regression.
Do not infer historical storage non-deletion from an inspection or from table
presence. Live reconciliation requires installed markers and separate history
evidence; an absent-marker snapshot cannot admit a reset.

## Outstanding producer integration

The runner coordinator owns the non-test signing collector, including fresh
provider-backed ingress and database reconnect-denial observations, retained
history and key non-reuse. Observation-normalization helpers are not those
collectors. The operator lane implements read-only inspection and the private
store adapter/CLI. No reset admission, release descendant or live window is
claimed until those implementations and fresh proofs are reviewed.


## Initial journal command

The runner's default collector also accepts `record-karaoke-fence
--run-directory <private-directory>` through the same verified-stdin boundary.
The dedicated `scripts/staging-karaoke-record-fence-cli.ts` selects it only with
`--record-fence`. It records fresh,
authenticated provider and SQL observations locally and returns no reset
execution authority. Its private configuration begins with a null retained
journal head, empty baseline IDs and empty six-object pass history. The parent
validates the signed resulting head and challenge, then returns the six baseline
IDs for independent retention. Initialization refuses an existing journal.
The collector checkpoint document records the two-write interruption boundary
and the still-unimplemented pass/reset/release command integration.


## Observation passes

The default stdin program accepts `record-karaoke-pass` under the same private
configuration and authenticated challenge protocol. The dedicated pass CLI
supplies only the closed phase post-fence or pre-reset. R2 credentials remain in
the child environment and must be separately scoped to the learner-audio staging
bucket. The child observes rather than cleans. Signed scoped artifacts retain
both R2 reads, the original installation receipt, SQL non-reuse observation,
fence readbacks and challenge. Each journal append checks the exact current
head; the parent verifies the six-entry extension and challenge, then runs the
real reconciliation verifier. This does not add a reset or release command.

## Cleanup pass

The default stdin program also accepts `record-karaoke-cleanup
--run-directory <private-directory>` through the verified-stdin boundary, with
the dedicated `scripts/staging-karaoke-record-cleanup-cli.ts` as its explicit
parent. Cleanup runs only in the post-fence phase: it is the authorized way to
remove exact-key remnants that an observation pass recorded as incomplete, and
the pre-reset pass must still observe empty afterward.

The child reuses the admission, fence, marker, non-reuse and history checks of
an observation pass, then for each of the six frozen objects observes the bucket,
cleans, and observes again. Actions derive from the verified before-observation
only: the cleaner aborts exactly the observed uploads of the exact
`karaoke/<account>/<attempt>.pcm` key and deletes that key only when its head
was present. Adjacent keys sharing the prefix are never removal authority. Each
action retains its provider response receipt, including status and request ID.
A failed or unexpected provider response records a `failed` action and an
`incomplete` receipt rather than a silent retry; a response lacking a request
receipt aborts the command because the evidence cannot be constructed
truthfully.

Cleanup requires two separately scoped credential pairs in the child
environment: the observer's read pair (`KARAOKE_COLLECTOR_R2_ACCESS_KEY_ID` /
`KARAOKE_COLLECTOR_R2_SECRET_ACCESS_KEY`) for before/after evidence, and a
cleanup pair (`KARAOKE_CLEANUP_R2_ACCESS_KEY_ID` /
`KARAOKE_CLEANUP_R2_SECRET_ACCESS_KEY`) that signs only the delete-side
requests. A read-scoped pair cannot clean, and the cleanup pair never signs an
observation.

Evidence durability precedes mutation. Before any provider write the pass
retains a durable content-addressed intent artifact naming the exact key,
observed upload IDs and head state; after every single attempt it retains the
attempt result as it happens, including an `uncertain` outcome when a request
was sent and no verified response receipt exists. These sidecars are fsynced
mode-0600 files in the private store even when the journal never advances, so
timeout, later-target failure, lost fence, concurrent advance or process death
cannot erase the action history. Re-observing an empty bucket never
reconstructs that evidence. Recovery is still a fresh pass over actual state;
an upload already gone at abort time is retained as a `not-found` action.

Phase eligibility is checked before any mutation: cleanup refuses while any
target's latest receipt is beyond post-fence, so a backward transition cannot
mutate R2 before the verifier would reject it. The parent verifies the six
signed pass entries and challenge exactly as for an observation pass, and
every result still denies reset execution authority.

## Reset, retirement and release origins

The journal's `reset-verified`, `all-retired` and `released` entries originate
only from authenticated commands that re-verify the journal through the real
reconciliation verifier before appending, under the same challenge protocol,
exact-head append guard and sixty-second bound as every other entry. A signed
observation or an `executionAuthorized: false` result is never execution
authority: none of these commands performs a reset, retirement or release.

`recordKaraokeResetVerification` admits only when the verifier finds all six
targets pre-reset complete under a maintained fence, then retains the trusted
reset-executor completion (server version, terminal migration, ledger digest
and exact zero persona counts with an evidence digest) plus fresh fence, six
marker inspections and after-reset SQL non-reuse readbacks. The completion port
has no live binding yet: wiring it to the phased executor's verified output is
part of the live ceremony composition, and a caller-supplied completion shape
remains refused.

`record-karaoke-retirement` (with `scripts/staging-karaoke-record-retirement-cli.ts`)
originates `all-retired` from fresh readbacks of all six retired markers under a
maintained fence, after the verifier confirms retirement-phase completion for
every target. A marker that regressed to active refuses the milestone.

`recordKaraokeFenceRelease` originates `released` in three durable stages,
every stage an Ed25519-signed sidecar bound to this ceremony's epoch, bucket,
residual disposition and journal predecessor. Intent observes the last held
fence and retains that proof before the trusted binding runs. Execution
evidence is retained immediately after the binding performs or verifies the
release. Recovery is selected from an authenticated pending intent before any
fence observation — the concrete collectors throw when fencing is absent, and
an observation error is never proof of release — and the pending intent is
passed explicitly to the read-only reconciliation port
(`reconcileReleasedFence`), which never executes again. The port returns an
explicit intent-bound disposition — released, positively verified
not-executed, or unresolved — and only a durable, signed not-executed
disposition permits one fresh execution under full admission checks; a held
fence alone is never such a disposition. Timeouts, malformed evidence and
persistence failures remain unresolved and never re-execute, because signing
and artifact persistence stay outside any outcome handling. A sidecar must
hash to its content-addressed filename, carry the pinned key's signature, and
reference a predecessor inside this journal, so fabricated, modified and
cross-ceremony records refuse. The actual release time postdates the
retirement milestone and the intent's held-fence proof — not entries a
concurrent writer may have signed after the release — so lost responses,
later appends and read-only reconciliation recover together. Journal entries
keep monotonic recording timestamps while every manifest derives its
operational `releasedAt` from the authenticated release evidence, and the
verifier requires exact agreement with that time. The release port has no
live binding yet; recording cannot perform a release.

Invalid pending-intent fence facts refuse before any current fence read.
Fresh execution accepts only a new ceremony or an authenticated not-executed
disposition. The recovery scanner admits not-executed records through the same
signature, digest, scope and lineage checks as intents and execution records.
Their intent closures survive interruption before fresh admission; restarting
does not require reconciling an already closed intent again. Original intent
and disposition files remain retained after recovery.

## Retirement and follow-up passes

The observation pass accepts the closed phases `retirement` and `follow-up` in
addition to post-fence and pre-reset. Retirement-phase passes require retired
markers and retired installation receipts, verify after-reset SQL non-reuse,
and run while the journal is reset, retired or released. A follow-up pass
requires a recorded release; before release the pass refuses rather than
fabricating release evidence. Post-release receipts cite the historical
retained fence and release evidence and never claim that normal writes remain
disabled. The verifier enforces the genuine 24-hour boundary between the last
clean retirement baseline and any follow-up pass, and a follow-up that arrives
early is refused before any journal append.
