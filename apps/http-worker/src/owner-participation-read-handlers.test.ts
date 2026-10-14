import { expect, test } from "bun:test";
import { PERSONA_WALLET_SETUP_SESSION_SCOPE } from "@pirate/application/use-cases/identity-registration-handler";
import type { OwnerParticipationReadStore } from "@pirate/application/use-cases/owner-financial-study";
import { AuthError, BadRequest, GuestParticipationProjectionV1 } from "@pirate/contracts";
import { Effect, Schema } from "effect";
import { makeOwnerParticipationReadHandlers } from "./owner-participation-read-handlers.ts";
import type { Principal } from "./transport.ts";

const item = Schema.decodeUnknownSync(GuestParticipationProjectionV1)({
  participation_id: "original-admission",
  pool_leg_id: "original-leg",
  original_drawing_id: "7",
  admission_state: "admitted",
  purchase_state: "not_requested",
  purchase_safety_deadline_at: "2026-10-13T00:00:00.000Z",
  reconciliation_state: "resolved",
  purchase_deadline_passed: true,
  allocation_id: null,
  credit_id: null,
  amount_atomic: null,
});
function fixture() {
  const actors: string[] = [];
  const store: OwnerParticipationReadStore = {
    list: (input) =>
      Effect.sync(() => {
        actors.push(input.accountId);
        return { object: "owner_participation_list_v1" as const, items: [item], next_cursor: null };
      }),
    get: (input) =>
      Effect.sync(() => {
        actors.push(input.accountId);
        return item;
      }),
  };
  return { handlers: makeOwnerParticipationReadHandlers(store), actors };
}
test("ordinary browser principal reads original draw before allocation without Guest proof", async () => {
  const f = fixture();
  const result = await f.handlers.ListMyOwnerParticipationsV1({
    principal: { kind: "user", subject: "canonical-B" },
    params: {},
    query: { limit: "25" },
    body: undefined,
  });
  expect(result).toEqual({
    object: "owner_participation_list_v1",
    items: [item],
    next_cursor: null,
  });
  expect(f.actors).toEqual(["canonical-B"]);
});
test("Guest/anonymous/device/admin/setup caller never reaches Account private reader", async () => {
  const principals: readonly (Principal | null)[] = [
    null,
    { kind: "device", subject: "device" },
    { kind: "admin", subject: "operator" },
    { kind: "user", subject: "setup", scopes: [PERSONA_WALLET_SETUP_SESSION_SCOPE] },
  ];
  for (const principal of principals) {
    const f = fixture();
    await expect(
      Promise.resolve().then(() =>
        f.handlers.ListMyOwnerParticipationsV1({
          principal,
          params: {},
          query: {},
          body: undefined,
        }),
      ),
    ).rejects.toBeInstanceOf(AuthError);
    expect(f.actors).toEqual([]);
  }
});
test("caller ownership/Guest proof fields and excessive limit refuse before private source", async () => {
  for (const query of [
    { account_id: "foreign" },
    { owner_id: "foreign" },
    { guest_credential_id: "raw-proof" },
    { limit: "101" },
  ]) {
    const f = fixture();
    await expect(
      Promise.resolve().then(() =>
        f.handlers.ListMyOwnerParticipationsV1({
          principal: { kind: "user", subject: "B" },
          params: {},
          query,
          body: undefined,
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequest);
    expect(f.actors).toEqual([]);
  }
});
