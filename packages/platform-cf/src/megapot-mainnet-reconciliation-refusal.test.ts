import { expect, test } from "bun:test";
import type {
  MegapotApprovalStore,
  MegapotClaimStore,
  MegapotPurchaseStore,
  RewardPayoutStore,
  RewardRefundStore,
} from "@pirate/application";
import { Effect } from "effect";
import { makeMegapotApprovalCoordinator } from "./megapot-approval-coordinator.ts";
import { makeMegapotClaimCoordinator } from "./megapot-claim-coordinator.ts";
import { makeMegapotPurchaseCoordinator } from "./megapot-purchase-coordinator.ts";
import type { MegapotV2RpcClient } from "./megapot-v2-rpc.ts";
import { makeRewardPayoutCoordinator } from "./reward-payout-coordinator.ts";
import { makeRewardRefundCoordinator } from "./reward-refund-coordinator.ts";

// Deliberately incomplete restored rows: refusal must precede every RPC,
// signer, authority and settlement-store call, even after a prior broadcast.
for (const state of ["broadcast_pending", "confirming", "reconciliation_required"] as const) {
  test(`production reconciliation refuses an ordinary RPC for every ${state} effect family`, async () => {
    let forbiddenCalls = 0;
    const forbidden = () => {
      forbiddenCalls += 1;
      throw new Error("unexpected effect");
    };
    const row = { state, chainId: 8453, environment: "production" };
    const store = new Proxy(
      { findProgress: () => Effect.succeed(row) },
      {
        get: (target, key) => (key === "findProgress" ? target.findProgress : forbidden),
      },
    );
    const rpc = new Proxy({}, { get: () => forbidden }) as MegapotV2RpcClient;
    const common = {
      rpc,
      authority: { ensure: forbidden },
      signer: { address: "0x1111111111111111111111111111111111111111", sign: forbidden },
      requiredConfirmations: 1,
      gasLimitMultiplierBps: 10_000,
      nativeGasReserveFloorWei: 0n,
    };
    const coordinators = [
      makeMegapotApprovalCoordinator({
        ...common,
        store: store as unknown as MegapotApprovalStore,
      }),
      makeMegapotPurchaseCoordinator({
        ...common,
        store: store as unknown as MegapotPurchaseStore,
        options: { ...common, purchaseSafetyMarginSeconds: 1 },
      }),
      makeMegapotClaimCoordinator({ ...common, store: store as unknown as MegapotClaimStore }),
      makeRewardPayoutCoordinator({ ...common, store: store as unknown as RewardPayoutStore }),
      makeRewardRefundCoordinator({ ...common, store: store as unknown as RewardRefundStore }),
    ];
    const refusals: readonly Effect.Effect<unknown, unknown>[] = coordinators.map((coordinator) =>
      coordinator.reconcile("restored-effect"),
    );
    for (const refusal of refusals) {
      await expect(Effect.runPromise(refusal)).rejects.toMatchObject({
        reason: "production_disabled",
      });
    }
    expect(forbiddenCalls).toBe(0);
  });
}
