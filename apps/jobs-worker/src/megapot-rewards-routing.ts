import type { MegapotDrawingObserverCandidate } from "@pirate/application";
import type { RewardObligationAuthority } from "@pirate/platform-cf";
import { deriveBaseSepoliaMegapotAddress } from "@pirate/platform-cf/megapot-v2-signer";
import type {
  MegapotChainEffectKind,
  MegapotDrawingWork,
} from "@pirate/platform-cf/megapot-work-repository";
import { Data, Effect, Schema } from "effect";
import type { MegapotRewardsRuntime } from "./megapot-rewards-cycle.ts";

export class MegapotRewardRoutingRejected extends Data.TaggedError("MegapotRewardRoutingRejected")<{
  readonly reason: "invalid-config" | "attestation-mismatch" | "signing-authority-missing";
}> {
  override get message(): string {
    return this.reason;
  }
}

const retainedKeys = Schema.Record(
  Schema.String,
  Schema.String.check(Schema.isPattern(/^0x[0-9a-f]{64}$/u)),
).check(Schema.isMaxProperties(32));

/** A bounded secret key ring indexed by custody, not by whichever contract is active. */
export function makeMegapotCustodyKeyResolver(primary: string, retained = "") {
  const keys = new Map<string, string>();
  try {
    keys.set(deriveBaseSepoliaMegapotAddress(primary), primary);
    if (retained !== "") {
      if (retained.length > 8_192) throw new Error("oversized key ring");
      const decoded = Schema.decodeUnknownSync(retainedKeys)(JSON.parse(retained));
      for (const [custody, key] of Object.entries(decoded)) {
        if (
          !/^0x[0-9a-f]{40}$/u.test(custody) ||
          deriveBaseSepoliaMegapotAddress(key) !== custody
        ) {
          throw new Error("invalid custody identity");
        }
        keys.set(custody, key);
      }
    }
  } catch {
    // Never propagate schema diagnostics containing secret input.
    throw new MegapotRewardRoutingRejected({ reason: "invalid-config" });
  }
  return (custody: string): string => {
    const key = keys.get(custody.toLowerCase());
    if (key === undefined)
      throw new MegapotRewardRoutingRejected({ reason: "signing-authority-missing" });
    return key;
  };
}

export interface MegapotAttestationRuntime {
  readonly observeDrawing: () => Effect.Effect<boolean, unknown>;
  readonly observeSolvency: (tokenAddress?: string) => Effect.Effect<unknown, unknown>;
  readonly reconcile: (
    kind: MegapotChainEffectKind,
    effectId: string,
  ) => Effect.Effect<unknown, unknown>;
  readonly publishCommitment: (work: MegapotDrawingWork) => Effect.Effect<unknown, unknown>;
  readonly approve: MegapotRewardsRuntime["approve"];
  readonly purchase: MegapotRewardsRuntime["purchase"];
  readonly closeUnavailablePurchase: MegapotRewardsRuntime["closeUnavailablePurchase"];
  readonly sweep: MegapotRewardsRuntime["sweep"];
  readonly claim: MegapotRewardsRuntime["claim"];
  readonly refund: MegapotRewardsRuntime["refund"];
  readonly payout: MegapotRewardsRuntime["payout"];
}

/** Per-cycle cache; each item still resolves its own persisted authority before use. */
export function makeMegapotRewardsRouting(input: {
  readonly activeAttestationId: string;
  readonly environment: string;
  readonly loadDeployment: (id: string) => Effect.Effect<MegapotDrawingObserverCandidate, unknown>;
  readonly loadEffectAttestation: (
    id: string,
    kind: MegapotChainEffectKind,
  ) => Effect.Effect<string, unknown>;
  readonly loadPayoutAuthority: (id: string) => Effect.Effect<RewardObligationAuthority, unknown>;
  readonly loadRefundAuthority: (id: string) => Effect.Effect<RewardObligationAuthority, unknown>;
  readonly makeRuntime: (deployment: MegapotDrawingObserverCandidate) => MegapotAttestationRuntime;
}) {
  const runtimes = new Map<string, MegapotAttestationRuntime>();
  const load = Effect.fn("MegapotRewardsRouting.load")(function* (id: string) {
    const existing = runtimes.get(id);
    if (existing !== undefined) return existing;
    const deployment = yield* input.loadDeployment(id);
    const environment = input.environment === "development" ? "test" : input.environment;
    if (
      deployment.attestationId !== id ||
      deployment.environment !== environment ||
      deployment.chainId !== 84_532
    ) {
      return yield* new MegapotRewardRoutingRejected({ reason: "attestation-mismatch" });
    }
    const runtime = yield* Effect.try({
      try: () => input.makeRuntime(deployment),
      catch: () => new MegapotRewardRoutingRejected({ reason: "invalid-config" }),
    });
    runtimes.set(id, runtime);
    return runtime;
  });
  const drawing = <A>(
    work: MegapotDrawingWork,
    f: (runtime: MegapotAttestationRuntime) => Effect.Effect<A, unknown>,
  ) => load(work.attestationId).pipe(Effect.flatMap(f));

  return {
    active: () => load(input.activeAttestationId),
    reconcile: Effect.fn("MegapotRewardsRouting.reconcile")(function* (work: {
      effectId: string;
      effectKind: MegapotChainEffectKind;
    }) {
      const id = yield* input.loadEffectAttestation(work.effectId, work.effectKind);
      const runtime = yield* load(id);
      return yield* runtime.reconcile(work.effectKind, work.effectId);
    }),
    publishCommitment: (work: MegapotDrawingWork) =>
      drawing(work, (runtime) => runtime.publishCommitment(work)),
    approve: (work: MegapotDrawingWork) => drawing(work, (runtime) => runtime.approve(work)),
    purchase: (work: MegapotDrawingWork) => drawing(work, (runtime) => runtime.purchase(work)),
    closeUnavailablePurchase: (work: MegapotDrawingWork) =>
      drawing(work, (runtime) => runtime.closeUnavailablePurchase(work)),
    sweep: (work: MegapotDrawingWork) => drawing(work, (runtime) => runtime.sweep(work)),
    claim: (work: MegapotDrawingWork) => drawing(work, (runtime) => runtime.claim(work)),
    refund: Effect.fn("MegapotRewardsRouting.refund")(function* (id: string) {
      const authority = yield* input.loadRefundAuthority(id);
      const runtime = yield* load(authority.attestationId);
      yield* runtime.observeSolvency(authority.tokenAddress);
      return yield* runtime.refund(id);
    }),
    payout: Effect.fn("MegapotRewardsRouting.payout")(function* (id: string) {
      const authority = yield* input.loadPayoutAuthority(id);
      const runtime = yield* load(authority.attestationId);
      yield* runtime.observeSolvency(authority.tokenAddress);
      return yield* runtime.payout(id);
    }),
  };
}
