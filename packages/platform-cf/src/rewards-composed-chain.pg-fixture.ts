/**
 * Deterministic evidence at the chain-store boundary, not RPC/signing coverage.
 * Every economic row is written by the production stores. The caller supplies
 * a drawing frozen and committed by the production coordinators.
 *
 * Spec 015 §5.2a: a participant credit is paid only after an accepted claim.
 * The caller's `claim` hook runs per allocation and reports whether the claim
 * was accepted; unclaimed credits must be refused by payout and stay owed.
 */
import { expect } from "bun:test";
import { Effect } from "effect";
import { keccak256, sha256, toBytes } from "viem";
import { makeControlPlaneCustodySolvencyStore } from "./custody-solvency-repository.ts";
import { makeMegapotAllocationCoordinator } from "./megapot-allocation-coordinator.ts";
import { makeControlPlaneMegapotAllocationStore } from "./megapot-allocation-repository.ts";
import { makeControlPlaneMegapotClaimStore } from "./megapot-claim-repository.ts";
import { makeControlPlaneMegapotPurchaseStore } from "./megapot-purchase-repository.ts";
import { makeControlPlaneMegapotSweepStore } from "./megapot-sweep-repository.ts";
import { encodeMegapotUsdcTransfer } from "./megapot-v2.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { makeControlPlaneRewardPayoutStore } from "./reward-payout-repository.ts";

const hex = (label: string) => sha256(toBytes(label));
const digest = (label: string) => hex(label).slice(2);

export async function completeComposedWinningChain(input: {
  scopedConnection: string;
  poolLegId: string;
  drawingId: bigint;
  settlementAtMs: number;
  expectedAllocationsAtomic: readonly bigint[];
  claim: (row: { readonly creditId: string; readonly accountId: string }) => Promise<boolean>;
}) {
  const layer = makeDirectPostgresControlPlaneLayer(input.scopedConnection);
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
  let tick = 0;
  const at = () => new Date(input.settlementAtMs + tick++ * 1000).toISOString();
  const key = { poolLegId: input.poolLegId, drawingId: input.drawingId };
  const suffix = digest(`${input.poolLegId}:${input.drawingId}`).slice(0, 20);
  const ticket = { normals: [1, 2, 3, 4, 5], bonusball: 1 } as const;
  const purchase = makeControlPlaneMegapotPurchaseStore(layer);
  const purchaseCandidate = await run(purchase.loadCandidate(key));
  const purchaseEffectId = `composed-purchase-${suffix}`;
  const reservation = await run(
    purchase.reserveNonce({
      candidate: purchaseCandidate,
      effectId: purchaseEffectId,
      ticket,
      observedPendingNonce: 1n,
      observedBlockNumber: 1001n,
      observedBlockHash: hex("purchase-nonce"),
      observedAt: at(),
    }),
  );
  expect(reservation.nonce).toBe(1n);
  const purchaseTx = keccak256("0x0102");
  await run(
    purchase.prepare({
      reservation,
      ticket,
      calldata: "0xdeadbeef",
      calldataHash: digest("purchase-calldata"),
      signedTransaction: "0x0102",
      signedTransactionHash: purchaseTx,
      preparedAt: at(),
    }),
  );
  await run(
    purchase.recordSubmission({
      effectId: purchaseEffectId,
      transactionHash: purchaseTx,
      submittedAt: at(),
      outcome: "accepted",
    }),
  );
  await run(
    purchase.confirm({
      effectId: purchaseEffectId,
      transactionHash: purchaseTx,
      ticketId: 50000n + input.drawingId,
      purchaseLogIndex: 1,
      mintLogIndex: 2,
      blockNumber: 1002n,
      blockHash: hex("purchase-block"),
      receiptHash: digest("purchase-receipt"),
      confirmations: 3,
      referralFeesAtomic: 100n,
      lpEarningsAtomic: 900n,
      confirmedAt: at(),
    }),
  );

  const sweepStore = makeControlPlaneMegapotSweepStore(layer);
  const sweepCandidate = await run(sweepStore.loadCandidate(key));
  const sweep = await run(
    sweepStore.complete({
      candidate: sweepCandidate,
      sweepId: `composed-sweep-${suffix}`,
      observationBlockNumber: 1003n,
      observationBlockHash: hex("sweep-block"),
      drawingStateHash: digest("drawing-state"),
      tierId: 7,
      custodyOwnerAddress: purchaseCandidate.custodyAddress,
      grossWinningsAtomic: 1001n,
      referralWinShareAtomic: 100000000000000000n,
      referralAccrualAtomic: 100n,
      netWinningsAtomic: 901n,
      observedAt: at(),
    }),
  );
  expect(sweep).toMatchObject({ outcome: "winnings_detected", netWinningsAtomic: 901n });

  const claim = makeControlPlaneMegapotClaimStore(layer);
  const claimEffectId = `composed-claim-${suffix}`;
  const claimReservation = await run(
    claim.reserveNonce({
      candidate: await run(claim.loadCandidate(key)),
      effectId: claimEffectId,
      custodyBalanceBeforeAtomic: 90000n,
      referralBalanceBeforeAtomic: 0n,
      observedPendingNonce: 2n,
      observedBlockNumber: 1004n,
      observedBlockHash: hex("claim-nonce"),
      observedAt: at(),
    }),
  );
  expect(claimReservation.nonce).toBe(2n);
  const claimTx = keccak256("0x0304");
  await run(
    claim.prepare({
      reservation: claimReservation,
      calldata: "0x1bf0ade0",
      calldataHash: digest("claim-calldata"),
      signedTransaction: "0x0304",
      signedTransactionHash: claimTx,
      preparedAt: at(),
    }),
  );
  await run(
    claim.recordSubmission({
      effectId: claimEffectId,
      transactionHash: claimTx,
      submittedAt: at(),
      outcome: "accepted",
    }),
  );
  await run(
    claim.confirm({
      effectId: claimEffectId,
      transactionHash: claimTx,
      claimLogIndex: 3,
      burnLogIndex: 4,
      referralLogIndex: 5,
      transferLogIndex: 6,
      grossWinningsAtomic: 1001n,
      referralAccrualAtomic: 100n,
      netWinningsAtomic: 901n,
      custodyBalanceAfterAtomic: 90901n,
      referralBalanceAfterAtomic: 100n,
      blockNumber: 1005n,
      blockHash: hex("claim-block"),
      receiptHash: digest("claim-receipt"),
      confirmations: 3,
      confirmedAt: at(),
    }),
  );
  const allocator = makeMegapotAllocationCoordinator({
    store: makeControlPlaneMegapotAllocationStore(layer),
    now: () => input.settlementAtMs + tick++ * 1000,
  });
  const allocation = await run(allocator.allocate(key));
  expect(await run(allocator.allocate(key))).toEqual(allocation);
  expect(allocation.allocations.map((row) => row.amountAtomic)).toEqual([
    ...input.expectedAllocationsAtomic,
  ]);

  const solvencyStore = makeControlPlaneCustodySolvencyStore(layer);
  const solvency = await run(
    solvencyStore.record({
      candidate: await run(solvencyStore.loadCandidate(purchaseCandidate.attestationId)),
      observationId: `composed-solvency-${suffix}`,
      balanceAtomic: 90901n,
      blockNumber: 1006n,
      blockHash: hex("solvency-block"),
      observedAt: at(),
      expiresAt: new Date(input.settlementAtMs + 3600000).toISOString(),
    }),
  );
  expect(solvency).toMatchObject({
    solvent: true,
    outstandingCreditAtomic: 901n,
    pendingRefundAtomic: 90000n,
  });
  const payout = makeControlPlaneRewardPayoutStore(layer);
  const payoutEffectIds: string[] = [];
  const heldCreditIds: string[] = [];
  let custodyBalance = 90901n;
  let paidCount = 0;
  for (const row of allocation.allocations) {
    if (row.creditId === null) throw new Error("missing participant credit");
    await expect(run(payout.loadCandidate(row.creditId))).rejects.toMatchObject({
      reason: "credit-not-payable",
    });
    if (!(await input.claim({ creditId: row.creditId, accountId: row.accountId }))) {
      await expect(run(payout.loadCandidate(row.creditId))).rejects.toMatchObject({
        reason: "credit-not-payable",
      });
      heldCreditIds.push(row.creditId);
      continue;
    }
    const index = paidCount++;
    const candidate = await run(payout.loadCandidate(row.creditId));
    const effectId = `composed-payout-${index}-${suffix}`;
    const nonce = BigInt(index + 3);
    const reserved = await run(
      payout.reserveNonce({
        candidate,
        effectId,
        observedPendingNonce: nonce,
        observedBlockNumber: 1007n + BigInt(index * 2),
        observedBlockHash: hex(`payout-nonce-${index}`),
        observedAt: at(),
      }),
    );
    expect(reserved.nonce).toBe(nonce);
    const signedTransaction = `0x${(index + 5).toString(16).padStart(4, "0")}` as const;
    const transactionHash = keccak256(signedTransaction);
    const calldata = encodeMegapotUsdcTransfer(
      candidate.destinationAddress,
      candidate.amountAtomic,
    );
    await run(
      payout.prepare({
        reservation: reserved,
        calldata,
        calldataHash: sha256(calldata).slice(2),
        signedTransaction,
        signedTransactionHash: transactionHash,
        preparedAt: at(),
      }),
    );
    await run(
      payout.recordSubmission({
        effectId,
        transactionHash,
        submittedAt: at(),
        outcome: "accepted",
      }),
    );
    custodyBalance -= candidate.amountAtomic;
    const receipt = {
      effectId,
      transactionHash,
      transferLogIndex: 10 + index,
      amountAtomic: candidate.amountAtomic,
      custodyBalanceAfterAtomic: custodyBalance,
      blockNumber: 1008n + BigInt(index * 2),
      blockHash: hex(`payout-block-${index}`),
      receiptHash: digest(`payout-receipt-${index}`),
      confirmations: 3,
      confirmedAt: at(),
    };
    await run(payout.confirm(receipt));
    await expect(run(payout.confirm(receipt))).rejects.toMatchObject({ reason: "effect-conflict" });
    expect(await run(payout.findProgress(effectId))).toMatchObject({ state: "confirmed" });
    payoutEffectIds.push(effectId);
  }
  expect(await run(allocator.allocate(key))).toEqual(allocation);
  return {
    allocation,
    purchaseEffectId,
    claimEffectId,
    payoutEffectIds,
    heldCreditIds,
    custodyBalance,
  };
}
