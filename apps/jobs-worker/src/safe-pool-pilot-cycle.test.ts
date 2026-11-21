import { describe, expect, mock, test } from "bun:test";
import { AlertCollector, ControlPlaneDb, type ControlPlaneStatement } from "@pirate/application";
import type {
  MegapotDrawingWork,
  MegapotDrawingWorkStatus,
} from "@pirate/platform-cf/megapot-work-repository";
import type { RewardSafeRuntimeEnvironment } from "@pirate/platform-cf/reward-safe-execution";
import { Data, Effect } from "effect";
import { buildJobRegistry, JobContext } from "./registry.ts";
import {
  runSafePoolPilotCycle,
  type SafePoolPilotRuntime,
  scanSafeWindows,
} from "./safe-pool-pilot-cycle.ts";

// The job's import graph reaches Durable Object classes; stub the Workers-only module
// so this file passes on its own, not only after another test has stubbed it.
mock.module("cloudflare:workers", () => ({ DurableObject: class DurableObject {} }));
const { makeSafePoolPilotJob } = await import("./safe-pool-pilot.ts");

class StepFailed extends Data.TaggedError("StepFailed")<{
  readonly reason: string;
  readonly detail: string;
}> {}

const drawingWork = (poolLegId: string, status: MegapotDrawingWorkStatus): MegapotDrawingWork =>
  ({ poolLegId, drawingId: 212n, status }) as MegapotDrawingWork;

function harness(fail: ReadonlySet<string> = new Set()) {
  const calls: string[] = [];
  const step =
    <A>(name: string, value: A) =>
    (subject = "") => {
      const label = subject === "" ? name : `${name}:${subject}`;
      calls.push(label);
      return fail.has(label)
        ? Effect.fail(new StepFailed({ reason: "refused", detail: "provider text" }))
        : Effect.succeed(value);
    };
  const drawings: Record<string, readonly MegapotDrawingWork[]> = {
    cutoff_frozen: [drawingWork("leg-frozen", "cutoff_frozen")],
    "committed,drawing_pending": [drawingWork("leg-committed", "committed")],
    winnings_detected: [drawingWork("leg-won", "winnings_detected")],
    claimed: [drawingWork("leg-claimed", "claimed")],
  };
  const runtime: SafePoolPilotRuntime = {
    observeDrawing: () => step("observe_drawing", true)(),
    scan: () => step("scan", null)(),
    loadBoundEffects: () =>
      step("load_bound_effects", [
        { effectId: "purchase-1", kind: "ticket_purchase" },
        { effectId: "payout-1", kind: "reward_payout" },
        { effectId: "refund-1", kind: "reward_refund" },
      ] as const)(),
    settlePurchase: (effectId) => step("settle_purchase", null)(effectId),
    settlePayout: (effectId) => step("settle_payout", null)(effectId),
    settleRefund: (effectId) => step("settle_refund", null)(effectId),
    loadPendingFunding: () => step("load_funding", ["funding-1"])(),
    reconcileFunding: (fundingEffectId) => step("reconcile_funding", null)(fundingEffectId),
    closeUnexecutedPurchases: () => step("close_unexecuted_purchases", 0)(),
    loadLegs: () => step("load_legs", ["leg-a", "leg-b"])(),
    preparePurchase: (legId) => step("prepare_purchase", null)(legId),
    freezeDue: () => step("freeze_due", [])(),
    loadDrawings: (statuses) =>
      step("load_drawings", drawings[statuses.join(",")] ?? [])(statuses.join(",")),
    publishCommitment: (drawing) => step("publish_commitment", null)(drawing.poolLegId),
    sweep: (drawing) => step("sweep", null)(drawing.poolLegId),
    settleClaim: (drawing) => step("settle_claim", null)(drawing.poolLegId),
    prepareClaim: (drawing) => step("prepare_claim", null)(drawing.poolLegId),
    allocate: (drawing) => step("allocate", null)(drawing.poolLegId),
    closeExpiredOffers: () => step("close_expired_offers", [])(),
    sealRefunds: () => step("seal_refunds", 1)(),
    loadRefunds: () => step("load_refunds", ["refund-2"])(),
    prepareRefund: (refundId) => step("prepare_refund", null)(refundId),
    observeSolvency: () => step("observe_solvency", null)(),
    loadCredits: () => step("load_credits", ["credit-1"])(),
    preparePayout: (creditId) => step("prepare_payout", null)(creditId),
  };
  return { runtime, calls };
}

describe("Safe pool pilot cycle", () => {
  test("runs every step in the order a ticket-first pool moves", async () => {
    const { runtime, calls } = harness();
    const summary = await Effect.runPromise(runSafePoolPilotCycle(runtime));
    expect(calls).toEqual([
      "freeze_due",
      "observe_drawing",
      "scan",
      "load_bound_effects",
      "settle_purchase:purchase-1",
      "settle_payout:payout-1",
      "settle_refund:refund-1",
      "load_funding",
      "reconcile_funding:funding-1",
      "close_unexecuted_purchases",
      "load_legs",
      "prepare_purchase:leg-a",
      "prepare_purchase:leg-b",
      "load_drawings:cutoff_frozen",
      "publish_commitment:leg-frozen",
      "load_drawings:committed,drawing_pending",
      "sweep:leg-committed",
      "load_drawings:winnings_detected",
      "settle_claim:leg-won",
      "prepare_claim:leg-won",
      "load_drawings:claimed",
      "allocate:leg-claimed",
      "close_expired_offers",
      "seal_refunds",
      "observe_solvency",
      "load_refunds",
      "prepare_refund:refund-2",
      "load_credits",
      "prepare_payout:credit-1",
    ]);
    expect(summary.failed).toEqual({});
    expect(summary.completed.prepare_purchase).toBe(2);
  });

  test("records a failed item by tag and reason and goes on with the pass", async () => {
    const { runtime, calls } = harness(new Set(["scan", "prepare_purchase:leg-a"]));
    const summary = await Effect.runPromise(runSafePoolPilotCycle(runtime));
    expect(summary.failed).toEqual({
      scan: ["StepFailed:refused"],
      prepare_purchase: ["StepFailed:refused"],
    });
    expect(calls).toContain("prepare_purchase:leg-b");
    expect(calls.at(-1)).toBe("prepare_payout:credit-1");
    expect(JSON.stringify(summary)).not.toContain("provider text");
  });

  test("scans successive windows until the settled head, at most five per cycle", async () => {
    const windows = (remaining: number) => {
      let calls = 0;
      return {
        scan: () =>
          Effect.sync(() => {
            calls += 1;
            return { scanned: calls <= remaining };
          }),
        calls: () => calls,
      };
    };
    const caughtUp = windows(2);
    expect(await Effect.runPromise(scanSafeWindows(caughtUp.scan))).toBe(2);
    expect(caughtUp.calls()).toBe(3);
    const behind = windows(50);
    expect(await Effect.runPromise(scanSafeWindows(behind.scan))).toBe(5);
    expect(behind.calls()).toBe(5);
    const failing = scanSafeWindows(() =>
      Effect.fail(new StepFailed({ reason: "rpc_unavailable", detail: "range" })),
    );
    await expect(Effect.runPromise(failing)).rejects.toMatchObject({ reason: "rpc_unavailable" });
  });

  test("declares a job the registry accepts, and never beside an EOA rewards writer", async () => {
    const job = makeSafePoolPilotJob(
      {},
      {
        environment: "staging",
        attestationId: "megapot-base-safe-pilot",
        rpcUrl: "https://base.example.invalid",
        requiredConfirmations: 3,
        productionEnabled: false,
        minimumEntrySeconds: 3_600,
        observationTtlMs: 60_000,
        commitmentBucket: {
          get: async () => null,
          put: async () => null,
        },
        commitmentPublicOrigin: "https://commitments.example.invalid",
      },
    );
    await expect(Effect.runPromise(buildJobRegistry([job]))).resolves.toBeDefined();
    await expect(
      Effect.runPromise(buildJobRegistry([job, { ...job, name: "megapot-rewards.cycle" }])),
    ).rejects.toMatchObject({ reason: "duplicate-table-writer" });
  });

  test("runs no step for an attestation its worker's own environment does not admit", async () => {
    const attestation = (environment: string, chainId: number) => ({
      attestation_id: "megapot-safe-pilot",
      environment,
      chain_id: chainId,
      jackpot_address: `0x${"1".repeat(40)}`,
      usdc_address: `0x${"2".repeat(40)}`,
      ticket_nft_address: `0x${"3".repeat(40)}`,
      custody_address: `0x${"4".repeat(40)}`,
      referrer_address: `0x${"5".repeat(40)}`,
      source_tag: `0x${"6".repeat(64)}`,
      jackpot_code_hash: `0x${"7".repeat(64)}`,
      usdc_code_hash: `0x${"8".repeat(64)}`,
      ticket_nft_code_hash: `0x${"9".repeat(64)}`,
      attestation_block_number: "900",
      attestation_block_hash: `0x${"a".repeat(64)}`,
      verified_at: "2026-10-24T00:00:00.000Z",
    });
    const staging = attestation("staging", 84_532);
    const production = attestation("production", 8453);
    const fetches: string[] = [];
    const original = globalThis.fetch;
    // Every chain read goes through this, and fails without leaving the process.
    globalThis.fetch = (async (input: string | URL | Request) => {
      fetches.push(String(input));
      throw new Error("no chain in this test");
    }) as unknown as typeof fetch;
    const cycle = async (
      environment: RewardSafeRuntimeEnvironment,
      productionEnabled: boolean,
      row: ReturnType<typeof attestation>,
    ) => {
      fetches.length = 0;
      const statements: string[] = [];
      const parameters = new Map<string, unknown[][]>();
      const published: string[] = [];
      const execute = (statement: ControlPlaneStatement) => {
        statements.push(statement.label);
        parameters.set(statement.label, [
          ...(parameters.get(statement.label) ?? []),
          [...statement.values],
        ]);
        const rows =
          statement.label === "megapot-drawing-observation.attestation.read" ? [row] : [];
        return Effect.succeed({ rows, rowCount: rows.length });
      };
      const db = {
        execute,
        withTransaction: (use: (transaction: unknown) => unknown) => use({ execute }),
      } as unknown as ControlPlaneDb["Service"];
      const job = makeSafePoolPilotJob(
        {},
        {
          environment,
          attestationId: "megapot-safe-pilot",
          rpcUrl: "https://rpc.example.invalid",
          requiredConfirmations: 3,
          productionEnabled,
          minimumEntrySeconds: 3_600,
          observationTtlMs: 60_000,
          commitmentBucket: {
            get: async () => null,
            put: async (key: string) => {
              published.push(key);
              return null;
            },
          },
          commitmentPublicOrigin: "https://commitments.example.invalid",
        },
      );
      const exit = await Effect.runPromiseExit(
        job.run.pipe(
          Effect.provideService(ControlPlaneDb, db),
          Effect.provideService(AlertCollector, { emit: () => Effect.void }),
          Effect.provideService(JobContext, {
            adapterSafety: { isProven: () => false, markAbortedOrFenced: () => undefined },
            attemptId: "safe-pool-admission-test",
            lease: () => ({ expiresAt: Date.now() + 60_000, generation: 1, owner: "test-owner" }),
            owner: "test-owner",
          }),
          Effect.match({ onFailure: (error) => error, onSuccess: () => null }),
        ),
      );
      const failure = exit._tag === "Success" ? exit.value : exit;
      return { failure, statements, parameters, fetches: [...fetches], published };
    };
    try {
      for (const [environment, productionEnabled, row] of [
        // A production worker never runs a staging rehearsal, with its switch or without.
        ["production", true, staging],
        ["production", false, staging],
        ["production", false, production],
        // A staging or development worker never runs production custody.
        ["staging", false, production],
        ["staging", true, production],
        ["development", true, attestation("test", 84_532)],
      ] as const) {
        const refused = await cycle(environment, productionEnabled, row);
        expect(refused.failure).toMatchObject({
          _tag: "MegapotDrawingObservationRejected",
          reason: "production-disabled",
        });
        // Only the attestation itself was read: no chain call, write or publication.
        expect(refused.statements).toEqual(["megapot-drawing-observation.attestation.read"]);
        expect(refused.fetches).toEqual([]);
        expect(refused.published).toEqual([]);
      }
      // The same harness sees the admitted cycles reach the chain.
      for (const [environment, productionEnabled, row] of [
        ["staging", false, staging],
        ["production", true, production],
      ] as const) {
        const admitted = await cycle(environment, productionEnabled, row);
        expect(admitted.fetches.length).toBeGreaterThan(0);
        expect(admitted.statements.length).toBeGreaterThan(1);
        // Every drawing, cutoff, closing and credit listing is bound to the admitted
        // attestation, so another attestation's work is never selected.
        for (const label of [
          "megapot-ticket-first-cutoff.due.read",
          "reward-safe-purchase.unexecuted.read",
          "megapot-work.drawings.read",
          "megapot-work.credits.read",
        ]) {
          const runs = admitted.parameters.get(label) ?? [];
          expect(runs.length).toBeGreaterThan(0);
          for (const values of runs) expect(values).toContain("megapot-safe-pilot");
        }
      }
    } finally {
      globalThis.fetch = original;
    }
  }, 60_000);
});
