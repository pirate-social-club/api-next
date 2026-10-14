import { expect, test } from "bun:test";
import { OwnerRewardCreditV1 } from "@pirate/contracts";
import { Cause, Effect, Exit, Option, Schema } from "effect";
import { makeControlPlaneOwnerRewardCreditReads } from "./owner-reward-credit-read-store.ts";
import {
  makeDirectPostgresControlPlaneLayer,
  type PostgresClientLike,
  type PostgresQueryConfig,
} from "./postgres.ts";

const owner = "owner_00000000-0000-0000-0000-000000000001";
const credit = Schema.decodeUnknownSync(OwnerRewardCreditV1)({
  object: "owner_reward_credit_v1",
  credit_id: "credit-1",
  identity_version: "owner_v1",
  owner_id: owner,
  community_id: "community-1",
  pool_leg_id: "leg-1",
  original_drawing_id: "7",
  chain_id: 1,
  token_address: `0x${"1".repeat(40)}`,
  token_decimals: 6,
  amount_atomic: "5",
  available_atomic: "5",
  reserved_atomic: "0",
  paid_atomic: "0",
  source_kind: "megapot_allocation",
  state: "credited",
  created_at: "2026-10-13T00:00:00.000Z",
  updated_at: "2026-10-13T00:00:00.000Z",
  settled_at: null,
  claim: { status: "accepted", payout_status: "pending" },
  send: null,
  recipient: {
    kind: "account_owner",
    original_persona_id: "persona-1",
    selection: null,
    binding: {
      persona_id: "persona-1",
      bound_at: "2026-10-13T00:00:00.000Z",
      selection_revision: null,
    },
  },
});

function fixture(reply: unknown) {
  const queries: PostgresQueryConfig[] = [];
  const client: PostgresClientLike = {
    connect: async () => {},
    end: async () => {},
    query: async (query) => {
      queries.push(query);
      return { rows: [{ result: reply }], rowCount: 1 };
    },
  };
  const layer = makeDirectPostgresControlPlaneLayer("postgres://fixture.invalid/readonly", {
    clientFactory: () => client,
  });
  return { store: makeControlPlaneOwnerRewardCreditReads(layer), queries };
}
function failure(exit: Awaited<ReturnType<typeof Effect.runPromiseExit>>) {
  if (!Exit.isFailure(exit)) throw Error("expected refusal");
  const error = Cause.findErrorOption(exit.cause);
  if (!Option.isSome(error)) throw Error("expected typed refusal");
  return error.value;
}
test("account-only reader sends canonical authenticated actor and bounded cursor, original credit has NULL persona ledger identity", async () => {
  const reply = {
    object: "owner_reward_credit_list_v1",
    items: [credit],
    next_cursor: null,
  } as const;
  const f = fixture(reply);
  expect(
    await Effect.runPromise(
      f.store.list({ accountId: "authenticated-B", cursor: null, limit: 25 }),
    ),
  ).toEqual(reply);
  expect(
    f.queries.some(
      (q) =>
        q.text === "SELECT list_owned_reward_credits_v1($1,$2,$3) AS result" &&
        JSON.stringify(q.values) === JSON.stringify(["authenticated-B", null, 25]),
    ),
  ).toBe(true);
});
test("duplicate IDs, excessive page, foreign cursor correlation and private excess metadata fail strict decoding", async () => {
  for (const reply of [
    { object: "owner_reward_credit_list_v1", items: [credit, credit], next_cursor: null },
    { object: "owner_reward_credit_list_v1", items: [credit], next_cursor: "foreign-credit" },
    {
      object: "owner_reward_credit_list_v1",
      items: [credit],
      next_cursor: null,
      leaf_salt: "private",
    },
  ]) {
    const f = fixture(reply);
    const exit = await Effect.runPromiseExit(
      f.store.list({ accountId: "B", cursor: null, limit: 1 }),
    );
    expect(failure(exit)).toMatchObject({
      _tag: "ControlPlaneStatementFailed",
      label: "owner-reward-credit.list.decode",
    });
    expect(JSON.stringify(failure(exit))).not.toContain("private");
  }
});
test("detail cannot return a different original credit after a successful SQL query", async () => {
  const exit = await Effect.runPromiseExit(
    fixture(credit).store.get({ accountId: "B", creditId: "foreign-credit" }),
  );
  expect(failure(exit)).toMatchObject({
    _tag: "ControlPlaneStatementFailed",
    label: "owner-reward-credit.get.decode",
  });
});
