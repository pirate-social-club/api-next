import { expect, test } from "bun:test";
import { PERSONA_WALLET_SETUP_SESSION_SCOPE } from "@pirate/application/use-cases/identity-registration-handler";
import type { OwnerRewardCreditReadStore } from "@pirate/application/use-cases/owner-financial-study";
import { AuthError, BadRequest, OwnerRewardCreditV1 } from "@pirate/contracts";
import { Effect, Schema } from "effect";
import { makeOwnerRewardCreditReadHandlers } from "./owner-reward-credit-read-handlers.ts";
import type { Principal } from "./transport.ts";

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

function fixture() {
  const accounts: string[] = [];
  const store: OwnerRewardCreditReadStore = {
    list: (input) =>
      Effect.sync(() => {
        accounts.push(input.accountId);
        return {
          object: "owner_reward_credit_list_v1" as const,
          items: [credit],
          next_cursor: null,
        };
      }),
    get: (input) =>
      Effect.sync(() => {
        accounts.push(input.accountId);
        return credit;
      }),
  };
  return { handlers: makeOwnerRewardCreditReadHandlers(store), accounts };
}
test("other browser ordinary canonical account is sole ownership input; zero Guest credentials are required", async () => {
  const f = fixture();
  const result = await f.handlers.ListMyOwnerRewardCreditsV1({
    principal: { kind: "user", subject: "canonical-B" },
    params: {},
    query: { limit: "25" },
    body: undefined,
  });
  expect(result).toMatchObject({ object: "owner_reward_credit_list_v1", items: [credit] });
  expect(f.accounts).toEqual(["canonical-B"]);
});
test("anonymous/device/admin/setup-purpose callers refuse before any private lookup", async () => {
  const principals: readonly (Principal | null)[] = [
    null,
    { kind: "device", subject: "machine" },
    { kind: "admin", subject: "operator" },
    { kind: "user", subject: "setup", scopes: [PERSONA_WALLET_SETUP_SESSION_SCOPE] },
  ];
  for (const principal of principals) {
    const f = fixture();
    await expect(
      Promise.resolve().then(() =>
        f.handlers.ListMyOwnerRewardCreditsV1({
          principal,
          params: {},
          query: {},
          body: undefined,
        }),
      ),
    ).rejects.toBeInstanceOf(AuthError);
    expect(f.accounts).toEqual([]);
  }
});
test("caller supplied ownership in query and invalid limits never reach private store", async () => {
  for (const query of [{ account_id: "foreign" }, { limit: "101" }, { limit: "0" }]) {
    const f = fixture();
    await expect(
      Promise.resolve().then(() =>
        f.handlers.ListMyOwnerRewardCreditsV1({
          principal: { kind: "user", subject: "B" },
          params: {},
          query,
          body: undefined,
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequest);
    expect(f.accounts).toEqual([]);
  }
});
