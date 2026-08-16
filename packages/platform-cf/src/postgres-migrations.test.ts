import { describe, expect, test } from "bun:test";
import {
  ControlPlaneDb,
  type ControlPlaneResult,
  type ControlPlaneStatement,
} from "@pirate/application";
import { Cause, Effect, Exit, Result } from "effect";

import {
  applyPostgresMigrations,
  MigrationLedgerMismatch,
  type PostgresMigration,
} from "./postgres-migrations";

const first: PostgresMigration = {
  version: "0001.sql",
  checksum: "1".repeat(64),
  sql: "SELECT 1",
};
const second: PostgresMigration = {
  version: "0002.sql",
  checksum: "2".repeat(64),
  sql: "SELECT 2",
};

function fakeDb(ledger: readonly { version: string; checksum: string }[]) {
  const execute = <Row = unknown>(
    statement: ControlPlaneStatement,
  ): Effect.Effect<ControlPlaneResult<Row>, never> =>
    Effect.succeed({
      rows: (statement.label === "postgres.migrations.read-ledger" ? ledger : []) as readonly Row[],
      rowCount: statement.label === "postgres.migrations.read-ledger" ? ledger.length : 0,
    });
  return {
    execute,
    withTransaction: <A, E, R>(
      use: (transaction: { execute: typeof execute }) => Effect.Effect<A, E, R>,
    ) => use({ execute }),
  } satisfies ControlPlaneDb["Service"];
}

function failureOf<A, E>(exit: Exit.Exit<A, E>): E {
  if (!Exit.isFailure(exit)) throw new Error("expected migration failure");
  const failure = Cause.findError(exit.cause);
  if (!Result.isSuccess(failure)) throw new Error("expected typed migration failure");
  return failure.success;
}

describe("Postgres migration ledger prefix", () => {
  test("rejects a ledger containing only 0002 when 0001 is the defined prefix", async () => {
    const result = await Effect.runPromiseExit(
      applyPostgresMigrations([first, second]).pipe(
        Effect.provideService(
          ControlPlaneDb,
          fakeDb([{ version: second.version, checksum: second.checksum }]),
        ),
      ),
    );
    const failure = failureOf(result);
    expect(failure).toBeInstanceOf(MigrationLedgerMismatch);
    expect(failure).toMatchObject({
      reason: "not-prefix",
      expectedVersion: first.version,
      actualVersion: second.version,
    });
  });

  test("accepts the contiguous prefix and applies the remaining migration", async () => {
    const result = await Effect.runPromise(
      applyPostgresMigrations([first, second]).pipe(
        Effect.provideService(ControlPlaneDb, fakeDb([{ ...first }])),
      ),
    );
    expect(result).toEqual({ applied: [second.version], currentVersion: second.version });
  });
});
