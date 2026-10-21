import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { WalletSendVerificationRequired } from "./wallet-send-palm.ts";
import type { SponsoredSendRecord } from "./wallet-sponsored-send-repository.ts";
import { makeWalletSponsoredSendService } from "./wallet-sponsored-send-service.ts";

const address = (byte: string) => `0x${byte.repeat(20)}`;
const initial: SponsoredSendRecord = {
  sendId: "send-1",
  accountId: "account",
  personaId: "persona",
  walletAssignmentId: "assignment",
  walletId: "wallet_12345678",
  chainId: 84532,
  senderAddress: address("a1"),
  tokenAddress: address("0a"),
  recipientAddress: address("d1"),
  amountAtomic: 1n,
  gasBudgetWei: 1n,
  referenceId: "reference_1234567890",
  idempotencyKey: "idempotency",
  providerIdempotencyKey: "idempotency_1234567890",
  expiresAtMs: Date.now() + 180000,
  status: "reserved",
  providerTransactionId: null,
  userOperationHash: null,
  transactionHash: null,
  blockNumber: null,
  blockHash: null,
};

function fixture() {
  let record = { ...initial };
  let verified = true;
  let revokeOnBalance = false;
  let balanceReads = 0;
  let submissions = 0;
  let transitions = 0;
  const service = makeWalletSponsoredSendService({
    appId: "test-app",
    appSecret: "test-secret",
    eligibleAsset: { chainId: 84532, tokenAddress: address("0a") },
    ids: () => "next",
    requiredConfirmations: 1,
    store: {
      hasCurrentPalm: () => Effect.succeed(verified),
      get: () => Effect.succeed(record),
      findByPersona: () => Effect.succeed(record),
      reserve: () =>
        verified
          ? Effect.succeed(record)
          : Effect.fail(new WalletSendVerificationRequired(record.personaId)),
      markSubmitting: () => {
        if (!verified) return Effect.fail(new WalletSendVerificationRequired(record.personaId));
        record = { ...record, status: "submitting" };
        transitions++;
        return Effect.succeed(undefined);
      },
      markHeld: () => {
        record = { ...record, status: "held" };
        return Effect.succeed(undefined);
      },
      recordSubmission: () => Effect.succeed(undefined),
      attachObservation: () => Effect.succeed(undefined),
      recordFinal: () => Effect.succeed(undefined),
      abandonUnsigned: () => Effect.succeed(undefined),
    },
    chain: {
      readTokenBalance: async () => {
        balanceReads++;
        if (revokeOnBalance) verified = false;
        return 10n;
      },
      readReceipt: async () => null,
      readHead: async () => 1n,
      readFinalizedHead: async () => 1n,
    },
    submit: async () => {
      submissions++;
      throw Error("uncertain provider outcome");
    },
    findByReference: async () => null,
  });
  return {
    service,
    revoke: () => {
      verified = false;
    },
    revokeOnBalance: () => {
      revokeOnBalance = true;
    },
    counts: () => ({ balanceReads, submissions, transitions }),
    record: () => record,
  };
}

describe("Send Palm and provider boundary", () => {
  test("unverified callers receive no authorization and cause no balance or submission calls", async () => {
    const f = fixture();
    f.revoke();
    expect(await f.service.get({ accountId: "account", sendId: "send-1" })).toMatchObject({
      authorization: null,
      verificationRequired: true,
    });
    await expect(
      f.service.submit({ accountId: "account", sendId: "send-1", signature: "YWJj" }),
    ).rejects.toThrow("Palm verification required");
    expect(f.counts()).toEqual({ balanceReads: 0, submissions: 0, transitions: 0 });
    expect(f.record().status).toBe("reserved");
  });

  test("revocation during the balance read is rejected by the atomic final guard", async () => {
    const f = fixture();
    f.revokeOnBalance();
    await expect(
      f.service.submit({ accountId: "account", sendId: "send-1", signature: "YWJj" }),
    ).rejects.toThrow("Palm verification required");
    expect(f.counts()).toEqual({ balanceReads: 1, submissions: 0, transitions: 0 });
    expect(f.record().status).toBe("reserved");
  });

  test("an admitted unknown outcome stays held and readable after revocation", async () => {
    const f = fixture();
    await expect(
      f.service.submit({ accountId: "account", sendId: "send-1", signature: "YWJj" }),
    ).rejects.toThrow();
    expect(f.record().status).toBe("held");
    f.revoke();
    expect(
      await f.service.getForPersona({ accountId: "account", personaId: "persona" }),
    ).toMatchObject({
      record: { status: "held" },
      authorization: null,
      verificationRequired: false,
    });
    await expect(
      f.service.submit({ accountId: "account", sendId: "send-1", signature: "YWJj" }),
    ).rejects.toThrow("conflict");
    expect(f.counts()).toEqual({ balanceReads: 1, submissions: 1, transitions: 1 });
  });
});
