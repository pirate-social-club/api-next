import { describe, expect, test } from "bun:test";
import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneResult,
  type ControlPlaneStatement,
  ControlPlaneStatementFailed,
} from "@pirate/application";
import { InternalError } from "@pirate/contracts";
import { Effect, Layer } from "effect";
import {
  HNS_SERVED_ROOTS_SQL,
  makeControlPlaneHnsNamespaceDiscoveryStore,
} from "./hns-namespace-discovery-repository.ts";

function runtime(
  result: Effect.Effect<readonly Record<string, unknown>[], ControlPlaneError>,
  calls: ControlPlaneStatement[] = [],
) {
  const execute = <R = unknown>(statement: ControlPlaneStatement) => {
    calls.push(statement);
    return Effect.map(
      result,
      (rows) =>
        ({ rows: rows as readonly R[], rowCount: rows.length }) satisfies ControlPlaneResult<R>,
    );
  };
  return Layer.succeed(ControlPlaneDb, {
    execute,
    withTransaction: <A, E, R>(
      use: (transaction: { execute: typeof execute }) => Effect.Effect<A, E, R>,
    ) => use({ execute }),
  });
}

const row = {
  generated_at: "2026-10-22T07:00:00.000Z",
  roots: [{ root: "8s28", expires_at: "2026-10-27T07:00:00.000Z" }],
};

const servedRoots = (layer: ReturnType<typeof runtime>) =>
  Effect.runPromise(Effect.result(makeControlPlaneHnsNamespaceDiscoveryStore(layer).servedRoots()));

describe("HNS namespace discovery repository", () => {
  test("reads the served roots in one read-only statement over one clock reading", async () => {
    const calls: ControlPlaneStatement[] = [];
    const result = await servedRoots(runtime(Effect.succeed([row]), calls));
    expect(result).toMatchObject({ _tag: "Success", success: row });
    expect(calls).toEqual([
      {
        label: "hns.namespace-discovery.served-roots",
        text: HNS_SERVED_ROOTS_SQL,
        values: [],
        readonly: true,
      },
    ]);
    expect(HNS_SERVED_ROOTS_SQL).not.toContain(";");
    expect(HNS_SERVED_ROOTS_SQL.match(/clock_timestamp\(\)/gu)).toHaveLength(1);
    expect(HNS_SERVED_ROOTS_SQL).toContain(
      "SELECT date_trunc('milliseconds', clock_timestamp()) AS database_time",
    );
  });

  test("answers a database failure with InternalError, never an empty list", async () => {
    const result = await servedRoots(
      runtime(
        Effect.fail(
          new ControlPlaneStatementFailed({
            label: "hns.namespace-discovery.served-roots",
            sqlState: "57014",
            constraint: null,
            outcomeCertainty: "not-started",
          }),
        ),
      ),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure).toBeInstanceOf(InternalError);
  });

  test("answers an undecodable result with InternalError", async () => {
    for (const rows of [
      [],
      [row, row],
      [{ ...row, generated_at: "2026-10-22T07:00:00Z" }],
      [{ ...row, roots: null }],
      [{ ...row, roots: [{ root: "under_score", expires_at: row.roots[0]?.expires_at }] }],
      [{ ...row, roots: [{ root: "8s28", expires_at: new Date() }] }],
    ]) {
      const result = await servedRoots(runtime(Effect.succeed(rows)));
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure).toBeInstanceOf(InternalError);
    }
  });
});
