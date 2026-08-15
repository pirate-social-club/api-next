# Adapter-abort test plan

This plan closes the audit gap in which a deadline could return control to a
runner while the underlying operation continued. Every adapter test must prove
the stronger invariant:

> A DO lease release means the in-flight work has stopped, or a durable fence
> makes it unable to commit.

Elapsed time, a rejected `Promise.race`, or a scheduler boolean is not proof.

## Common event trace

Each fake adapter exposes a blocked operation and an observable event trace.
The test starts the operation before the timeout, waits for the `started`
event, then lets the job timeout. Before the scheduler can release the DO
lease, the trace must contain one terminal safety event:

- `aborted` for an operation with a real cancellation/termination primitive;
- `fence_committed` for an operation that cannot be recalled; or
- `connection_terminated` for Postgres when transaction outcome is made safe
  by killing the session.

The required ordering is:

```text
started -> timeout -> abort or fence committed -> lease released
```

The test then resolves the old promise and attempts its late result/write.
There must be no result publication, durable write, duplicate success mark, or
message consumer side effect after release. Cancellation/fencing is invoked
exactly once. Reuse of a fenced client/token must fail before a driver/RPC
call.

## Postgres adapter

The fake driver starts a query that remains pending and provides explicit
`cancel`, `end`, and `resolve` probes. Cover these cases:

1. A statement starts, runs past the 15,000 ms operation bound in the fake
   clock, and the adapter invokes cancellation/termination once. The lease
   release event is after the cancellation acknowledgement, not after the
   timeout callback.
2. A transaction body timeout terminates the request-scoped connection. A
   late query resolution cannot publish rows, and a second query is rejected
   without reaching the driver.
3. Begin, body failure, commit, and rollback each have an explicit trace. A
   rollback timeout and a commit timeout return
   `ControlPlaneTransactionOutcomeUnknown`, fence the client, and are not
   treated as ordinary retryable query failures.
4. Slow logging is asserted at exactly 1,000 ms and just below it. Log records
   contain only the stable label, duration, limit, SQLSTATE, and constraint;
   they do not contain SQL, values, URLs, or driver messages.
5. The statement probe receives the exact PostgreSQL `$1` text and a separate
   values array. The adapter never receives a translated SQLite statement.

The real-backend proof is specified in the Postgres 17 harness plan. It must
show the backend disappears from an independent admin connection and that a
sentinel insert is rolled back after the session is terminated.

## D1 shard RPC adapter

An outbound Service Binding RPC may not provide a reliable abort primitive.
The adapter therefore carries a fencing token composed of the lane owner,
job attempt id, and lease generation. The shard must validate that token at
the write boundary, not only when the RPC starts. A write is accepted only
when the token is still the active token for the community/job operation.

The fake shard test does the following:

1. Acquire a token and start a blocked `batchWrite` carrying it.
2. Time out the job and commit token revocation in the authoritative lease
   store. Wait for the revocation acknowledgement.
3. Release the DO lease only after that acknowledgement.
4. Resolve the old RPC. The fake shard attempts its final D1 mutation with the
   stale token; the mutation returns a typed fenced result or zero affected
   rows and commits no state.
5. Assert that the late RPC response cannot mark the job succeeded and that a
   new token can write only after a fresh acquisition.

The race case is mandatory: arrange the late RPC to resume between routing and
the final write. The final D1 statement must still perform a token-aware CAS
or equivalent atomic write predicate. A separate `isTokenValid` read followed
by an unguarded write is not sufficient.

The same contract covers single writes and shard-grouped bulk writes. Every
operation in a bulk request carries the token or is rejected as an
unfenceable batch; one successful item must not make the whole batch appear
committed after the lease is released.

The old attempt-id CAS shape is the reference for this assertion: checkpoint,
renew, success, and failure updates all require the active `attempt_id` in
`api/services/api/src/lib/communities/jobs/store.ts:385-505`.

## Queue-send adapter

Cloudflare queue acceptance cannot be assumed reversible after `send` returns,
and an in-flight send may not be abortable. The producer therefore owns a
durable outbox/dispatch row with an idempotency key and fencing token. The
queue message is only a delivery hint; the consumer performs the final write
under the outbox token and rejects a superseded token.

The fake queue test covers two outcomes:

- If the send supports real cancellation, assert cancellation acknowledgement
  before lease release and still fence the outbox row as a defense in depth.
- If the send cannot be cancelled, mark the dispatch row fenced with a durable
  CAS before releasing the lease. Resolve the old `send` afterward; whether a
  message was accepted, the consumer must observe the revoked token and make
  no state change. The late producer result cannot mark the row sent or the
  job successful.

The test must also cover the ambiguous boundary where the provider accepted
the message but the acknowledgement was lost. The result is
`dispatch_outcome_unknown`, not a blind resend. A retry uses the same
idempotency key and only proceeds through the outbox/consumer fence. This is
the queue form of the 000 section 12 requirement that producer send and mark
be made atomic by an outbox.

## Lease-order and negative assertions

All three adapters share these negative tests:

- lease release is rejected while the adapter still reports active I/O;
- a timeout without an abort acknowledgement or committed fence fails the
  test, even if the timeout elapsed many times over;
- a late resolution cannot publish a success or write result;
- release, abort, and fencing are idempotent under duplicate finalizers; and
- a subsequent owner cannot observe or reuse the old operation's client,
  token, transaction, or dispatch row.

The workerd extension must run the actual jobs timeout and prove that the
adapter signal/finalizer is reached before the DO lease is released. The
existing spike in `tests/workerd/effect-interruption.test.ts` proves fiber
interruption only; it does not satisfy this adapter proof by itself.
