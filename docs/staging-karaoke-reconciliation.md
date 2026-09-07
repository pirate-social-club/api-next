# Staging Karaoke reconciliation evidence

This verifier composes evidence for the frozen six-object `staging-reset-v1`
inventory. It is read-only. It does not install or retire markers, authenticate
an operator, execute cleanup, fence database writes, or authorize deployment.
The owning rollout must provide those capabilities through separately reviewed
operator and reset-runner adapters.

## Trust boundary

`verifyKaraokeReconciliation` accepts a private evidence-store port. Its
`readCurrentAuthenticatedManifest` operation must authenticate the manifest's
provenance and supply fresh observations of the fence epoch, all six markers,
alarm cancellation, socket closure, and non-reuse of the old attempt keys. It
must include the complete ordered receipt history, including unsuccessful or
dirty passes. Parsing an uploaded JSON manifest is not an implementation of
this boundary. No live adapter is installed by this change.

Each artifact is a bounded JSON envelope containing its scope and data. The
scope binds namespace, object, generation, inventory digest, bucket, phase and
fence epoch. References must occur in the authenticated manifest and match the
SHA-256 of the exact UTF-8 artifact bytes. A digest alone establishes integrity,
not provenance. Store these artifacts privately; they contain internal object
and archive identifiers. Do not include assertions, credentials or audio.

The schema accepts canonical UTC timestamps with exactly three fractional
digits. Parsing rejects invalid calendar values, unknown fields, reversed
intervals and future observations. Provider adapters must normalize timestamps
to this representation without inventing observations.

## Admission and retention

Reset admission requires complete post-fence and pre-reset passes, a currently
verified unreleased fence epoch, and six active markers with no alarm or sockets.
Fence evidence requires denied ingress, fenced producers, denied runtime writes
and reconnection, and zero runtime sessions. The reset runner owns that positive
database proof. A guessed settle interval does not satisfy it.

Establish that database fence and session drain before the first post-fence
R2 pass, after ingress maintenance, fenced runtime deployment and all six
marker installations/readbacks. Reverify maintained fences for the pre-reset
pass. The word post-fence refers to the complete producer/database fence,
not solely installation of Durable Object markers.

The installation receipt remains immutable. Reset admission can be eligible
while `quiescenceEstablished` is false: verified external evidence composes with
that fact rather than replacing it. The result grants no provider capability.

Exact-key cleanup evidence contains exhaustive multipart pagination, before and
after object observations, and exact-key abort/delete outcomes. Failed or
truncated listings and bucket denial are not empty observations. Account-prefix
discovery never authorizes prefix deletion. A negative mapping requires both
absent authority and archive evidence plus retained-history evidence; missing
rows alone do not prove that an old key never existed.

Retention is observed stable only after a clean retirement pass and a clean
follow-up at least 24 hours after that pass ends, with release evidence and all
six markers retired. A pass that discovers and removes late audio is useful
cleanup but is not a clean stability observation. It requires a new clean
retirement baseline and another next-day pass. The authenticated manifest must
not omit the earlier finding.

Observed stability is the reviewed residual-retention disposition, not proof
that an arbitrarily delayed provider operation is impossible. The rollout may
finish with the linked next-day obligation pending; the fence task may not.
Production and any prefix-scoped object deletion remain outside this procedure.
