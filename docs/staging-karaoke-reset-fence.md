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

There is not yet an operator installation or retirement RPC. The pure
transition function is not authentication or durable installation. Before
exposure, the staging-only operator path must validate the exact six-object
inventory, persist the marker before cancellation or socket closure, and
return object-bound receipts with outbox states, prior alarm state, archive
key, and multipart upload identifier.

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
