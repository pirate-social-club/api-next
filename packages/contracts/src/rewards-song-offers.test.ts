import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  AddMegapotPoolLeg,
  MegapotFundingV1,
  ObserveMegapotPoolFunding,
  OpenSongRewardOffer,
} from "./rewards-song-offers.ts";

const strict = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
  Schema.decodeUnknownSync(schema, { onExcessProperty: "error" });

describe("song reward offer contracts", () => {
  test("accepts pool terms but never a client-selected custody or ticket recipient", () => {
    const body = AddMegapotPoolLeg.request?.body;
    if (body === undefined) throw new Error("pool body missing");
    const request = {
      idempotency_key: "pool_1",
      persona_id: "persona_1",
      funding_amount_atomic: "5000000",
      max_ticket_price_atomic: "1000000",
      entry_cutoff_seconds: 300,
      eligible_activities: ["study", "karaoke"],
      min_score_bps: 7_000,
      empty_pool_policy: "no_purchase",
      fallback_payout_persona_id: null,
      fallback_disclosure_acknowledged: false,
    } as const;
    expect(strict(body)(request)).toEqual(request);
    expect(() =>
      strict(body)({
        ...request,
        custody_address: `0x${"1".repeat(40)}`,
        ticket_recipient: `0x${"2".repeat(40)}`,
      }),
    ).toThrow();
  });

  test("uses Fund with USDC semantics and Pirate custody as the funding recipient", () => {
    const decoded = Schema.decodeUnknownSync(MegapotFundingV1)({
      object: "megapot_pool_funding",
      action: "fund_with_usdc",
      funding_effect_id: "funding_1",
      leg_id: "leg_1",
      status: "planned",
      chain_id: 84_532,
      token_address: `0x${"1".repeat(40)}`,
      token_decimals: 6,
      sender_address: `0x${"2".repeat(40)}`,
      recipient_address: `0x${"3".repeat(40)}`,
      expected_amount_atomic: "5000000",
      confirmed_amount_atomic: null,
      required_confirmations: 3,
      transaction_hash: null,
    });
    expect(decoded.action).toBe("fund_with_usdc");
    expect(JSON.stringify(decoded)).not.toContain("send_ticket");
    expect(JSON.stringify(decoded)).not.toContain("ticket_owner");
  });

  test("keeps commands persona-scoped and observation evidence reference-only", () => {
    expect(OpenSongRewardOffer.auth.policy.kind).toBe("user");
    expect(AddMegapotPoolLeg.auth.policy.kind).toBe("user");
    const body = ObserveMegapotPoolFunding.request?.body;
    if (body === undefined) throw new Error("observation body missing");
    expect(
      strict(body)({
        idempotency_key: "observe_1",
        persona_id: "persona_1",
        transaction_hash: `0x${"4".repeat(64)}`,
      }),
    ).toEqual({
      idempotency_key: "observe_1",
      persona_id: "persona_1",
      transaction_hash: `0x${"4".repeat(64)}`,
    });
  });
});
