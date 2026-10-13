import { expect, test } from "bun:test";
import { GuestCredentialIdV1, GuestParticipationProjectionV1 } from "@pirate/contracts";
import { Cause, Effect, Exit, Option, Schema } from "effect";
import {
  makeControlPlaneOwnerGuestParticipationReadStore,
  makeControlPlaneOwnerParticipationReadStore,
} from "./owner-participation-read-store.ts";
import {
  makeDirectPostgresControlPlaneLayer,
  type PostgresClientLike,
  type PostgresQueryConfig,
} from "./postgres.ts";

const credential = Schema.decodeUnknownSync(GuestCredentialIdV1)("C".repeat(21) + "A");
const item = Schema.decodeUnknownSync(GuestParticipationProjectionV1)({
  participation_id: "original-admission",
  pool_leg_id: "original-leg",
  original_drawing_id: "7",
  admission_state: "pending_confirmation",
  purchase_state: "held_unresolved_admission",
  purchase_safety_deadline_at: "2026-10-13T00:00:00.000Z",
  reconciliation_state: "pending",
  purchase_deadline_passed: true,
  allocation_id: null,
  credit_id: null,
  amount_atomic: null,
});
function fixture(reply: unknown, sqlState?: string) {
  const queries: PostgresQueryConfig[] = [];
  const client: PostgresClientLike = {
    connect: async () => {},
    end: async () => {},
    query: async (query) => {
      queries.push(query);
      if (query.text.includes("current_setting('transaction_timeout')"))
        return {
          rows: [{ transaction: "3s", lock: "250ms", statement: "2s", idle: "2s" }],
          rowCount: 1,
        };
      if (
        query.text.includes("list_guest_owner_participations_v1") ||
        query.text.includes("list_account_owner_participations_v1") ||
        query.text.includes("get_account_owner_participation_v1")
      ) {
        if (sqlState) throw Object.assign(new Error("private SQL detail"), { code: sqlState });
        return { rows: [{ result: reply }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const runtime = makeDirectPostgresControlPlaneLayer("postgres://fixture.invalid/readonly", {
    clientFactory: () => client,
  });
  return {
    account: makeControlPlaneOwnerParticipationReadStore(runtime),
    guest: makeControlPlaneOwnerGuestParticipationReadStore(runtime),
    queries,
  };
}
function failure(exit: Awaited<ReturnType<typeof Effect.runPromiseExit>>) {
  if (!Exit.isFailure(exit)) throw new Error("Expected refusal");
  const found = Cause.findErrorOption(exit.cause);
  if (!Option.isSome(found)) throw new Error("Expected typed error");
  return found.value;
}
test("other browser Account can read original pending before credit allocation with no Guest credential", async () => {
  const f = fixture({ items: [item], nextCursor: null });
  expect(
    await Effect.runPromise(f.account.list({ accountId: "canonical-B", cursor: null, limit: 25 })),
  ).toEqual({ object: "owner_participation_list_v1", items: [item], next_cursor: null });
  expect(
    f.queries.find(
      (q) => q.text === "SELECT list_account_owner_participations_v1($1,$2,$3) AS result",
    )?.values,
  ).toEqual(["canonical-B", null, 25]);
});
test("Guest read validates exact4 recovery fields under owning bounds; bound account does not forward session binding", async () => {
  const access = {
    kind: "guest" as const,
    ownerId: "owner-1",
    credentialId: credential,
    origin: "https://community.example",
  };
  const f = fixture({ items: [item], nextCursor: null });
  await Effect.runPromise(f.guest.list({ access, cursor: null, limit: 25 }));
  const selected = f.queries.find((q) => q.text.includes("list_guest_owner_participations_v1"));
  expect(selected?.values).toEqual([JSON.stringify(access), null, 25]);
  expect(f.queries.some((q) => q.text === "COMMIT")).toBe(true);
  const bound = fixture({ items: [item], nextCursor: null });
  await Effect.runPromise(
    bound.guest.list({
      access: { kind: "bound_account", accountId: "B", sessionBinding: "a".repeat(64) },
      cursor: null,
      limit: 25,
    }),
  );
  expect(
    bound.queries.find((q) => q.text.includes("list_account_owner_participations_v1"))?.values,
  ).toEqual(["B", null, 25]);
  expect(JSON.stringify(bound.queries)).not.toContain("a".repeat(64));
});
test("extra proof material refuses before SQL and duplicate/private/excess/foreign cursor result never leaks", async () => {
  const f = fixture({ items: [], nextCursor: null });
  const input = {
    access: {
      kind: "guest" as const,
      ownerId: "owner-1",
      credentialId: credential,
      origin: "https://community.example",
      proofDigest: "raw-sensitive",
    },
    cursor: null,
    limit: 25,
  };
  expect(failure(await Effect.runPromiseExit(f.guest.list(input)))).toMatchObject({
    _tag: "ControlPlaneStatementFailed",
    outcomeCertainty: "not-started",
  });
  expect(f.queries).toEqual([]);
  for (const reply of [
    { items: [item, item], nextCursor: null },
    { items: [item], nextCursor: "foreign" },
    { items: [item], nextCursor: null, leaf_salt: "private" },
  ]) {
    const result = failure(
      await Effect.runPromiseExit(
        fixture(reply).account.list({ accountId: "B", cursor: null, limit: 1 }),
      ),
    );
    expect(result).toMatchObject({
      _tag: "ControlPlaneStatementFailed",
      label: "owner-participation.account.list.decode",
    });
    expect(JSON.stringify(result)).not.toContain("private");
  }
});
test("detail response must carry the exact original requested journal ID", async () => {
  expect(
    failure(
      await Effect.runPromiseExit(
        fixture(item).account.get({ accountId: "B", participationId: "different-original" }),
      ),
    ),
  ).toMatchObject({
    _tag: "ControlPlaneStatementFailed",
    label: "owner-participation.account.get.decode",
  });
});
test("GP009 maps only safe not-found; unrelated SQL failures retain typed failure instead of empty page", async () => {
  expect(
    failure(
      await Effect.runPromiseExit(
        fixture(null, "GP009").account.get({
          accountId: "B",
          participationId: item.participation_id,
        }),
      ),
    ),
  ).toMatchObject({ _tag: "GuestParticipationStoreRejected", reason: "not-found" });
  expect(
    failure(
      await Effect.runPromiseExit(
        fixture(null, "42702").account.get({
          accountId: "B",
          participationId: item.participation_id,
        }),
      ),
    ),
  ).toMatchObject({ _tag: "ControlPlaneStatementFailed", sqlState: "42702" });
});
