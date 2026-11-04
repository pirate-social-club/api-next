// Proposed driver-boundary tests; root owns adoption and actual gates. These
// exercise the genuine Postgres transaction/failure bridge, not fake SQL proof.
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { makeControlPlaneOwnerSpokenPreArchiveCheckpointStore } from "./owner-spoken-checkpoint-store.ts";
import {
  makeDirectPostgresControlPlaneLayer,
  type PostgresClientLike,
  type PostgresQueryConfig,
} from "./postgres.ts";

const input = {
  source: { kind: "guest" as const, ownerId: "owner-original" },
  operation: {
    sourceOwnerId: "owner-original",
    kind: "study_answer" as const,
    idempotencyKey: "answer-original",
    requestHash: "a".repeat(64),
  },
  commandId: "command-original",
  originalLeaseToken: "private-original-lease",
};
function fixture(options: { badBounds?: boolean; commitUnknown?: boolean } = {}) {
  const queries: PostgresQueryConfig[] = [];
  const logs: unknown[] = [];
  const client: PostgresClientLike = {
    connect: async () => {},
    end: async () => {},
    query: async (query) => {
      queries.push(query);
      if (query.text === "COMMIT" && options.commitUnknown)
        throw new Error("opaque private driver text");
      if (query.text.startsWith("SELECT current_setting"))
        return {
          rows: [
            {
              transaction_bounded: true,
              lock_bounded: true,
              statement_bounded: true,
              idle_bounded: !options.badBounds,
            },
          ],
          rowCount: 1,
        };
      if (query.text.startsWith("SELECT read_owner_guest_spoken_success_v1"))
        return { rows: [{ result: null }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  const runtime = makeDirectPostgresControlPlaneLayer("postgres://fixture.invalid/checkpoint", {
    clientFactory: () => client,
    logger: {
      info: (event, fields) => logs.push({ event, fields }),
      error: (event, fields) => logs.push({ event, fields }),
    },
  });
  return { queries, logs, store: makeControlPlaneOwnerSpokenPreArchiveCheckpointStore(runtime) };
}
test("lookup calls only controlled JSON-source leaf with original operation and lease; absence stays readonly", async () => {
  const f = fixture();
  expect(await Effect.runPromise(f.store.findBeforeArchive(input))).toBeNull();
  const leaf = f.queries.find((query) =>
    query.text.startsWith("SELECT read_owner_guest_spoken_success_v1"),
  );
  expect(leaf?.text).toContain("$1::jsonb");
  expect(leaf?.values).toEqual([
    JSON.stringify(input.source),
    JSON.stringify(input.operation),
    input.commandId,
    input.originalLeaseToken,
  ]);
  expect(
    f.queries.some((query) => /SELECT (load_guest|capture_guest|persist_guest)/u.test(query.text)),
  ).toBe(false);
  expect(f.queries.at(-1)?.text).toBe("COMMIT");
  expect(JSON.stringify(f.logs)).not.toContain(input.originalLeaseToken);
});
test("failed exact bound readback refuses before any checkpoint leaf and rolls back", async () => {
  const f = fixture({ badBounds: true });
  const result = await Effect.runPromise(Effect.result(f.store.findBeforeArchive(input)));
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") expect(result.failure._tag).toBe("ControlPlaneStatementFailed");
  expect(
    f.queries.some((query) => query.text.startsWith("SELECT read_owner_guest_spoken_success_v1")),
  ).toBe(false);
  expect(f.queries.at(-1)?.text).toBe("ROLLBACK");
});
test("COMMIT acknowledgment uncertainty cannot return a reliable missing-checkpoint result or leak driver text", async () => {
  const f = fixture({ commitUnknown: true });
  const result = await Effect.runPromise(Effect.result(f.store.findBeforeArchive(input)));
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") {
    expect(result.failure._tag).toBe("ControlPlaneTransactionOutcomeUnknown");
    expect(JSON.stringify(result.failure)).not.toContain("opaque private driver text");
  }
  expect(JSON.stringify(f.logs)).not.toContain(input.originalLeaseToken);
});
