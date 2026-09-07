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
