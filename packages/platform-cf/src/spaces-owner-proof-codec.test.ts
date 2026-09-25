import { describe, expect, it } from "bun:test";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
  spacesOwnerChallengeDigestV1,
  spacesOwnerChallengeMessageV1,
  spacesOwnerPollRequestHashV1,
  spacesOwnerSignatureValidV1,
  spacesOwnerStartRequestHashV1,
} from "./spaces-owner-proof-codec.ts";

describe("Spaces owner-proof byte encoding", () => {
  it("matches the ratified message, prefixed digest, and start hash vectors", () => {
    const message = spacesOwnerChallengeMessageV1({
      environment: "staging",
      canonicalRoot: "yahoo",
      communityId: "community_test_01",
      ceremonyId: "spaces_owner_01",
      generation: 1,
      nonceHex: "11".repeat(32),
      rootOutpoint: `${"22".repeat(32)}:0`,
      rootKeyHex: "33".repeat(32),
      expiresAt: "2026-09-25T12:10:00.000Z",
    });
    expect(message).toBe(
      `["pirate-spaces-root-owner-v1","staging","mainnet","yahoo","community_test_01","spaces_owner_01",1,"${"11".repeat(32)}","${"22".repeat(32)}:0","${"33".repeat(32)}","2026-09-25T12:10:00.000Z"]`,
    );
    expect(spacesOwnerChallengeDigestV1(message)).toBe(
      "30bd8b079c99b3adeff4faed733a2bf7dce165b2ad662b935793dde5a323eb51",
    );
    expect(
      spacesOwnerStartRequestHashV1({
        environment: "staging",
        accountId: "account_test_01",
        communityId: "community_test_01",
        canonicalRoot: "yahoo",
        idempotencyKey: "intent_test_01",
      }),
    ).toBe("316e5dce80ce1f084f0e62b203ede80fafbea4c9843b8118429583454aa213a2");
  });

  it("binds poll replay to every supplied member", () => {
    const request = {
      ceremonyId: "spaces_owner_01",
      generation: 1,
      idempotencyKey: "poll_01",
      signatureHex: "aa".repeat(64),
    };
    const hash = spacesOwnerPollRequestHashV1(request);
    expect(spacesOwnerPollRequestHashV1(request)).toBe(hash);
    expect(spacesOwnerPollRequestHashV1({ ...request, signatureHex: "bb".repeat(64) })).not.toBe(
      hash,
    );
    expect(spacesOwnerPollRequestHashV1({ ...request, generation: 2 })).not.toBe(hash);
  });

  it("checks the prefixed digest with BIP-340 and rejects changed bytes", () => {
    const secretKey = Buffer.from("03".repeat(32), "hex");
    const rootKeyHex = Buffer.from(schnorr.getPublicKey(secretKey)).toString("hex");
    const digestHex = spacesOwnerChallengeDigestV1("staging test challenge");
    const signatureHex = Buffer.from(
      schnorr.sign(Buffer.from(digestHex, "hex"), secretKey),
    ).toString("hex");
    expect(spacesOwnerSignatureValidV1(digestHex, rootKeyHex, signatureHex)).toBe(true);
    expect(spacesOwnerSignatureValidV1("00".repeat(32), rootKeyHex, signatureHex)).toBe(false);
    expect(spacesOwnerSignatureValidV1(digestHex, "11".repeat(32), signatureHex)).toBe(false);
    expect(spacesOwnerSignatureValidV1(digestHex, rootKeyHex, "aa".repeat(64))).toBe(false);
    expect(spacesOwnerSignatureValidV1(digestHex, rootKeyHex, signatureHex.toUpperCase())).toBe(
      false,
    );
  });
});
