import { expect } from "bun:test";
import { Effect, Schema } from "effect";
import type { Client } from "pg";
import type { Hex } from "viem";
import * as C from "../../contracts/src/rewards-song-contributions-v2.ts";
import { makeCustodySolvencyCoordinator } from "./custody-solvency-coordinator.ts";
import { makeControlPlaneCustodySolvencyStore } from "./custody-solvency-repository.ts";
import { makeControlPlaneMegapotDrawingObservationStore } from "./megapot-drawing-observation-repository.ts";
import { makeMegapotDrawingObserver } from "./megapot-drawing-observer.ts";
import { makeControlPlaneRewardOfferTerminalStore } from "./reward-offer-terminal-repository.ts";
import type { fakeSafeChain } from "./reward-safe-chain.pg-fixture.ts";
import { makeRewardSafePurchaseCoordinator } from "./reward-safe-purchase-coordinator.ts";
import { makeRewardSafeRefundCoordinator } from "./reward-safe-refund-coordinator.ts";
import { makeControlPlaneRewardSafeRefundStore } from "./reward-safe-refund-repository.ts";
import {
  makeRewardSafeExecutionScanner,
  type RewardSafeRuntimeOptions,
} from "./reward-safe-settlement.ts";

/** Actual V2 funding has completed. Only the terminal clock boundary is seeded;
 * all refund writes, Safe scans and confirmation run under the release login. */
export async function proveSafeReceiptRefund(input: {
  admin: Client;
  owner: Client;
  options: RewardSafeRuntimeOptions;
  chain: ReturnType<typeof fakeSafeChain>;
  receipt: C.ContributionReceiptV2;
  category: "late_principal" | "unspent_budget";
  failedPurchase?: boolean;
  receivedAtomic?: bigint;
  job?: {
    tick: () => Promise<void>;
    prepared: (kind: string) => Promise<{ effectId: string; to: string; data: Hex }>;
  };
}) {
  const { options, chain, receipt, category, owner } = input;
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
  const legId = receipt.target.pool_leg_id;
  const amount =
    input.receivedAtomic ??
    BigInt(receipt.instruction.amount_atomic) + (category === "late_principal" ? 1n : 0n);
  let purchase: { effectId: string; to: string; data: Hex } | undefined;
  const purchases = makeRewardSafePurchaseCoordinator({ ...options, minimumEntrySeconds: 60 });
  if (input.failedPurchase) {
    await run(
      makeMegapotDrawingObserver({
        store: makeControlPlaneMegapotDrawingObservationStore(options.layer),
        rpc: options.rpc,
        observationTtlMs: 120_000,
        safePilot: { runtimeEnvironment: "staging", productionEnabled: false },
      }).observe(receipt.instruction.attestation_id),
    );
    const prepared = await run(purchases.prepare(legId));
    if (prepared.kind !== "prepared") throw Error("Missing failed-purchase preparation");
    const call = prepared.transactionBuilderFile.transactions[0];
    if (!call?.data) throw Error("Missing purchase call");
    purchase = { effectId: prepared.effectId, to: call.to, data: call.data as Hex };
  }
  if (category === "unspent_budget") {
    // The lifecycle boundary is an expired, never-purchased pot. No receipt,
    // refund, balance, effect or settlement evidence is fabricated here.
    await input.admin.query("BEGIN; SET LOCAL session_replication_role=replica");
    try {
      await input.admin.query(
        "UPDATE song_reward_offers SET ends_at=clock_timestamp()-interval '1 millisecond' WHERE offer_id=$1",
        [receipt.target.offer_id],
      );

      await input.admin.query("COMMIT");
    } catch (error) {
      await input.admin.query("ROLLBACK");
      throw error;
    }
  }
  if (purchase !== undefined) {
    const terminal = makeControlPlaneRewardOfferTerminalStore(
      options.layer,
      receipt.instruction.attestation_id,
    );
    expect(await run(terminal.closeExpired(10))).toEqual([]);
    expect(
      await run(
        makeControlPlaneRewardSafeRefundStore(options.layer).seal(
          receipt.instruction.attestation_id,
          10,
        ),
      ),
    ).toBe(0);
    // A prepared call can still execute. Its reserved principal is not refundable
    // just because the entry window has closed. Only canonical failure releases it.
    chain.execute(purchase, "failure");
    await run(
      makeRewardSafeExecutionScanner(options)({
        chainId: receipt.instruction.chain_id,
        safeAddress: receipt.instruction.recipient_custody,
      }),
    );
    expect(await run(purchases.settle(purchase.effectId))).toMatchObject({ kind: "released" });
  }
  if (input.job) {
    // No direct terminalizer, sealer, preparer, scanner or settler invocation.
    // The registered joint job must discover and finish the refund itself.
    await input.job.tick();
    const prepared = await input.job.prepared("reward_refund");
    expect(
      (
        await owner.query(
          "SELECT category,original_sender,amount_atomic::text FROM reward_safe_refunds_v1",
        )
      ).rows,
    ).toEqual([
      { category, original_sender: receipt.instruction.from, amount_atomic: amount.toString() },
    ]);
    expect(
      (
        await owner.query(
          "SELECT pending_refund_atomic::text FROM custody_solvency_observations ORDER BY created_at DESC LIMIT 1",
        )
      ).rows,
    ).toEqual([{ pending_refund_atomic: amount.toString() }]);
    chain.execute(prepared, "success");
    await input.job.tick();
    await input.job.tick();
    expect(
      (await owner.query("SELECT count(*)::int n FROM reward_safe_refund_completions_v1")).rows,
    ).toEqual([{ n: 1 }]);
    expect(
      (await owner.query("SELECT count(*)::int n FROM reward_safe_refund_attempts_v1")).rows,
    ).toEqual([{ n: 1 }]);
    expect(
      (
        await owner.query(
          "SELECT pending_refund_atomic::text FROM custody_solvency_observations ORDER BY created_at DESC LIMIT 1",
        )
      ).rows,
    ).toEqual([{ pending_refund_atomic: "0" }]);
    expect(
      await options.rpc.readUsdcBalance(receipt.instruction.recipient_custody, chain.head()),
    ).toBe(0n);
    const current = (
      await owner.query("SELECT read_owned_song_contribution_current_v2($1::jsonb) AS result", [
        JSON.stringify({
          accountId: "b",
          communityId: receipt.target.community_id,
          postId: receipt.target.post_id,
          contributionId: receipt.contribution_id,
        }),
      ])
    ).rows[0].result.current;
    expect(Schema.decodeUnknownSync(C.CurrentStateV2)(current)).toMatchObject({
      state: "refunded",
      refund_paid_atomic: amount.toString(),
      late_principal_owed_atomic: "0",
    });
    return;
  }
  if (category === "unspent_budget") {
    expect(
      await run(
        makeControlPlaneRewardOfferTerminalStore(
          options.layer,
          receipt.instruction.attestation_id,
        ).closeExpired(10),
      ),
    ).toContainEqual(
      expect.objectContaining({ offerId: receipt.target.offer_id, status: "expired" }),
    );
  }
  const store = makeControlPlaneRewardSafeRefundStore(options.layer);
  const refunds = makeRewardSafeRefundCoordinator(options);
  const solvency = makeCustodySolvencyCoordinator({
    store: makeControlPlaneCustodySolvencyStore(options.layer),
    rpc: options.rpc,
    requiredConfirmations: 1,
    safePilot: { runtimeEnvironment: "staging", productionEnabled: false },
  });
  const attestationId = receipt.instruction.attestation_id;
  const readSolvency = async () => {
    await run(solvency.observe(attestationId));
    return (
      await owner.query(
        `SELECT pending_refund_atomic::text,solvent FROM custody_solvency_observations
      WHERE attestation_id=$1 ORDER BY block_number DESC,created_at DESC LIMIT 1`,
        [attestationId],
      )
    ).rows[0];
  };
  expect(await readSolvency()).toEqual({ pending_refund_atomic: amount.toString(), solvent: true });
  await run(store.seal(attestationId, 10));
  await run(store.seal(attestationId, 10));
  const pending = await run(store.loadPending(attestationId, 10));
  expect(pending).toHaveLength(1);
  const refundId = pending[0];
  if (!refundId) throw Error("Missing refund");
  expect(
    (
      await owner.query(
        "SELECT category,original_sender,amount_atomic::text FROM reward_safe_refunds_v1 WHERE refund_id=$1",
        [refundId],
      )
    ).rows,
  ).toEqual([
    { category, original_sender: receipt.instruction.from, amount_atomic: amount.toString() },
  ]);
  const attempts = await Promise.allSettled([
    run(refunds.prepare(refundId)),
    run(refunds.prepare(refundId)),
  ]);
  expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
  const first = attempts.find((result) => result.status === "fulfilled");
  if (first?.status !== "fulfilled") throw Error("No prepared refund");
  expect(await run(store.loadPending(attestationId, 10))).toEqual([]);
  expect(await readSolvency()).toEqual({ pending_refund_atomic: amount.toString(), solvent: true });
  const scan = makeRewardSafeExecutionScanner(options);
  const custody = {
    chainId: receipt.instruction.chain_id,
    safeAddress: receipt.instruction.recipient_custody,
  };
  const execute = (prepared: typeof first.value, outcome: "success" | "failure") => {
    const call = prepared.transactionBuilderFile.transactions[0];
    if (!call) throw Error("Missing Safe call");
    return chain.execute({ to: call.to, data: call.data as Hex }, outcome);
  };
  execute(first.value, "failure");
  await run(scan(custody));
  expect(await run(refunds.settle(first.value.effectId))).toEqual({ kind: "released" });
  expect(await run(store.loadPending(attestationId, 10))).toEqual([refundId]);
  expect(await readSolvency()).toEqual({ pending_refund_atomic: amount.toString(), solvent: true });
  const retry = await run(refunds.prepare(refundId));
  expect(retry.effectId).not.toBe(first.value.effectId);
  execute(retry, "success");
  await run(scan(custody));
  chain.blocksUnreadable(true);
  await expect(run(refunds.settle(retry.effectId))).rejects.toBeDefined();
  expect(
    (await owner.query("SELECT count(*)::int AS n FROM reward_safe_refund_completions_v1")).rows,
  ).toEqual([{ n: 0 }]);
  chain.blocksUnreadable(false);
  expect(await run(refunds.settle(retry.effectId))).toEqual({
    kind: "confirmed",
    transactionHash: (
      await owner.query("SELECT transaction_hash FROM reward_chain_effects WHERE effect_id=$1", [
        retry.effectId,
      ])
    ).rows[0].transaction_hash,
  });
  expect(await run(refunds.settle(retry.effectId))).toEqual({ kind: "not_bound" });
  await expect(run(refunds.prepare(refundId))).rejects.toBeDefined();
  await run(store.seal(attestationId, 10));
  expect(await run(store.loadPending(attestationId, 10))).toEqual([]);
  expect(await readSolvency()).toEqual({ pending_refund_atomic: "0", solvent: true });
  expect(
    (await owner.query("SELECT count(*)::int AS n FROM reward_safe_refund_completions_v1")).rows,
  ).toEqual([{ n: 1 }]);
  expect(await options.rpc.readUsdcBalance(custody.safeAddress, chain.head())).toBe(0n);
  expect(
    (
      await owner.query(
        "SELECT refunded_atomic::text FROM song_reward_offer_legs WHERE leg_id=$1",
        [legId],
      )
    ).rows,
  ).toEqual([{ refunded_atomic: category === "unspent_budget" ? amount.toString() : "0" }]);
  if (category === "late_principal") {
    expect(
      (
        await owner.query(
          "SELECT amount_atomic::text,paid_atomic::text FROM reward_late_principal_liabilities_v2",
        )
      ).rows,
    ).toEqual([{ amount_atomic: amount.toString(), paid_atomic: "0" }]);
  }
  const current = (
    await owner.query("SELECT read_owned_song_contribution_current_v2($1::jsonb) AS result", [
      JSON.stringify({
        accountId: "b",
        communityId: receipt.target.community_id,
        postId: receipt.target.post_id,
        contributionId: receipt.contribution_id,
      }),
    ])
  ).rows[0].result.current;
  expect(Schema.decodeUnknownSync(C.CurrentStateV2)(current)).toMatchObject({
    state: "refunded",
    refund_paid_atomic: amount.toString(),
    late_principal_owed_atomic: "0",
  });
}
