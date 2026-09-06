# Staging Karaoke reset fence

This lane implements the runtime boundary owned by the control-plane task
`api-staging-karaoke-reset-fence`. It does not authorize a database reset,
deployment, object cleanup, or production mutation.

## Implemented boundary

The constructor reads `karaoke:staging-reset-marker:v1` inside its concurrency
barrier before initializing business tables. Only an absent value allows
business initialization. Every present value denies work, including malformed
markers and markers for a different object or generation. Denial does not
depend on an environment flag.

A fenced alarm cancels its alarm and returns before database or bucket access.
Fenced recovery returns a terminal `fenced` result. Fetch, WebSocket callbacks,
initialization, authority reads, and producer helpers deny business work.
The pure marker protocol validates exact identity and permits active-to-retired
transitions without any clearing or reactivation operation.

The focused Workerd suite exercises actual Durable Object storage and the
runtime class with active, retired, and malformed stored values. It checks
that business tables are not initialized, alarm cancellation persists, and
Hyperdrive and R2 bindings are not accessed. Repeated alarm invocation models
queued delivery, but is not evidence of a live deployment or eviction test.

## Remaining execution boundary

The named service entrypoint `KaraokeResetOperatorEntrypoint.apply` accepts
an Access assertion and an exact inventory command. It has no HTTP route.
Both the entrypoint and the object verify the assertion using the existing
Cloudflare Access signature, issuer, audience and expiry validator, then
require the configured exact subject. Neither authentication nor installation
uses PostgreSQL. The object independently checks its actual ID against the
command, frozen inventory and generation before observing or writing storage.

Admission requires `API_NEXT_ENV=staging`, `KARAOKE_RESET_ENABLED=true`, and
explicit `KARAOKE_RESET_ACCESS_ISSUER`, `KARAOKE_RESET_ACCESS_AUDIENCE` and
`KARAOKE_RESET_ACCESS_SUBJECT` settings. Missing settings deny admission.
No deployment enables these settings in this change. The release review must
pin their operator identity and service-binding caller; no ordinary browser
session or active-user lookup substitutes for an Access assertion.

The object atomically stores the marker and original observation before
cancelling alarms or closing sockets. It persists the returned receipt,
including outbox states, prior alarm state, archive key and multipart upload
identifier. Replaying the operation preserves its original observation and
returns a new current observation; retirement cannot reactivate an object.

Installation must also account for producer work already in flight. A marker
does not undo an external request already issued. Successful quiescence must
not be reported while an earlier producer can still finish an R2 or database
effect. Cancellation failure must leave the marker effective and must not
produce a successful cleanup receipt.

All six receipts require verification before any exact-key R2 cleanup or
database reset. The two approved runtime release descendants must carry the
same protocol; the migration artifact and Solid pin remain independently
fixed by the rollout record. Neither cross-release verification nor live
installation has occurred in this implementation checkpoint.

## Required rollout order

Raise and verify HTTP ingress maintenance before deploying a fenced runtime
descendant. Both approved runtime bases require schema 0119, while staging
is at 0109. Installation must remain PostgreSQL-independent; ordinary
requests must not reach the schema-skewed runtime.

Keep ingress closed through deployment, six-object marking and verification,
exact-key R2 cleanup, reset and migrations, the approved paired deployment,
and application verification. Release ingress only after those gates pass.

Worker-side operator admission and staging-only enablement are separate from
object-side verification of the frozen inventory and generation. The object
must reject a fresh or misrouted object before writing any marker.

The storage-only installation barrier must not contain the producer drain.
After persistence, cancellation and bounded waiting occur outside the barrier
so earlier work can settle. Timeout is incomplete evidence, not quiescence.
Resumption checks stop subsequent effects; a newly returned multipart upload
identifier is retained for cleanup even when creation straddled installation.

## Internal installation protocol checkpoint

`karaoke-reset-installation.ts` now defines and unit-tests the internal
adapter protocol. It pins the six IDs and their inventory digest, calls an
operator admission dependency before object observation, and validates the
exact staging target and generation. It preserves the original observation
on replay, persists before cancellation, and performs the bounded drain
outside the storage barrier. Cancellation or drain failure produces incomplete
evidence while retaining the marker. A final marker read rejects a receipt
superseded by concurrent retirement.

The final receipt is constructed inside the observation barrier. It is a
point-in-time snapshot, not a lease or a promise that retirement cannot occur
after return. The six-receipt structural verifier alone must never authorize
cleanup; fresh object readback and the operator's maintained fence remain
separate requirements.

The producer tracker prevents new admission after closure and waits for all
registered promises, with a maximum ten-second wait and timer cleanup. A
timeout does not cancel earlier effects. The receipt verifier requires all
six distinct matching-state complete receipts, but is not a fresh live
readback or R2-key authorization mechanism.

The runtime now wires the storage adapter and producer tracker. Installation
waits up to five seconds outside the storage barrier. A durable unsettled flag
prevents reconstruction after an interrupted drain from mistaking an empty
in-memory tracker for proven quiescence. Such a replay remains incomplete;
it does not authorize cleanup. Generation `staging-reset-v1` must be pinned
with the operator admission and inventory in the release review.

The operator Workerd tests use real SQLite storage, alarm methods, input
barriers and JWT verification. Local namespaces reject staging object IDs,
so these tests explicitly substitute only the application-observed ID and
map entrypoint targets to local instances. They prove installation behavior,
not live namespace routing. A separate native service-binding call verifies
invalid-assertion denial. The live window still requires six exact object
receipts from the staging namespace before cleanup.
