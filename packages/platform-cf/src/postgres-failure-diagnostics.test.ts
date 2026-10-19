import { describe, expect, test } from "bun:test";
import {
  ControlPlaneDb,
  ControlPlaneOperationTimedOut,
  type ControlPlaneResult,
  ControlPlaneStatementFailed,
  ControlPlaneTransactionOutcomeUnknown,
} from "@pirate/application";
import { LearnerAudioDeletionFailed } from "@pirate/application/use-cases/learner-audio-deletion";
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect";
import { makeDirectPostgresControlPlaneLayer, type PostgresClientLike } from "./postgres.ts";
import {
  type FailureDiagnostic,
  observeAudioDeletionFailure,
  withPostgresFailureDiagnostics,
} from "./postgres-failure-diagnostics.pg-fixture.ts";

const statement = {
  label: "diagnostics.private-operation",
  text: "SELECT private_row WHERE credential = $1",
  values: ["secret-credential"],
  readonly: false,
};
const dbFor = (execute: ControlPlaneDb["Service"]["execute"]) =>
  Layer.succeed(ControlPlaneDb, {
    execute,
    withTransaction: (use) => use({ execute }),
  });
const read = Effect.gen(function* () {
  return yield* (yield* ControlPlaneDb).execute(statement);
});

describe("test-only native Postgres failure diagnostics (no database)", () => {
  test("preserves success identity, execution count and layer cleanup without logging rows", async () => {
    const rows = { rows: [{ identity: "private-owner", audio_key: "private/audio" }], rowCount: 1 };
    const records: FailureDiagnostic[] = [];
    let executed = 0;
    let released = 0;
    const layer = Layer.effect(
      ControlPlaneDb,
      Effect.gen(function* () {
        yield* Effect.acquireRelease(Effect.void, () =>
          Effect.sync(() => {
            released += 1;
          }),
        );
        const execute: ControlPlaneDb["Service"]["execute"] = <Row>() =>
          Effect.sync(() => {
            executed += 1;
            return rows as unknown as ControlPlaneResult<Row>;
          });
        return ControlPlaneDb.of({ execute, withTransaction: (use) => use({ execute }) });
      }),
    );
    const actual = await Effect.runPromise(
      read.pipe(Effect.provide(withPostgresFailureDiagnostics(layer, (d) => records.push(d)))),
    );
    expect(actual).toBe(rows);
    expect(executed).toBe(1);
    expect(released).toBe(1);
    expect(records).toEqual([]);
  });

  test("sees native execute classification before a repository maps the failure", async () => {
    const native = new ControlPlaneStatementFailed({
      label: statement.label,
      sqlState: "PWN02",
      constraint: "reward_nonce_owner",
      outcomeCertainty: "completed",
    });
    const mapped = { _tag: "DomainFailure" };
    const events: unknown[] = [];
    let calls = 0;
    const layer = withPostgresFailureDiagnostics(
      dbFor(() => {
        calls += 1;
        return Effect.fail(native);
      }),
      (d) => events.push(d),
    );
    const outcome = await Effect.runPromise(
      Effect.flip(
        read.pipe(
          Effect.mapError(() => {
            events.push("mapped");
            return mapped;
          }),
          Effect.provide(layer),
        ),
      ),
    );
    expect(outcome).toBe(mapped);
    expect(calls).toBe(1);
    expect(events).toEqual([
      {
        _tag: "ControlPlaneStatementFailed",
        label: statement.label,
        sqlState: "PWN02",
        constraint: "reward_nonce_owner",
        phase: null,
        outcomeCertainty: "completed",
      },
      "mapped",
    ]);
  });

  test("retains exact statement and timeout errors even when the diagnostic sink throws", async () => {
    for (const error of [
      new ControlPlaneStatementFailed({
        label: statement.label,
        sqlState: "23505",
        constraint: "known_pkey",
        outcomeCertainty: "completed",
      }),
      new ControlPlaneOperationTimedOut({
        label: statement.label,
        limitMs: 1,
        elapsedMs: 1,
        outcomeCertainty: "unknown",
      }),
    ]) {
      let calls = 0;
      const layer = withPostgresFailureDiagnostics(
        dbFor(() => {
          calls += 1;
          return Effect.fail(error);
        }),
        () => {
          throw new Error("logging failed");
        },
      );
      expect(await Effect.runPromise(Effect.flip(read.pipe(Effect.provide(layer))))).toBe(error);
      expect(calls).toBe(1);
    }
  });

  test("preserves a composite typed failure, undefined defect and interrupt cause", async () => {
    const error = new ControlPlaneStatementFailed({
      label: statement.label,
      sqlState: null,
      constraint: null,
      outcomeCertainty: "unknown",
    });
    const original = Cause.combine(
      Cause.combine(Cause.fail(error), Cause.die(undefined)),
      Cause.interrupt(123),
    );
    const records: FailureDiagnostic[] = [];
    const layer = withPostgresFailureDiagnostics(
      dbFor(() => Effect.failCause(original)),
      (d) => records.push(d),
    );
    const exit = await Effect.runPromiseExit(read.pipe(Effect.provide(layer)));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(exit.cause.reasons).toEqual(original.reasons);
    expect(records.map((d) => d._tag)).toEqual(["ControlPlaneStatementFailed", "Die", "Interrupt"]);
  });

  test("external cancellation still interrupts execute and runs its original finalizer once", async () => {
    let executed = 0;
    let cleaned = 0;
    const records: FailureDiagnostic[] = [];
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const layer = withPostgresFailureDiagnostics(
          dbFor(() =>
            Effect.gen(function* () {
              executed += 1;
              yield* Deferred.succeed(started, undefined);
              return yield* Effect.never;
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  cleaned += 1;
                }),
              ),
            ),
          ),
          (d) => records.push(d),
        );
        const fiber = yield* read.pipe(Effect.provide(layer), Effect.forkChild);
        yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
        return yield* Effect.exit(Fiber.join(fiber));
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(exit.cause.reasons.some(Cause.isInterruptReason)).toBe(true);
    expect(executed).toBe(1);
    expect(cleaned).toBe(1);
    expect(records.map((d) => d._tag)).toEqual(["Interrupt"]);
  });

  test("never emits private SQL, parameters, rows, raw causes, messages or malformed metadata", async () => {
    const secret = "postgres://owner:credential@host/private/audio";
    const error = Object.assign(
      new ControlPlaneStatementFailed({
        label: secret,
        sqlState: secret,
        constraint: secret,
        outcomeCertainty: "unknown",
      }),
      { cause: { code: secret }, detail: secret, rows: [secret], message: secret },
    );
    const records: FailureDiagnostic[] = [];
    const layer = withPostgresFailureDiagnostics(
      dbFor(() => Effect.fail(error)),
      (d) => records.push(d),
    );
    expect(await Effect.runPromise(Effect.flip(read.pipe(Effect.provide(layer))))).toBe(error);
    expect(records).toEqual([
      {
        _tag: "ControlPlaneStatementFailed",
        label: statement.label,
        sqlState: null,
        constraint: null,
        phase: null,
        outcomeCertainty: "unknown",
      },
    ]);
    expect(JSON.stringify(records)).not.toContain(secret);
    expect(JSON.stringify(records)).not.toContain(statement.text);
    expect(JSON.stringify(records)).not.toContain("secret-credential");
  });

  test("hostile diagnostic getters do not replace the original error", async () => {
    const error = Object.defineProperty(
      new ControlPlaneStatementFailed({
        label: statement.label,
        sqlState: null,
        constraint: null,
        outcomeCertainty: "unknown",
      }),
      "_tag",
      {
        get: () => {
          throw new Error("private getter");
        },
      },
    );
    const original = Cause.fail(error);
    const layer = withPostgresFailureDiagnostics(
      dbFor(() => Effect.failCause(original)),
      () => {
        throw new Error("must not log raw error");
      },
    );
    const exit = await Effect.runPromiseExit(read.pipe(Effect.provide(layer)));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(exit.cause.reasons).toEqual(original.reasons);
  });

  test("transaction-bound execute uses the real adapter and retains rollback and native evidence", async () => {
    const queries: string[] = [];
    const records: FailureDiagnostic[] = [];
    let callbacks = 0;
    const client: PostgresClientLike = {
      connect: async () => {},
      end: async () => {},
      query: async ({ text }) => {
        queries.push(text);
        if (text === statement.text)
          throw { code: "PWN02", constraint: "nonce_owner", detail: "private" };
        return { rows: [], rowCount: 0 };
      },
    };
    const runtime = makeDirectPostgresControlPlaneLayer("unused-offline-fixture", {
      clientFactory: () => client,
    });
    const failure = await Effect.runPromise(
      Effect.flip(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((tx) => {
            callbacks += 1;
            return tx.execute(statement);
          });
        }).pipe(Effect.provide(withPostgresFailureDiagnostics(runtime, (d) => records.push(d)))),
      ),
    );
    expect(failure).toMatchObject({
      _tag: "ControlPlaneStatementFailed",
      sqlState: "PWN02",
      constraint: "nonce_owner",
    });
    expect(records[0]).toEqual({
      _tag: "ControlPlaneStatementFailed",
      label: statement.label,
      sqlState: "PWN02",
      constraint: "nonce_owner",
      phase: null,
      outcomeCertainty: "completed",
    });
    expect(callbacks).toBe(1);
    expect(queries.filter((q) => q === statement.text)).toHaveLength(1);
    expect(queries.at(-1)).toBe("ROLLBACK");
    expect(queries).not.toContain("COMMIT");
  });

  for (const phase of ["commit", "rollback"] as const) {
    test(`retains original transaction ${phase} uncertainty without a second callback`, async () => {
      const uncertainty = new ControlPlaneTransactionOutcomeUnknown({
        phase,
        label: `control-plane.transaction.${phase}`,
        limitMs: 1,
        elapsedMs: 1,
      });
      const original = Cause.combine(Cause.fail(uncertainty), Cause.die(undefined));
      const records: FailureDiagnostic[] = [];
      let callbacks = 0;
      const runtime = Layer.succeed(ControlPlaneDb, {
        execute: () => Effect.succeed({ rows: [], rowCount: 0 }),
        withTransaction: (use) =>
          use({ execute: () => Effect.succeed({ rows: [], rowCount: 0 }) }).pipe(
            Effect.andThen(Effect.failCause(original)),
          ),
      });
      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          return yield* (yield* ControlPlaneDb).withTransaction(() => {
            callbacks += 1;
            return Effect.succeed("original result");
          });
        }).pipe(Effect.provide(withPostgresFailureDiagnostics(runtime, (d) => records.push(d)))),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(exit.cause.reasons).toEqual(original.reasons);
      expect(records[0]).toMatchObject({
        _tag: "ControlPlaneTransactionOutcomeUnknown",
        phase,
        outcomeCertainty: "unknown",
      });
      expect(callbacks).toBe(1);
    });
  }
});

describe("audio deletion diagnostics before runPromise (no database or bucket I/O)", () => {
  for (const reason of ["in-flight", "store-unavailable", "storage-unavailable"] as const) {
    test(`retains ${reason} with bucket invocation count and no keys`, async () => {
      const error = new LearnerAudioDeletionFailed({ reason });
      const records: FailureDiagnostic[] = [];
      const actual = await Effect.runPromise(
        Effect.flip(
          observeAudioDeletionFailure(
            Effect.fail(error),
            () => 2,
            (d) => records.push(d),
          ),
        ),
      );
      expect(actual).toBe(error);
      expect(records).toEqual([{ _tag: "LearnerAudioDeletionFailed", reason, bucketCalls: 2 }]);
    });
  }

  test("success, defects and interruption pass through; logging and counter errors cannot replace them", async () => {
    const success = { deleted_count: 1, remaining_count: 0 };
    expect(
      await Effect.runPromise(
        observeAudioDeletionFailure(Effect.succeed(success), () => {
          throw new Error("must not read on success");
        }),
      ),
    ).toBe(success);
    const original = Cause.combine(Cause.die(undefined), Cause.interrupt(456));
    const exit = await Effect.runPromiseExit(
      observeAudioDeletionFailure(
        Effect.failCause(original),
        () => 0,
        () => {
          throw new Error("log failure");
        },
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(exit.cause.reasons).toEqual(original.reasons);
    const error = new LearnerAudioDeletionFailed({ reason: "in-flight" });
    expect(
      await Effect.runPromise(
        Effect.flip(
          observeAudioDeletionFailure(Effect.fail(error), () => {
            throw new Error("count failure");
          }),
        ),
      ),
    ).toBe(error);
  });

  test("unknown audio errors cannot emit arbitrary tags, reasons, storage keys or counts", async () => {
    const secret = "learner-audio/private-account/credential";
    const records: FailureDiagnostic[] = [];
    const error = { _tag: secret, reason: secret, objectRefs: [secret], accountId: secret };
    const actual = await Effect.runPromise(
      Effect.flip(
        observeAudioDeletionFailure(
          Effect.fail(error),
          () => Number.POSITIVE_INFINITY,
          (d) => records.push(d),
        ),
      ),
    );
    expect(actual).toBe(error);
    expect(records).toEqual([{ _tag: "Fail", reason: null, bucketCalls: null }]);
    expect(JSON.stringify(records)).not.toContain(secret);
  });
});
