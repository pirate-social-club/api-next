// Unexecuted outside-source proposal. Actual adapter boundary; no real PG claim.
import { expect, test } from "bun:test";
import {
  ControlPlaneStatementFailed,
  ControlPlaneTransactionOutcomeUnknown,
} from "@pirate/application";
import {
  type GuestParticipationReadStore,
  GuestParticipationStoreRejected,
} from "@pirate/application/guest-participation-authority";
import { Effect } from "effect";
import { makeControlPlaneGuestPracticeParticipationReadStore } from "./guest-practice-participation-read-store.ts";
import {
  makeDirectPostgresControlPlaneLayer,
  type PostgresClientLike,
  type PostgresQueryConfig,
} from "./postgres.ts";

const input: Parameters<GuestParticipationReadStore["list"]>[0] = {
  access: {
    kind: "guest",
    ownerId: "owner_00000000-0000-0000-0000-000000000001",
    credentialId: "AAAAAAAAAAAAAAAAAAAAAA",
    origin: "https://community.example",
  },
  cursor: null,
  limit: 100,
};
const financialProjection = {
  participation_id: "actual-participation",
  original_drawing_id: "1",
  pool_leg_id: "actual-leg",
  admission_state: "admitted",
  purchase_state: "confirmed",
  purchase_safety_deadline_at: "2026-10-12T00:00:00.000Z",
  reconciliation_state: "resolved",
  purchase_deadline_passed: false,
  allocation_id: null,
  credit_id: null,
  amount_atomic: null,
};
function fixture(
  options: {
    rows?: readonly unknown[];
    commitFails?: boolean;
    sqlState?: string;
    badBounds?: boolean;
  } = {},
) {
  const queries: PostgresQueryConfig[] = [],
    logs: unknown[] = [];
  const client: PostgresClientLike = {
    connect: async () => {},
    end: async () => {},
    query: async (query) => {
      queries.push(query);
      if (query.text === "COMMIT" && options.commitFails)
        throw new Error("opaque private driver detail");
      if (query.text.startsWith("SELECT current_setting"))
        return {
          rows: [
            {
              transaction: "3s",
              lock: "250ms",
              statement: "2s",
              idle: options.badBounds ? "0" : "2s",
            },
          ],
          rowCount: 1,
        };
      if (query.text.startsWith("SELECT list_guest_practice_participations_v1")) {
        if (options.sqlState)
          throw Object.assign(new Error("opaque private driver detail"), {
            code: options.sqlState,
          });
        const rows = options.rows ?? [{ result: { items: [], nextCursor: null } }];
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const runtime = makeDirectPostgresControlPlaneLayer("postgres://fixture.invalid/practice-list", {
    clientFactory: () => client,
    logger: {
      info: (event, fields) => logs.push({ event, fields }),
      error: (event, fields) => logs.push({ event, fields }),
    },
  });
  return { store: makeControlPlaneGuestPracticeParticipationReadStore(runtime), queries, logs };
}
async function failed(effect: Effect.Effect<unknown, unknown>) {
  const result = await Effect.runPromise(Effect.scoped(Effect.result(effect)));
  if (result._tag !== "Failure") throw new Error("Expected private read refusal");
  return result.failure;
}
test("a strictly proved private SQL empty page returns only after COMMIT and preserves the exact read tuple", async () => {
  const f = fixture();
  expect(await Effect.runPromise(Effect.scoped(f.store.list(input)))).toEqual({
    items: [],
    nextCursor: null,
  });
  expect(f.queries.find((q) => q.text.startsWith("SELECT list_guest_practice"))?.values).toEqual([
    JSON.stringify(input.access),
    null,
    100,
  ]);
  expect(f.queries.at(-1)?.text).toBe("COMMIT");
});
test("financial, malformed, excess and duplicate replies are rejected inside the transaction rather than replaced by empty", async () => {
  for (const rows of [
    [{ result: { items: [financialProjection], nextCursor: null } }],
    [{ result: { items: [], nextCursor: "future-cursor" } }],
    [{ result: { items: [], nextCursor: null, unknown: true } }],
    [{ result: { items: [], nextCursor: null }, unknown: true }],
    [{ result: { items: [], nextCursor: null } }, { result: { items: [], nextCursor: null } }],
  ]) {
    const f = fixture({ rows });
    expect((await failed(f.store.list(input))) instanceof ControlPlaneStatementFailed).toBe(true);
    expect(f.queries.some((q) => q.text === "ROLLBACK")).toBe(true);
    expect(f.queries.some((q) => q.text === "COMMIT")).toBe(false);
  }
});
test("bound-account access is unavailable without querying or pretending a successful guest binding", async () => {
  const f = fixture();
  const error = await failed(
    f.store.list({
      ...input,
      access: {
        kind: "bound_account",
        accountId: "ordinary-account",
        sessionBinding: "private-binding",
      },
    }),
  );
  expect(error instanceof GuestParticipationStoreRejected).toBe(true);
  if (!(error instanceof GuestParticipationStoreRejected))
    throw new Error("Expected closed binding authority");
  expect(error.reason).toBe("resource-policy-unavailable");
  expect(f.queries).toHaveLength(0);
});
test("exact safe proof/owner/phase SQL codes map, unknown SQL state and COMMIT uncertainty remain failures", async () => {
  for (const [sqlState, reason] of [
    ["GP001", "proof-revoked"],
    ["GP002", "owner-mismatch"],
    ["GP003", "authority-conflict"],
  ] as const) {
    const f = fixture({ sqlState }),
      error = await failed(f.store.list(input));
    expect(error instanceof GuestParticipationStoreRejected).toBe(true);
    if (!(error instanceof GuestParticipationStoreRejected))
      throw new Error("Expected safe rejection");
    expect(error.reason).toBe(reason);
    expect(JSON.stringify(f.logs).includes("opaque private driver detail")).toBe(false);
  }
  const unknown = fixture({ sqlState: "42702" });
  const error = await failed(unknown.store.list(input));
  expect(error instanceof ControlPlaneStatementFailed).toBe(true);
  if (!(error instanceof ControlPlaneStatementFailed))
    throw new Error("Expected retained statement failure");
  expect(error.sqlState).toBe("42702");
  expect(
    (await failed(fixture({ commitFails: true }).store.list(input))) instanceof
      ControlPlaneTransactionOutcomeUnknown,
  ).toBe(true);
});
test("unsupported verified transaction bounds refuse before any participation leaf", async () => {
  const f = fixture({ badBounds: true });
  expect((await failed(f.store.list(input))) instanceof ControlPlaneStatementFailed).toBe(true);
  expect(f.queries.some((q) => q.text.startsWith("SELECT list_guest_practice"))).toBe(false);
});
