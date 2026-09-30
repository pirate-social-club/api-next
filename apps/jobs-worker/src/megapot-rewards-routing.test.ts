import { describe, expect, test } from "bun:test";
import { ControlPlaneDb, type MegapotDrawingObserverCandidate } from "@pirate/application";
import { deriveBaseSepoliaMegapotAddress } from "@pirate/platform-cf/megapot-v2-signer";
import type {
  MegapotChainEffectKind,
  MegapotDrawingWork,
  MegapotWorkStore,
} from "@pirate/platform-cf/megapot-work-repository";
import { Effect, Layer } from "effect";
import type { MegapotRewardsJobOptions } from "./megapot-rewards.ts";
import { runMegapotRewardsCycle } from "./megapot-rewards-cycle.ts";
import {
  type MegapotAttestationRuntime,
  makeMegapotCustodyKeyResolver,
  makeMegapotRewardsRouting,
} from "./megapot-rewards-routing.ts";
import {
  makeMegapotAttestationRuntime,
  makeMegapotAttestedRpc,
} from "./megapot-rewards-runtime.ts";

// Public deterministic fixture keys, never funded or provisioned.
const primaryKey = `0x${"01".repeat(32)}`;
const retiredKey = `0x${"02".repeat(32)}`;
const primaryCustody = deriveBaseSepoliaMegapotAddress(primaryKey);
const retiredCustody = deriveBaseSepoliaMegapotAddress(retiredKey);
const address = (byte: string) => `0x${byte.repeat(40)}`;
const hash = (byte: string) => `0x${byte.repeat(64)}`;
const deployment = (id: string): MegapotDrawingObserverCandidate => ({
  attestationId: id,
  environment: "staging",
  chainId: 84532,
  jackpotAddress: address(id === "active" ? "a" : "b"),
  usdcAddress: address("1"),
  ticketNftAddress: address(id === "active" ? "c" : "d"),
  custodyAddress: id === "active" ? primaryCustody : retiredCustody,
  referrerAddress: address("3"),
  sourceTag: hash("4"),
  jackpotCodeHash: hash("5"),
  usdcCodeHash: hash("6"),
  ticketNftCodeHash: hash("7"),
  attestationBlockNumber: 100n,
  attestationBlockHash: hash("8"),
  verifiedAt: "2026-09-29T00:00:00.000Z",
});
const drawing = (id: string, status: MegapotDrawingWork["status"]): MegapotDrawingWork => ({
  poolLegId: `leg-${id}`,
  drawingId: 100n,
  status,
  attestationId: id,
  ticketPriceAtomic: 1000000n,
});
const kinds: readonly MegapotChainEffectKind[] = [
  "usdc_approval",
  "ticket_purchase",
  "winnings_claim",
  "reward_refund",
  "reward_payout",
];

function fixture(options: { missingRetiredKey?: boolean; failedRetiredBalance?: boolean } = {}) {
  const calls: string[] = [];
  const builds: string[] = [];
  const key = makeMegapotCustodyKeyResolver(
    primaryKey,
    options.missingRetiredKey ? "" : JSON.stringify({ [retiredCustody]: retiredKey }),
  );
  const routing = makeMegapotRewardsRouting({
    activeAttestationId: "active",
    environment: "staging",
    loadDeployment: (id) => Effect.succeed(deployment(id)),
    loadEffectAttestation: (id) => Effect.succeed(id.split(":")[0] ?? ""),
    loadPayoutAuthority: (id) => Effect.succeed({ attestationId: id, tokenAddress: address("9") }),
    loadRefundAuthority: (id) => Effect.succeed({ attestationId: id, tokenAddress: address("1") }),
    makeRuntime: (candidate) => {
      builds.push(candidate.attestationId);
      const id = candidate.attestationId;
      const call = (operation: string) =>
        Effect.sync(() => {
          calls.push(`${id}:${operation}`);
          return { kind: "confirmed" };
        });
      const send = (operation: string) =>
        Effect.try({ try: () => key(candidate.custodyAddress), catch: (error) => error }).pipe(
          Effect.andThen(call(operation)),
        );
      return {
        observeDrawing: () => call("drawing").pipe(Effect.as(true)),
        observeSolvency: (token) =>
          options.failedRetiredBalance && id === "retired"
            ? Effect.fail(new Error("balance unavailable"))
            : call(`balance:${token ?? "all"}`),
        reconcile: (kind) => send(`reconcile:${kind}`),
        publishCommitment: () => send("commitment"),
        approve: () => send("approve"),
        purchase: () => send("purchase"),
        closeUnavailablePurchase: () => call("purchase-window").pipe(Effect.as(null)),
        sweep: () => call("sweep"),
        claim: () => send("claim"),
        refund: () => send("refund"),
        payout: () => send("payout"),
      } satisfies MegapotAttestationRuntime;
    },
  });
  const work: MegapotWorkStore = {
    loadChainEffects: () =>
      Effect.succeed(
        ["retired", "active"].flatMap((id) =>
          kinds.map((effectKind) => ({ effectId: `${id}:${effectKind}`, effectKind })),
        ),
      ),
    loadDrawings: ({ statuses }) =>
      Effect.succeed(
        ["retired", "active"].flatMap((id) => statuses.map((status) => drawing(id, status))),
      ),
    loadRefunds: () => Effect.succeed(["retired", "active"]),
    loadCredits: () => Effect.succeed(["retired", "active"]),
    loadAgedPending: () => Effect.succeed([]),
  };
  const runtime = {
    ...routing,
    observeDrawing: () =>
      routing.active().pipe(Effect.flatMap((runtime) => runtime.observeDrawing())),
    observeSolvency: () =>
      routing.active().pipe(Effect.flatMap((runtime) => runtime.observeSolvency())),
    freezeDue: () => Effect.succeed([]),
    allocate: () => Effect.void,
    closeExpiredOffers: () => Effect.succeed([]),
  };
  return { calls, builds, routing, work, runtime };
}

describe("jobs Worker obligation routing", () => {
  test("one scheduled cycle handles both contract generations and refreshes each obligation's token", async () => {
    const { calls, builds, work, runtime } = fixture();
    const result = await Effect.runPromise(runMegapotRewardsCycle({ work, runtime }));
    expect(result.failures).toEqual([]);
    expect(result).toMatchObject({
      reconciled: 10,
      committed: 2,
      purchased: 2,
      claimed: 2,
      refunded: 2,
      paid: 2,
    });
    expect(builds.sort()).toEqual(["active", "retired"]);
    expect(calls.filter((call) => call.endsWith(":drawing"))).toEqual(["active:drawing"]);
    for (const id of ["retired", "active"]) {
      for (const kind of kinds) expect(calls).toContain(`${id}:reconcile:${kind}`);
      for (const phase of ["commitment", "approve", "purchase", "sweep", "claim"])
        expect(calls).toContain(`${id}:${phase}`);
      expect(calls[calls.indexOf(`${id}:refund`) - 1]).toBe(`${id}:balance:${address("1")}`);
      expect(calls[calls.indexOf(`${id}:payout`) - 1]).toBe(`${id}:balance:${address("9")}`);
    }
  });

  test("a missing retired signer holds its sends while active work and retired sweeps continue", async () => {
    const { calls, work, runtime } = fixture({ missingRetiredKey: true });
    const result = await Effect.runPromise(runMegapotRewardsCycle({ work, runtime }));
    expect(result.failures).toContain("MegapotRewardRoutingRejected");
    expect(result).toMatchObject({ reconciled: 5, refunded: 1, paid: 1, purchased: 1 });
    expect(calls).toContain("retired:sweep");
    expect(calls).not.toContain("retired:refund");
    expect(calls).not.toContain("retired:payout");
    expect(calls).toContain("active:refund");
  });

  test("a failed retired balance read prevents its sends without blocking the active custody", async () => {
    const { calls, work, runtime } = fixture({ failedRetiredBalance: true });
    const result = await Effect.runPromise(runMegapotRewardsCycle({ work, runtime }));
    expect(result).toMatchObject({ refunded: 1, paid: 1 });
    expect(calls).not.toContain("retired:refund");
    expect(calls).not.toContain("retired:payout");
    expect(calls).toContain("active:payout");
  });

  test("rejects identity, environment and chain mismatches before constructing a runtime", async () => {
    for (const changed of [
      { attestationId: "wrong" },
      { environment: "production" as const },
      { chainId: 8453 },
    ]) {
      const routing = makeMegapotRewardsRouting({
        activeAttestationId: "active",
        environment: "staging",
        loadDeployment: () => Effect.succeed({ ...deployment("active"), ...changed }),
        loadEffectAttestation: () => Effect.succeed("active"),
        loadPayoutAuthority: () =>
          Effect.succeed({ attestationId: "active", tokenAddress: address("1") }),
        loadRefundAuthority: () =>
          Effect.succeed({ attestationId: "active", tokenAddress: address("1") }),
        makeRuntime: () => {
          throw new Error("must never construct mismatched runtime");
        },
      });
      await expect(Effect.runPromise(routing.payout("credit"))).rejects.toMatchObject({
        reason: "attestation-mismatch",
      });
    }
  });

  test("refuses missing effect lineage before loading any deployment", async () => {
    const { routing } = fixture();
    // A bad effect resolver fails before the per-attestation runtime can run.
    const broken = makeMegapotRewardsRouting({
      activeAttestationId: "active",
      environment: "staging",
      loadDeployment: () => Effect.die("unexpected deployment read"),
      loadEffectAttestation: () => Effect.fail(new Error("missing lineage")),
      loadPayoutAuthority: () => Effect.die("unused"),
      loadRefundAuthority: () => Effect.die("unused"),
      makeRuntime: () => {
        throw new Error("unused");
      },
    });
    await expect(
      Effect.runPromise(broken.reconcile({ effectId: "missing", effectKind: "reward_payout" })),
    ).rejects.toThrow("missing lineage");
    await Effect.runPromise(
      routing.reconcile({ effectId: "retired:payout", effectKind: "reward_payout" }),
    );
  });
});

describe("retained custody configuration", () => {
  test("selects only the key matching the immutable custody address", () => {
    const resolve = makeMegapotCustodyKeyResolver(
      primaryKey,
      JSON.stringify({ [retiredCustody]: retiredKey }),
    );
    expect(resolve(primaryCustody)).toBe(primaryKey);
    expect(resolve(retiredCustody)).toBe(retiredKey);
    expect(() => resolve(address("f"))).toThrow("signing-authority-missing");
  });

  test("rejects malformed, mismatched and oversized secret maps without disclosing their input", () => {
    for (const source of [
      "not-json",
      JSON.stringify({ [retiredCustody]: primaryKey }),
      JSON.stringify({ [retiredCustody]: "invalid-private-key" }),
      "x".repeat(8193),
      JSON.stringify(Array.from({ length: 33 }, () => primaryKey)),
    ]) {
      try {
        makeMegapotCustodyKeyResolver(primaryKey, source);
        throw new Error("configuration unexpectedly admitted");
      } catch (error) {
        expect(error).toMatchObject({
          _tag: "MegapotRewardRoutingRejected",
          reason: "invalid-config",
        });
        expect(String(error)).not.toContain(source);
        expect(String(error)).not.toContain(primaryKey);
      }
    }
  });
});

// Exercise the production runtime factory, not just the routing callbacks.
describe("attestation runtime construction", () => {
  const options: MegapotRewardsJobOptions = {
    environment: "staging",
    workerVersion: { id: "fixture", tag: "", timestamp: "" },
    attestationId: "active",
    rpcUrl: "https://rpc.invalid",
    custodyPrivateKey: primaryKey,
    gasTopupPrivateKey: null,
    commitmentBucket: { put: async () => ({ uploaded: new Date() }), get: async () => null },
    commitmentPublicOrigin: "https://commitments.invalid",
    requiredConfirmations: 3,
    observationTtlMs: 900000,
    approvedAllowanceAtomic: 10000000n,
    purchaseSafetyMarginSeconds: 30,
    gasLimitMultiplierBps: 12000,
    nativeGasReserveFloorWei: 0n,
    externalSponsorDailyTicketCeiling: 10,
    externalSponsorDailySpendCeilingAtomic: 10000000n,
    sharedSponsorDailyTicketCeiling: 10,
    sharedSponsorDailySpendCeilingAtomic: 10000000n,
  };
  test("creates RPC clients pinned to each original contract and custody", () => {
    for (const id of ["retired", "active"]) {
      const original = deployment(id);
      const rpc = makeMegapotAttestedRpc(original, options.rpcUrl);
      expect(rpc.deployment).toMatchObject({
        attestationId: id,
        jackpotAddress: original.jackpotAddress,
        ticketNftAddress: original.ticketNftAddress,
        custodyAddress: original.custodyAddress,
      });
    }
  });

  test("uses the matching signer before repository access and refuses a missing key before nonce reservation", async () => {
    const queries: string[] = [];
    const db: ControlPlaneDb["Service"] = {
      execute: (statement) =>
        Effect.sync(() => {
          queries.push(statement.label);
          return { rows: [], rowCount: 0 };
        }),
      withTransaction: (use) => use(db),
    };
    const resolve = makeMegapotCustodyKeyResolver(
      primaryKey,
      JSON.stringify({ [retiredCustody]: retiredKey }),
    );
    for (const id of ["retired", "active"]) {
      const runtime = makeMegapotAttestationRuntime({
        deployment: deployment(id),
        controlPlane: Layer.succeed(ControlPlaneDb, db),
        options,
        resolveCustodyKey: resolve,
      });
      await expect(
        Effect.runPromise(runtime.reconcile("reward_payout", `effect-${id}`)),
      ).rejects.toMatchObject({ _tag: "RewardPayoutCoordinatorFailed", reason: "invalid_config" });
    }
    expect(queries).toHaveLength(2);
    const missing = makeMegapotAttestationRuntime({
      deployment: deployment("retired"),
      controlPlane: Layer.succeed(ControlPlaneDb, db),
      options,
      resolveCustodyKey: makeMegapotCustodyKeyResolver(primaryKey),
    });
    await expect(Effect.runPromise(missing.refund("funding-retired"))).rejects.toMatchObject({
      reason: "signing-authority-missing",
    });
    expect(queries).toHaveLength(2);
  });
});
