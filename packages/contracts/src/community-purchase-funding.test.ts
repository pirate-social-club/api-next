import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  BeginCommunityPurchaseFunding,
  GetCommunityPurchaseFundingStatus,
  ObserveCommunityPurchaseFunding,
} from "./community-purchase-funding.ts";

describe("community purchase funding HTTP contracts", () => {
  test("keeps public inputs reference-only and user authenticated", () => {
    expect(BeginCommunityPurchaseFunding.auth.policy.kind).toBe("user");
    expect(ObserveCommunityPurchaseFunding.auth.policy.kind).toBe("user");
    expect(GetCommunityPurchaseFundingStatus.auth.policy.kind).toBe("user");
    const begin = BeginCommunityPurchaseFunding.request?.body;
    if (begin === undefined) throw new Error("begin body missing");
    expect(
      Schema.decodeUnknownSync(begin)({ quote_id: "quote_1", client_nonce: "nonce_1" }),
    ).toEqual({ quote_id: "quote_1", client_nonce: "nonce_1" });
    expect(
      Schema.decodeUnknownSync(begin)({
        quote_id: "quote_1",
        client_nonce: "nonce_1",
        amount_atomic: "1",
      }),
    ).toEqual({ quote_id: "quote_1", client_nonce: "nonce_1" });
  });

  test("accepts only an operation reference and transaction hash for observation", () => {
    const body = ObserveCommunityPurchaseFunding.request?.body;
    if (body === undefined) throw new Error("observation body missing");
    expect(Schema.decodeUnknownSync(body)({ transaction_hash: `0x${"ab".repeat(32)}` })).toEqual({
      transaction_hash: `0x${"ab".repeat(32)}`,
    });
    expect(
      Schema.decodeUnknownSync(body)({
        transaction_hash: `0x${"ab".repeat(32)}`,
        evidence: { amount_atomic: "1" },
      }),
    ).toEqual({ transaction_hash: `0x${"ab".repeat(32)}` });
  });
});
