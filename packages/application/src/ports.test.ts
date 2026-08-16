import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  CommunityRepositoryError,
  ContentRepositoryError,
  ControlPlaneAcquireFailed,
  ControlPlaneDb,
  type ControlPlaneError,
  ControlPlaneOperationTimedOut,
  type ControlPlaneStatement,
  ControlPlaneStatementFailed,
  ControlPlaneTransactionOutcomeUnknown,
} from "./ports.ts";

describe("ControlPlaneDb port", () => {
  test("keeps Postgres text, separate values, rows, and row count for both paths", async () => {
    const statement: ControlPlaneStatement = {
      label: "community.lookup",
      text: "SELECT id FROM communities WHERE id = $1",
      values: ["community_9"],
      readonly: true,
    };
    const calls: ControlPlaneStatement[] = [];
    const result = { rows: [{ id: "community_9" }], rowCount: 1 };
    const execute = <Row>(input: ControlPlaneStatement) => {
      calls.push(input);
      return Effect.succeed({
        rows: result.rows as unknown as readonly Row[],
        rowCount: result.rowCount,
      });
    };
    const service: ControlPlaneDb["Service"] = {
      execute,
      withTransaction: (use) => use({ execute }),
    };

    const program = Effect.gen(function* () {
      const db = yield* ControlPlaneDb;
      const direct = yield* db.execute(statement);
      const transactional = yield* db.withTransaction((transaction) =>
        transaction.execute(statement),
      );
      return { direct, transactional };
    });
    const output = await Effect.runPromise(Effect.provideService(program, ControlPlaneDb, service));

    expect(output.direct).toEqual(result);
    expect(output.transactional).toEqual(result);
    expect(calls).toEqual([statement, statement]);
  });

  test("uses a closed typed error union without raw driver data", () => {
    const errors: ControlPlaneError[] = [
      new ControlPlaneAcquireFailed({ phase: "acquisition", limitMs: 5_000, elapsedMs: 5_001 }),
      new ControlPlaneOperationTimedOut({
        label: "community.lookup",
        limitMs: 15_000,
        elapsedMs: 15_001,
        outcomeCertainty: "unknown",
      }),
      new ControlPlaneStatementFailed({
        label: "community.lookup",
        sqlState: "23505",
        constraint: "communities_pkey",
        outcomeCertainty: "completed",
      }),
      new ControlPlaneTransactionOutcomeUnknown({
        phase: "rollback",
        label: "community.transaction",
        limitMs: 15_000,
        elapsedMs: 15_001,
      }),
    ];

    expect(errors.map((error) => error._tag)).toEqual([
      "ControlPlaneAcquireFailed",
      "ControlPlaneOperationTimedOut",
      "ControlPlaneStatementFailed",
      "ControlPlaneTransactionOutcomeUnknown",
    ]);
    const timedOut = errors[1];
    const statementFailed = errors[2];
    if (!timedOut || !statementFailed) throw new Error("expected all control-plane errors");
    expect(Object.keys(timedOut)).not.toContain("cause");
    expect(Object.keys(statementFailed)).not.toContain("text");
    expect(Object.keys(statementFailed)).not.toContain("values");
  });
});

describe("M2 repository ports", () => {
  test("expose only typed semantic storage outcomes", () => {
    const community = new CommunityRepositoryError({
      operation: "join",
      reason: "membership-required",
    });
    const content = new ContentRepositoryError({
      operation: "create-post",
      reason: "idempotency-conflict",
    });

    expect(community).toMatchObject({
      _tag: "CommunityRepositoryError",
      operation: "join",
      reason: "membership-required",
    });
    expect(content).toMatchObject({
      _tag: "ContentRepositoryError",
      operation: "create-post",
      reason: "idempotency-conflict",
    });
    expect(Object.keys(community)).not.toContain("cause");
    expect(Object.keys(content)).not.toContain("sql");
  });
});
