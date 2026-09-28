import { Effect } from "effect";
import { getAddress } from "viem";
import {
  findPrivySponsoredTransactionByReference,
  type PreparedPrivySponsoredEvmCall,
  PrivySponsoredOutcomeUnknown,
  type PrivySponsoredSubmission,
  type PrivySponsoredTransactionObservation,
  submitPrivySponsoredEvmCall,
} from "./privy-sponsored-transaction.ts";
import {
  type makeControlPlaneSponsoredSendStore,
  type SponsoredSendRecord,
  SponsoredSendRefused,
} from "./reward-sponsored-send-repository.ts";
import { prepareRewardSponsoredSendRequest } from "./reward-sponsored-send-request.ts";

type Store = ReturnType<typeof makeControlPlaneSponsoredSendStore>;

export type SponsoredSendReceipt = Readonly<{
  canonical: boolean;
  status: "success" | "reverted";
  transactionHash: string;
  blockNumber: bigint;
  blockHash: string;
  transfers: readonly Readonly<{
    tokenAddress: string;
    from: string;
    to: string;
    amountAtomic: bigint;
  }>[];
}>;

export type SponsoredSendChain = Readonly<{
  readReceipt: (transactionHash: string) => Promise<SponsoredSendReceipt | null>;
  readFinalizedHead: () => Promise<bigint>;
  readHead: () => Promise<bigint>;
}>;

export type SponsoredSendView = Readonly<{
  record: SponsoredSendRecord;
  authorization: Readonly<{
    walletId: string;
    payloadBase64: string;
  }> | null;
}>;

export class SponsoredSendUnavailable extends Error {
  constructor() {
    super("sponsored send provider is unavailable");
    this.name = "SponsoredSendUnavailable";
  }
}

function exactTransfer(record: SponsoredSendRecord, receipt: SponsoredSendReceipt): boolean {
  const matches = receipt.transfers.filter(
    (log) =>
      log.tokenAddress.toLowerCase() === record.tokenAddress &&
      log.from.toLowerCase() === record.senderAddress &&
      log.to.toLowerCase() === record.recipientAddress &&
      log.amountAtomic === record.amountAtomic,
  );
  return matches.length === 1;
}

export function makeRewardSponsoredSendService(
  input: Readonly<{
    store: Store;
    appId: string;
    appSecret: string;
    chain: SponsoredSendChain;
    requiredConfirmations: number;
    ids: () => string;
    now?: () => number;
    submit?: (
      prepared: PreparedPrivySponsoredEvmCall,
      signature: string,
      appSecret: string,
    ) => Promise<PrivySponsoredSubmission>;
    findByReference?: (query: {
      appId: string;
      appSecret: string;
      walletId: string;
      chainId: number;
      referenceId: string;
    }) => Promise<PrivySponsoredTransactionObservation | null>;
  }>,
) {
  if (!Number.isSafeInteger(input.requiredConfirmations) || input.requiredConfirmations < 1) {
    throw new Error("invalid sponsored send confirmation depth");
  }
  const now = input.now ?? Date.now;
  const submit = input.submit ?? submitPrivySponsoredEvmCall;
  const findByReference = input.findByReference ?? findPrivySponsoredTransactionByReference;

  function authorization(record: SponsoredSendRecord): SponsoredSendView["authorization"] {
    if (record.status !== "reserved" || record.expiresAtMs <= now()) return null;
    const prepared = prepareRewardSponsoredSendRequest(
      {
        walletId: record.walletId,
        chainId: record.chainId,
        senderAddress: record.senderAddress,
        tokenAddress: record.tokenAddress,
        recipientAddress: record.recipientAddress,
        amountAtomic: record.amountAtomic,
        paidAtomic: record.paidAtomic,
        referenceId: record.referenceId,
        idempotencyKey: record.providerIdempotencyKey,
        expiresAtMs: record.expiresAtMs,
      },
      input.appId,
      now(),
    );
    return { walletId: record.walletId, payloadBase64: prepared.authorizationPayloadBase64 };
  }

  async function observe(record: SponsoredSendRecord): Promise<SponsoredSendRecord> {
    if (record.status === "reserved" && record.expiresAtMs < now()) {
      try {
        await Effect.runPromise(
          input.store.abandonUnsigned({ accountId: record.accountId, sendId: record.sendId }),
        );
        return (
          (await Effect.runPromise(
            input.store.get({ accountId: record.accountId, sendId: record.sendId }),
          )) ?? record
        );
      } catch {
        // A concurrent submit may have won; reread before returning status.
        return (
          (await Effect.runPromise(
            input.store.get({ accountId: record.accountId, sendId: record.sendId }),
          )) ?? record
        );
      }
    }
    if (
      record.status === "reserved" ||
      record.status === "abandoned" ||
      record.status === "confirmed" ||
      record.status === "reverted"
    )
      return record;
    let provider: PrivySponsoredTransactionObservation | null;
    try {
      provider = await findByReference({
        appId: input.appId,
        appSecret: input.appSecret,
        walletId: record.walletId,
        chainId: record.chainId,
        referenceId: record.referenceId,
      });
    } catch {
      return record;
    }
    if (provider === null || provider.transactionHash === null) return record;
    const transactionHash = provider.transactionHash.toLowerCase();
    if (!/^0x[0-9a-f]{64}$/u.test(transactionHash)) return record;
    try {
      // A crash can leave the committed pre-submit state behind after Privy
      // accepted the request. Move it to the existing held state before
      // attaching provider evidence; submitting deliberately has none.
      if (record.status === "submitting") {
        await Effect.runPromise(
          input.store.markHeld({ accountId: record.accountId, sendId: record.sendId }),
        );
      }
      await Effect.runPromise(
        input.store.attachObservation({
          accountId: record.accountId,
          sendId: record.sendId,
          providerTransactionId: provider.id,
          transactionHash,
        }),
      );
    } catch {
      return record;
    }
    let receipt: SponsoredSendReceipt | null;
    let head: bigint;
    let finalized: bigint;
    try {
      [receipt, head, finalized] = await Promise.all([
        input.chain.readReceipt(transactionHash),
        input.chain.readHead(),
        input.chain.readFinalizedHead(),
      ]);
    } catch {
      return record;
    }
    if (
      receipt === null ||
      !receipt.canonical ||
      receipt.transactionHash.toLowerCase() !== transactionHash ||
      receipt.blockNumber > finalized ||
      head < receipt.blockNumber ||
      head - receipt.blockNumber + 1n < BigInt(input.requiredConfirmations)
    )
      return record;
    const outcome =
      receipt.status === "reverted"
        ? "reverted"
        : exactTransfer(record, receipt)
          ? "confirmed"
          : null;
    if (outcome === null) return record;
    try {
      await Effect.runPromise(
        input.store.recordFinal({
          accountId: record.accountId,
          sendId: record.sendId,
          outcome,
          transactionHash,
          blockNumber: receipt.blockNumber,
          blockHash: receipt.blockHash.toLowerCase(),
        }),
      );
      return (
        (await Effect.runPromise(
          input.store.get({
            accountId: record.accountId,
            sendId: record.sendId,
          }),
        )) ?? record
      );
    } catch {
      return record;
    }
  }

  return {
    reserve: async (request: {
      accountId: string;
      creditId: string;
      recipientAddress: string;
      amountAtomic: bigint;
      idempotencyKey: string;
    }): Promise<SponsoredSendView> => {
      let recipientAddress: string;
      try {
        recipientAddress = getAddress(request.recipientAddress).toLowerCase();
      } catch {
        throw new SponsoredSendRefused("ineligible");
      }
      const record = await Effect.runPromise(
        input.store.reserve({
          ...request,
          recipientAddress,
          sendId: `sponsored_${input.ids()}`,
          referenceId: `sponsor_${input.ids()}`,
          providerIdempotencyKey: `sponsor_${input.ids()}`,
        }),
      );
      return { record, authorization: authorization(record) };
    },
    get: async (request: { accountId: string; sendId: string }): Promise<SponsoredSendView> => {
      const record = await Effect.runPromise(input.store.get(request));
      if (record === null) throw new SponsoredSendRefused("not-found");
      const observed = await observe(record);
      return { record: observed, authorization: authorization(observed) };
    },
    getForCredit: async (request: {
      accountId: string;
      creditId: string;
    }): Promise<SponsoredSendView> => {
      const record = await Effect.runPromise(input.store.findByCredit(request));
      if (record === null) throw new SponsoredSendRefused("not-found");
      const observed = await observe(record);
      return { record: observed, authorization: authorization(observed) };
    },
    submit: async (request: {
      accountId: string;
      sendId: string;
      signature: string;
    }): Promise<SponsoredSendView> => {
      const record = await Effect.runPromise(input.store.get(request));
      if (record === null) throw new SponsoredSendRefused("not-found");
      if (record.status !== "reserved" || record.expiresAtMs <= now()) {
        throw new SponsoredSendRefused("conflict");
      }
      if (
        !/^[A-Za-z0-9+/]+={0,2}$/u.test(request.signature) ||
        request.signature.length > 4096 ||
        request.signature.length % 4 !== 0
      ) {
        throw new SponsoredSendRefused("ineligible");
      }
      const prepared = prepareRewardSponsoredSendRequest(
        {
          walletId: record.walletId,
          chainId: record.chainId,
          senderAddress: record.senderAddress,
          tokenAddress: record.tokenAddress,
          recipientAddress: record.recipientAddress,
          amountAtomic: record.amountAtomic,
          paidAtomic: record.paidAtomic,
          referenceId: record.referenceId,
          idempotencyKey: record.providerIdempotencyKey,
          expiresAtMs: record.expiresAtMs,
        },
        input.appId,
        now(),
      );
      // Commit this transition before the external call. Any crash from here
      // onward is an unknown outcome, and a second submission is forbidden.
      await Effect.runPromise(input.store.markSubmitting(request));
      try {
        const result = await submit(prepared, request.signature, input.appSecret);
        await Effect.runPromise(
          input.store.recordSubmission({
            accountId: request.accountId,
            sendId: record.sendId,
            providerTransactionId: result.transactionId,
            userOperationHash: result.userOperationHash?.toLowerCase() ?? null,
            transactionHash: result.transactionHash?.toLowerCase() ?? null,
          }),
        );
      } catch {
        await Effect.runPromise(input.store.markHeld(request)).catch(() => undefined);
        throw new PrivySponsoredOutcomeUnknown();
      }
      const updated = await Effect.runPromise(
        input.store.get({
          accountId: request.accountId,
          sendId: request.sendId,
        }),
      );
      if (updated === null) throw new SponsoredSendRefused("not-found");
      return { record: await observe(updated), authorization: null };
    },
  };
}
