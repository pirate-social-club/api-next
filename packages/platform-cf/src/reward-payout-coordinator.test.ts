import { describe, expect, test } from "bun:test";
import {
  RewardOperationsPaused,
  type RewardPayoutCandidate,
  type RewardPayoutProgress,
  RewardPayoutStorageFailed,
  type RewardPayoutStore,
} from "@pirate/application";
import { Effect } from "effect";
import {
  encodeAbiParameters,
  encodeEventTopics,
  type Hex,
  keccak256,
  parseAbi,
  parseAbiParameters,
} from "viem";
import type { MegapotTransactionReceipt } from "./megapot-v2.ts";
import type { MegapotV2RpcClient } from "./megapot-v2-rpc.ts";
import type { MegapotV2TransactionSigner } from "./megapot-v2-signer.ts";
import {
  deriveRewardPayoutEffectId,
  makeRewardPayoutCoordinator,
} from "./reward-payout-coordinator.ts";

const address = (byte: string): Hex => `0x${byte.repeat(40)}`;
const hash = (byte: string): Hex => `0x${byte.repeat(64)}`;
const JACKPOT = address("1");
const USDC = address("2");
const BONUS = address("b");
const NFT = address("3");
const CUSTODY = address("4");
const RECIPIENT = address("5");
const REFERRER = address("6");
const BLOCK = hash("a");
const SIGNED_TRANSACTION = "0x01020304" as Hex;
const SIGNED_TRANSACTION_HASH = keccak256(SIGNED_TRANSACTION);
const transferEvent = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 amount)",
]);

const candidate: RewardPayoutCandidate = {
  creditId: "credit-901",
  accountId: "account-a",
  payoutPersonaId: "persona-a",
  amountAtomic: 901n,
  walletAssignmentId: "wallet-a",
  destinationAddress: RECIPIENT,
  solvencyObservationId: "solvency-199",
  custodyBalanceBeforeAtomic: 10_000n,
  solvencyExpiresAt: "2026-08-26T01:00:00.000Z",
  attestationId: "megapot-base-sepolia-v2",
  environment: "staging",
  chainId: 84_532,
  tokenAddress: BONUS,
  usdcAddress: USDC,
  custodyAddress: CUSTODY,
  jackpotAddress: JACKPOT,
  ticketNftAddress: NFT,
  referrerAddress: REFERRER,
  jackpotCodeHash: hash("7"),
  usdcCodeHash: hash("8"),
  ticketNftCodeHash: hash("9"),
};

function topics(value: ReturnType<typeof encodeEventTopics>): [Hex, ...Hex[]] {
  if (value.some((topic) => typeof topic !== "string")) throw new Error("invalid topics");
  return value as [Hex, ...Hex[]];
}

function receipt(): MegapotTransactionReceipt {
  return {
    chainId: 84_532,
    status: "success",
    transactionHash: SIGNED_TRANSACTION_HASH,
    from: CUSTODY,
    to: BONUS,
    blockHash: BLOCK,
    blockNumber: 200n,
    logs: [
      {
        address: BONUS,
        topics: topics(
          encodeEventTopics({
            abi: transferEvent,
            eventName: "Transfer",
            args: { from: CUSTODY, to: RECIPIENT },
          }),
        ),
        data: encodeAbiParameters(parseAbiParameters("uint256 amount"), [901n]),
        logIndex: 4,
        transactionHash: SIGNED_TRANSACTION_HASH,
        blockHash: BLOCK,
        blockNumber: 200n,
      },
    ],
  };
}

function harness() {
  let progress: RewardPayoutProgress | null = null;
  let sends = 0;
  const store: RewardPayoutStore = {
    loadCandidate: () => Effect.succeed(candidate),
    findProgress: () => Effect.succeed(progress),
    reserveNonce: (input) => {
      const reservation = {
        ...input.candidate,
        effectId: input.effectId,
        nonce: input.observedPendingNonce,
        effectVersion: 2,
      };
      progress = { state: "nonce_reserved", reservation };
      return Effect.succeed(reservation);
    },
    prepare: (input) => {
      progress = {
        ...input.reservation,
        state: "prepared",
        calldata: input.calldata,
        calldataHash: input.calldataHash,
        signedTransaction: input.signedTransaction,
        signedTransactionHash: input.signedTransactionHash,
        transactionHash: null,
      };
      return Effect.void;
    },
    recordSubmission: (input) => {
      if (progress === null || progress.state !== "prepared") throw new Error("invalid progress");
      progress = {
        ...progress,
        state: input.outcome === "accepted" ? "broadcast_pending" : "reconciliation_required",
        transactionHash: input.transactionHash,
      };
      return Effect.void;
    },
    requireReconciliation: (input) => {
      if (
        progress === null ||
        progress.state === "confirmed" ||
        progress.state === "nonce_reserved"
      ) {
        throw new Error("invalid progress");
      }
      progress = {
        ...progress,
        state: "reconciliation_required",
        transactionHash: input.transactionHash,
      };
      return Effect.void;
    },
    confirm: (input) => {
      progress = {
        state: "confirmed",
        effectId: input.effectId,
        creditId: candidate.creditId,
        transactionHash: input.transactionHash,
        destinationAddress: candidate.destinationAddress,
        amountAtomic: input.amountAtomic,
        blockNumber: input.blockNumber,
        blockHash: input.blockHash,
        confirmations: input.confirmations,
      };
      return Effect.void;
    },
  };
  const rpc = {
    attestDeployment: async () => ({
      jackpotCodeHash: candidate.jackpotCodeHash,
      ticketNftCodeHash: candidate.ticketNftCodeHash,
      usdcCodeHash: candidate.usdcCodeHash,
    }),
    readFeeQuote: async () => ({
      baseFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
      maxFeePerGas: 2n,
      observedBlockNumber: 199n,
      observedBlockHash: hash("b"),
    }),
    readBlock: async (blockNumber: bigint) => ({
      blockNumber,
      blockHash: blockNumber === 200n ? BLOCK : hash("b"),
    }),
    readUsdcBalance: async (_account: string, blockNumber?: bigint) =>
      blockNumber === 200n ? 9_099n : 10_000n,
    readErc20Balance: async (tokenAddress: string, _account: string, blockNumber?: bigint) => {
      expect(tokenAddress).toBe(BONUS);
      return blockNumber === 200n ? 9_099n : 10_000n;
    },
    readPendingNonce: async () => 12n,
    estimateGas: async () => 50_000n,
    readNativeBalance: async () => 1_000_000n,
    sendRawTransaction: async () => {
      sends += 1;
      return SIGNED_TRANSACTION_HASH;
    },
    // A receipt exists only for a transaction that was sent.
    readReceipt: async () => (sends > 0 ? receipt() : null),
    readHead: async () => ({ blockNumber: 202n, blockHash: hash("c") }),
  } as unknown as MegapotV2RpcClient;
  let signatures = 0;
  const signer: MegapotV2TransactionSigner = {
    address: CUSTODY,
    sign: async () => {
      signatures += 1;
      return {
        signedTransaction: SIGNED_TRANSACTION,
        signedTransactionHash: SIGNED_TRANSACTION_HASH,
      };
    },
  };
  return {
    store,
    rpc,
    signer,
    sends: () => sends,
    signatures: () => signatures,
    state: () => progress?.state ?? null,
  };
}

describe("reward payout coordinator", () => {
  test("pays one bonus-token liability exactly once and replays the confirmed receipt", async () => {
    const state = harness();
    const coordinator = makeRewardPayoutCoordinator({
      authority: { ensure: () => Effect.void },
      store: state.store,
      rpc: state.rpc,
      signer: state.signer,
      requiredConfirmations: 3,
      gasLimitMultiplierBps: 12_000,
      nativeGasReserveFloorWei: 1_000n,
      now: () => Date.parse("2026-08-26T00:00:00.000Z"),
    });

    const first = await Effect.runPromise(coordinator.payout(candidate.creditId));
    const replay = await Effect.runPromise(coordinator.payout(candidate.creditId));

    expect(first).toMatchObject({
      kind: "confirmed",
      creditId: candidate.creditId,
      amountAtomic: 901n,
      destinationAddress: RECIPIENT,
    });
    expect(replay).toEqual(first);
    expect(state.sends()).toBe(1);
    expect(deriveRewardPayoutEffectId(candidate.creditId) as string).toBe(first.effectId);
  });
  test("reconciles an admitted send after an absent receipt without broadcasting again", async () => {
    const state = harness();
    let available = false;
    const rpc: MegapotV2RpcClient = {
      ...state.rpc,
      readReceipt: async () => (available ? receipt() : null),
    };
    const coordinator = makeRewardPayoutCoordinator({
      authority: { ensure: () => Effect.void },
      store: state.store,
      rpc,
      signer: state.signer,
      requiredConfirmations: 3,
      gasLimitMultiplierBps: 12_000,
      nativeGasReserveFloorWei: 1_000n,
      now: () => Date.parse("2026-08-26T00:00:00.000Z"),
    });
    const first = await Effect.runPromise(coordinator.payout(candidate.creditId));
    expect(first.kind).toBe("submitted");
    available = true;
    const confirmed = await Effect.runPromise(coordinator.reconcile(first.effectId));
    expect(confirmed).toMatchObject({ kind: "confirmed", creditId: candidate.creditId });
    expect(state.sends()).toBe(1);
  });

  test("holds a noncanonical receipt with the family's reconciliation reason", async () => {
    const state = harness();
    const reasons: string[] = [];
    const requireReconciliation = state.store.requireReconciliation;
    const store: RewardPayoutStore = {
      ...state.store,
      requireReconciliation: (input) => {
        reasons.push(input.reason);
        return requireReconciliation(input);
      },
    };
    const readBlock = state.rpc.readBlock;
    let canonical = false;
    const rpc: MegapotV2RpcClient = {
      ...state.rpc,
      readBlock: async (blockNumber) =>
        !canonical && blockNumber === 200n
          ? { blockNumber, blockHash: hash("d") }
          : readBlock(blockNumber),
    };
    const coordinator = makeRewardPayoutCoordinator({
      authority: { ensure: () => Effect.void },
      store,
      rpc,
      signer: state.signer,
      requiredConfirmations: 3,
      gasLimitMultiplierBps: 12_000,
      nativeGasReserveFloorWei: 1_000n,
      now: () => Date.parse("2026-08-26T00:00:00.000Z"),
    });
    const first = await Effect.runPromise(coordinator.payout(candidate.creditId));
    expect(first.kind).toBe("reconciliation_required");
    expect(reasons).toEqual(["payout_receipt_reorg"]);
    canonical = true;
    const confirmed = await Effect.runPromise(coordinator.reconcile(first.effectId));
    expect(confirmed).toMatchObject({ kind: "confirmed", creditId: candidate.creditId });
    expect(state.sends()).toBe(1);
  });
});

// A run lease that has expired, or a brake that is paused, refuses new authority.
// The switch is flipped by the test at the moment it wants the lease to lapse.
function leasedAuthority() {
  let live = true;
  let asked = 0;
  return {
    authority: {
      ensure: () =>
        Effect.suspend(() => {
          asked += 1;
          return live ? Effect.void : Effect.fail(new RewardOperationsPaused({ reason: "paused" }));
        }),
    },
    expire: () => {
      live = false;
    },
    asked: () => asked,
  };
}
const settings = {
  requiredConfirmations: 3,
  gasLimitMultiplierBps: 12_000,
  nativeGasReserveFloorWei: 1_000n,
  now: () => Date.parse("2026-08-26T00:00:00.000Z"),
};
const outcome = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.map((value) => ({ ok: true as const, value })),
      Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
    ),
  );

describe("reward payout under a run lease", () => {
  test("authority is asked before the signature and again before the send", async () => {
    const state = harness();
    const lease = leasedAuthority();
    const order: string[] = [];
    const coordinator = makeRewardPayoutCoordinator({
      ...settings,
      authority: {
        ensure: () =>
          Effect.sync(() => void order.push("authority")).pipe(
            Effect.andThen(lease.authority.ensure()),
          ),
      },
      store: state.store,
      rpc: {
        ...state.rpc,
        sendRawTransaction: async (signed) => {
          order.push("send");
          return state.rpc.sendRawTransaction(signed);
        },
      },
      signer: {
        ...state.signer,
        sign: async (request) => {
          order.push("sign");
          return state.signer.sign(request);
        },
      },
    });
    const paid = await Effect.runPromise(coordinator.payout(candidate.creditId));
    expect(paid.kind).toBe("confirmed");
    expect(order).toEqual(["authority", "sign", "authority", "send"]);
  });

  test("without authority nothing is signed, stored or sent", async () => {
    const state = harness();
    const lease = leasedAuthority();
    lease.expire();
    const coordinator = makeRewardPayoutCoordinator({
      ...settings,
      authority: lease.authority,
      store: state.store,
      rpc: state.rpc,
      signer: state.signer,
    });
    const refused = await outcome(coordinator.payout(candidate.creditId));
    expect(refused).toMatchObject({ ok: false, error: { _tag: "RewardOperationsPaused" } });
    expect(state.signatures()).toBe(0);
    expect(state.sends()).toBe(0);
    // The nonce was reserved while admission was open; it stays reserved.
    expect(state.state()).toBe("nonce_reserved");
  });

  test("a reservation made before expiry is not signed when reconciled after it", async () => {
    const state = harness();
    const lease = leasedAuthority();
    let failSigner = true;
    const coordinator = makeRewardPayoutCoordinator({
      ...settings,
      authority: lease.authority,
      store: state.store,
      rpc: state.rpc,
      signer: {
        ...state.signer,
        sign: async (request) => {
          if (failSigner) throw new Error("signer offline");
          return state.signer.sign(request);
        },
      },
    });
    // The first attempt reserves a nonce and then loses its signer.
    const first = await outcome(coordinator.payout(candidate.creditId));
    expect(first.ok).toBe(false);
    expect(state.state()).toBe("nonce_reserved");
    failSigner = false;
    lease.expire();
    const resumed = await outcome(
      coordinator.reconcile(deriveRewardPayoutEffectId(candidate.creditId)),
    );
    expect(resumed).toMatchObject({ ok: false, error: { _tag: "RewardOperationsPaused" } });
    expect(state.signatures()).toBe(0);
    expect(state.sends()).toBe(0);
    expect(state.state()).toBe("nonce_reserved");
  });

  test("a signature stored before expiry is not sent after it, and is not called uncertain", async () => {
    const state = harness();
    const lease = leasedAuthority();
    const submissions: string[] = [];
    const recordSubmission = state.store.recordSubmission;
    let expireAtSend = true;
    const coordinator = makeRewardPayoutCoordinator({
      ...settings,
      // The lease lapses between the signature being stored and the send.
      authority: {
        ensure: () =>
          Effect.suspend(() => {
            if (expireAtSend && state.state() === "prepared") lease.expire();
            return lease.authority.ensure();
          }),
      },
      store: {
        ...state.store,
        recordSubmission: (input) => {
          submissions.push(input.outcome);
          return recordSubmission(input);
        },
      },
      rpc: state.rpc,
      signer: state.signer,
    });
    const refused = await outcome(coordinator.payout(candidate.creditId));
    expect(refused).toMatchObject({ ok: false, error: { _tag: "RewardOperationsPaused" } });
    expect(state.signatures()).toBe(1);
    expect(state.sends()).toBe(0);
    // Refusal is not a broadcast of unknown outcome: nothing was recorded as sent.
    expect(submissions).toEqual([]);
    expect(state.state()).toBe("prepared");
    // Reconciling again after expiry looks for it on chain, finds nothing, and stops.
    expireAtSend = false;
    const again = await outcome(
      coordinator.reconcile(deriveRewardPayoutEffectId(candidate.creditId)),
    );
    expect(again).toMatchObject({ ok: false, error: { _tag: "RewardOperationsPaused" } });
    expect(state.signatures()).toBe(1);
    expect(state.sends()).toBe(0);
    expect(state.state()).toBe("prepared");
  });

  test("a send that succeeded but was never recorded is recovered after expiry with no signature or send", async () => {
    const state = harness();
    const lease = leasedAuthority();
    const recordSubmission = state.store.recordSubmission;
    let failRecord = true;
    const coordinator = makeRewardPayoutCoordinator({
      ...settings,
      authority: lease.authority,
      store: {
        ...state.store,
        // The transaction reaches the chain; the write that says so is lost.
        recordSubmission: (input) =>
          failRecord
            ? Effect.fail(new RewardPayoutStorageFailed({ reason: "outcome-unknown" }))
            : recordSubmission(input),
      },
      rpc: state.rpc,
      signer: state.signer,
    });
    const lost = await outcome(coordinator.payout(candidate.creditId));
    expect(lost.ok).toBe(false);
    expect(state.sends()).toBe(1);
    expect(state.state()).toBe("prepared");

    failRecord = false;
    lease.expire();
    const recovered = await Effect.runPromise(
      coordinator.reconcile(deriveRewardPayoutEffectId(candidate.creditId)),
    );
    // Found on chain by its stored hash, recorded, and carried to confirmation.
    expect(recovered).toMatchObject({ kind: "confirmed", creditId: candidate.creditId });
    expect(state.signatures()).toBe(1);
    expect(state.sends()).toBe(1);
    expect(state.state()).toBe("confirmed");
  });

  test("a lease that expires during the send does not stop the result being recorded", async () => {
    const state = harness();
    const lease = leasedAuthority();
    const coordinator = makeRewardPayoutCoordinator({
      ...settings,
      authority: lease.authority,
      store: state.store,
      rpc: {
        ...state.rpc,
        sendRawTransaction: async (signed) => {
          // Authorized when it started; the lease lapses while it is in progress.
          lease.expire();
          return state.rpc.sendRawTransaction(signed);
        },
      },
      signer: state.signer,
    });
    const paid = await Effect.runPromise(coordinator.payout(candidate.creditId));
    expect(paid).toMatchObject({ kind: "confirmed", creditId: candidate.creditId });
    expect(state.sends()).toBe(1);
    expect(state.state()).toBe("confirmed");
  });

  test("a receipt read that fails is not taken as proof the transaction was never sent", async () => {
    const state = harness();
    const lease = leasedAuthority();
    let failSend = true;
    let failReceipt = false;
    const coordinator = makeRewardPayoutCoordinator({
      ...settings,
      authority: lease.authority,
      store: {
        ...state.store,
        recordSubmission: () =>
          Effect.fail(new RewardPayoutStorageFailed({ reason: "outcome-unknown" })),
      },
      rpc: {
        ...state.rpc,
        readReceipt: async (hash) => {
          if (failReceipt) throw new Error("rpc unavailable");
          return state.rpc.readReceipt(hash);
        },
        sendRawTransaction: async (signed) => {
          if (failSend) return state.rpc.sendRawTransaction(signed);
          throw new Error("must not send");
        },
      },
      signer: state.signer,
    });
    await outcome(coordinator.payout(candidate.creditId));
    expect(state.sends()).toBe(1);
    failSend = false;
    failReceipt = true;
    lease.expire();
    // The chain cannot be read and authority is gone: nothing is sent again.
    const held = await outcome(
      coordinator.reconcile(deriveRewardPayoutEffectId(candidate.creditId)),
    );
    expect(held).toMatchObject({ ok: false, error: { _tag: "RewardOperationsPaused" } });
    expect(state.sends()).toBe(1);
    expect(state.signatures()).toBe(1);
  });
});
