# Postgres and Hyperdrive client design

This document is the Lane C preparation brief for the control-plane database
adapter. It is intentionally a design artifact: the frozen application port,
Postgres dependency, CI workflow, and implementation remain coordinator-owned
until the 002 integration barrier is complete.

## Design constraints

The adapter is a platform implementation of the application `ControlPlaneDb`
service. It creates a request- or tick-scoped Postgres client over the
Hyperdrive connection string and acquires that client in an Effect `Scope`.
The scope owns release even when the use case succeeds, fails with an expected
error, defects, or is interrupted.

The old implementation is the source of the deadline constants and the
transport policy. `RequestScopedPgConnection` configures a 5,000 ms client
connection timeout and a 15,000 ms statement timeout in
`api/services/api/src/lib/runtime-deps.ts:36-46`. The explicit acquisition
deadline is also 5,000 ms at `api/services/api/src/lib/runtime-deps.ts:518-526`.
The old slow log threshold is 1,000 ms at
`api/services/api/src/lib/runtime-deps.ts:30-34`; the transaction setup also
sets the 30,000 ms `idle_in_transaction_session_timeout` backstop at
`api/services/api/src/lib/runtime-deps.ts:540-544`.

These are exact carried bounds, not defaults to tune silently:

| Boundary | Limit | Required behavior |
| --- | ---: | --- |
| Client connection | 5,000 ms | Fail acquisition and terminate active I/O. |
| Hyperdrive/client acquisition | 5,000 ms | Do not release a lease while acquisition is pending. |
| Client statement | 15,000 ms | Apply an Effect deadline and a driver/server backstop. |
| Server statement | 15,000 ms | `statement_timeout` cancels work that reached Postgres. |
| Idle transaction | 30,000 ms | Bound abandoned transaction bodies. |
| Slow log | 1,000 ms inclusive | Log a safe label and duration; do not fail for slowness. |

The production constructor accepts only the Hyperdrive binding's connection
string. A direct Postgres URL is exposed by a test/local constructor only; it
is never a production fallback. This preserves the old request-scoped client
rule without making the Worker depend on a process-global connection.

The old transport timeout deliberately made a request client terminal by
closing its socket rather than returning it for reuse; see
`api/services/api/src/lib/runtime-deps.ts:69-121`. The new adapter keeps that
property and makes it observable in tests.

## Scoped acquisition and release

The reusable construction should have the following shape, expressed with
Effect combinators rather than a manual `try/finally` protocol:

1. `acquireClient` resolves the Hyperdrive connection string and opens one
   driver client under the 5,000 ms connection bound.
2. `Effect.acquireRelease(acquireClient, releaseClient)` registers the client
   in the current `Scope`. `releaseClient` is idempotent and awaits a bounded
   graceful close when no operation is active.
3. A statement operation records its stable label and starts before the
   Effect timeout is armed. On interruption it invokes the driver's real
   cancellation or connection termination, awaits that outcome, and fences
   the client permanently if the outcome is uncertain.
4. A client with active or uncertain I/O is never returned to a reusable pool.
   Its release path terminates the transport and records the client as fenced;
   subsequent calls fail before any driver call.
5. Release is part of the scope's completion protocol. A job lease may not be
   released merely because a deadline fiber won a race; the adapter must have
   proved cancellation/termination or installed a write fence first.

`Effect.timeout` supplies real interruption, as required by foundation 000
section 7. A `Promise.race` around a still-running driver promise is not an
implementation of this contract.

## Error model

The coordinator-owned application amendment should expose a small internal
tagged-error family through the Effect error channel. No member carries a raw
driver error, SQL text, bound value, connection URL, or compatibility-layer
field.

The proposed classifications are:

| Tag | Safe data | Retry meaning |
| --- | --- | --- |
| `ControlPlaneAcquireFailed` | phase, limit, elapsed duration | A transient acquisition failure may use its job schedule. |
| `ControlPlaneOperationTimedOut` | stable label, limit, elapsed duration, outcome certainty | Only a proven-aborted operation may be retried by an idempotent caller. |
| `ControlPlaneStatementFailed` | SQLSTATE, constraint, stable label, outcome certainty | Use SQLSTATE-specific types; never string-match a message. |
| `ControlPlaneTransactionOutcomeUnknown` | `commit`/`rollback` phase, limit, stable label | Terminal for generic retry; reconcile by idempotency/evidence. |

Retryability is represented by the concrete error type and its application
policy, not by a mutable boolean attached to an exception. A connection or
statement failure can map to the existing `ProviderUnavailable` wire error
when it is safe to retry. A transaction-outcome-unknown failure must not be
flattened into that class. This follows the frozen error model in
`packages/contracts/src/errors.ts` and foundation 000 section 10.

Logs may contain the component, stable label, elapsed duration, limit,
SQLSTATE, and constraint name. They must not contain SQL text, values, driver
messages, or URLs. Unknown provider failures are redacted at the wire and
alert boundary.

## Postgres-native statement surface

The post-barrier `ControlPlaneDb` amendment should use a statement value with
these semantics:

```ts
type ControlPlaneStatement = {
  readonly label: string;
  readonly text: string;
  readonly values: readonly unknown[];
  readonly readonly: boolean;
};

type ControlPlaneResult<Row> = {
  readonly rows: readonly Row[];
  readonly rowCount: number;
};
```

Repositories write PostgreSQL SQL directly. Placeholders are `$1`, `$2`, and
so on, with values passed separately to the driver. There is no `?1` rewrite,
`INSERT OR IGNORE`/`INSERT OR REPLACE` translation, SQLite compatibility
branch, `lastInsertRowid`, or SQL parser in this adapter. `readonly` is an
execution-policy assertion and does not rewrite the statement.

Each statement has a stable safe label for timing and failure logs. The label
is metadata, not a substitute for parameterization and not permission to log
the text.

## Worker lifetime semantics

The old request wrapper shares one client for nested calls and closes every
client when the request settles at
`api/services/api/src/lib/runtime-deps.ts:603-610`. Its background wrapper
always creates an independent scope because a `waitUntil` task can outlive
the response; that rationale is documented at
`api/services/api/src/lib/runtime-deps.ts:612-629`. The Effect version keeps
the same distinction:

- Request handlers run their application program in one request `Scope`.
  Nested `ControlPlaneDb` users share the scoped client.
- A `ctx.waitUntil` task or scheduled tick starts a fresh tick `Scope` before
  it acquires Postgres. It never borrows a request scope that can close after
  the response.
- The scope closes exactly once after the program settles. A late driver
  resolution cannot publish a result after the scope has fenced its client.
- A timed-out operation closes/fences its client even if Hyperdrive owns the
  underlying pool; the request-level driver object is not reused.

The adapter must fail closed when used outside a request or tick scope. This
prevents a module-level singleton from silently recreating the old connection
slot exhaustion problem.

## Transaction composition

`withControlPlaneTransaction` is a scoped child resource inside the same
request or tick scope, not a second client. The intended composition is:

```ts
Effect.scoped(
  Effect.gen(function* () {
    const db = yield* ControlPlaneDb;
    return yield* db.withTransaction(
      Effect.gen(function* () {
        return yield* useCaseThatExecutesOnTheTransaction;
      }),
    );
  }),
);
```

The coordinator's 002 section 6.3 amendment is required before implementation:
`ControlPlaneDb` must expose both `execute` and
`withTransaction(use(transaction))`; the transaction handle exposes
`execute`, returning rows and row count. Lane C does not edit the frozen port.

The transaction lifecycle is:

- acquire a client and begin the transaction in the outer scope;
- install the 15,000 ms statement and 30,000 ms idle-in-transaction
  backstops;
- run the body; on an ordinary body failure, perform bounded rollback;
- on interruption during active I/O, terminate the client so Postgres rolls
  back the transaction and fence the client;
- commit only after the body succeeds; and
- treat commit or rollback timeout/failure as
  `ControlPlaneTransactionOutcomeUnknown`, fence the client, and do not apply
  a generic retry schedule.

The scope finalizer is therefore a safety net, not a hidden commit. It must
never release a lease until the body has either completed with a known outcome
or has been aborted/fenced with the outcome recorded.

## Required evidence after the barrier

The implementation handoff must include deterministic fake-driver tests, a
workerd timeout test, and a real `postgres:17` test. The acceptance details,
including backend termination and rollback proof, are in
`docs/api-next/postgres17-harness-plan.md` and
`docs/api-next/adapter-abort-test-plan.md`.
