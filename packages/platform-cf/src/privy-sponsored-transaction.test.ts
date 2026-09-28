import { describe, expect, test } from "bun:test";
import {
  findPrivySponsoredTransactionByReference,
  type PrivySponsoredFetcher,
  PrivySponsoredOutcomeUnknown,
  preparePrivySponsoredEvmCall,
  submitPrivySponsoredEvmCall,
} from "./privy-sponsored-transaction.ts";

const input = {
  appId: "app_staging",
  walletId: "wallet_persona_123",
  chainId: 84_532,
  to: "0x1111111111111111111111111111111111111111",
  data: `0xa9059cbb${"0".repeat(127)}1`,
  referenceId: "sponsored_opaque_12345678",
  idempotencyKey: "sponsored_attempt_12345678",
  expiresAtMs: 1_800_000,
} as const;

describe("Privy sponsored request boundary", () => {
  test("signs the exact wallet, chain, call, reference, idempotency key and expiry", () => {
    const prepared = preparePrivySponsoredEvmCall(input, 1_600_000);
    const signed = JSON.parse(atob(prepared.authorizationPayloadBase64)) as {
      url: string;
      body: { reference_id: string; sponsor: boolean; params: { transaction: { data: string } } };
      headers: Record<string, string>;
    };
    expect(signed.url).toBe("https://api.privy.io/v1/wallets/wallet_persona_123/rpc");
    expect(signed.body).toEqual(prepared.body);
    expect(signed.body.sponsor).toBe(true);
    expect(signed.body.reference_id).toBe(input.referenceId);
    expect(signed.body.params.transaction.data).toBe(input.data);
    expect(signed.headers).toEqual(prepared.headers);
    expect(prepared.headers["privy-request-expiry"]).toBe("1800000");
  });

  test("refuses a changed call before contacting Privy", async () => {
    const prepared = preparePrivySponsoredEvmCall(input, 1_600_000);
    const changed = {
      ...prepared,
      body: {
        ...prepared.body,
        params: { transaction: { ...prepared.body.params.transaction, data: "0xa9059cbb00" } },
      },
    };
    let called = false;
    const fetcher: PrivySponsoredFetcher = async () => {
      called = true;
      return new Response(null, { status: 200 });
    };
    await expect(
      submitPrivySponsoredEvmCall(changed, "dGVzdA==", "app_secret_12345", fetcher),
    ).rejects.toThrow("prepared Privy request changed after authorization");
    expect(called).toBe(false);
  });

  test("submits only the signed body and retains the provider operation without a transaction hash", async () => {
    const prepared = preparePrivySponsoredEvmCall(input, 1_600_000);
    const sent: Array<{ url: string; init: RequestInit }> = [];
    const fetcher: PrivySponsoredFetcher = async (url, init) => {
      sent.push({ url, init });
      return Response.json({
        method: "eth_sendTransaction",
        data: {
          caip2: "eip155:84532",
          reference_id: input.referenceId,
          hash: "",
          transaction_id: "privy_transaction_1",
          user_operation_hash: `0x${"ab".repeat(32)}`,
        },
      });
    };
    const result = await submitPrivySponsoredEvmCall(
      prepared,
      "dGVzdA==",
      "app_secret_12345",
      fetcher,
    );
    expect(result.transactionId).toBe("privy_transaction_1");
    expect(result.transactionHash).toBeNull();
    expect(result.userOperationHash).toBe(`0x${"ab".repeat(32)}`);
    expect(sent[0]?.url).toBe(prepared.url);
    expect(sent[0]?.init.body).toBe(JSON.stringify(prepared.body));
    expect(
      (sent[0]?.init.headers as Record<string, string> | undefined)?.["privy-idempotency-key"],
    ).toBe(input.idempotencyKey);
  });

  test("keeps a lost response outcome unknown", async () => {
    const prepared = preparePrivySponsoredEvmCall(input, 1_600_000);
    const fetcher: PrivySponsoredFetcher = async () => {
      throw new Error("connection closed");
    };
    await expect(
      submitPrivySponsoredEvmCall(prepared, "dGVzdA==", "app_secret_12345", fetcher),
    ).rejects.toBeInstanceOf(PrivySponsoredOutcomeUnknown);
  });

  test("looks up the opaque reference and binds the result to the reserved wallet", async () => {
    const lookup = {
      appId: input.appId,
      appSecret: "app_secret_12345",
      walletId: input.walletId,
      chainId: input.chainId,
      referenceId: input.referenceId,
    };
    const fetcher: PrivySponsoredFetcher = async (url, init) => {
      expect(url).toBe(`https://api.privy.io/v1/transactions?reference_id=${input.referenceId}`);
      expect(init.method).toBe("GET");
      return Response.json({
        transactions: [
          {
            id: "privy_transaction_1",
            wallet_id: input.walletId,
            caip2: "eip155:84532",
            reference_id: input.referenceId,
            status: "pending",
            transaction_hash: null,
          },
        ],
      });
    };
    expect(await findPrivySponsoredTransactionByReference(lookup, fetcher)).toEqual({
      id: "privy_transaction_1",
      walletId: input.walletId,
      referenceId: input.referenceId,
      caip2: "eip155:84532",
      status: "pending",
      transactionHash: null,
    });
    // Privy's published list example omits reference_id from each item. The
    // filtered endpoint itself still binds this sole item to the query.
    const omittedReference: PrivySponsoredFetcher = async () =>
      Response.json({
        transactions: [
          {
            id: "privy_transaction_1",
            wallet_id: input.walletId,
            caip2: "eip155:84532",
            status: "pending",
            transaction_hash: null,
          },
        ],
      });
    expect((await findPrivySponsoredTransactionByReference(lookup, omittedReference))?.id).toBe(
      "privy_transaction_1",
    );
    const wrongReference: PrivySponsoredFetcher = async () =>
      Response.json({
        transactions: [
          {
            id: "privy_transaction_1",
            wallet_id: input.walletId,
            caip2: "eip155:84532",
            reference_id: "wrong_reference_12345678",
            status: "pending",
            transaction_hash: null,
          },
        ],
      });
    await expect(
      findPrivySponsoredTransactionByReference(lookup, wrongReference),
    ).rejects.toBeInstanceOf(PrivySponsoredOutcomeUnknown);
    const foreign: PrivySponsoredFetcher = async () =>
      Response.json({
        transactions: [
          {
            id: "privy_transaction_1",
            wallet_id: "wallet_foreign",
            caip2: "eip155:84532",
            reference_id: input.referenceId,
            status: "pending",
            transaction_hash: null,
          },
        ],
      });
    await expect(findPrivySponsoredTransactionByReference(lookup, foreign)).rejects.toBeInstanceOf(
      PrivySponsoredOutcomeUnknown,
    );
  });

  test("returns no provider observation for a missing reference", async () => {
    const result = await findPrivySponsoredTransactionByReference(
      {
        appId: input.appId,
        appSecret: "app_secret_12345",
        walletId: input.walletId,
        chainId: input.chainId,
        referenceId: input.referenceId,
      },
      async () => Response.json({ transactions: [] }),
    );
    expect(result).toBeNull();
  });
});
