import { Schema } from "effect";
import {
  ReconciliationDigest,
  ReconciliationText,
} from "../packages/platform-cf/src/karaoke-reconciliation-schema.ts";

const Id = Schema.String.check(Schema.isPattern(/^[a-f0-9-]{32,36}$/u));
const Worker = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));

/** Reviewed restoration directives only. Serving versions, queue identities
 * and the reviewed grant digest come from recorded approvals; this module
 * never infers them from current provider state and never broadens
 * privileges. An incomplete plan refuses before any mutation and names the
 * missing decision. */
export const KaraokeReleasePlan = Schema.Struct({
  version: Schema.Literal("staging-karaoke-release-plan-v1"),
  ingressApplicationId: Id,
  resumeQueues: Schema.Array(Schema.Struct({ name: ReconciliationText, id: Id })).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(16),
  ),
  servingWorkers: Schema.Array(Schema.Struct({ worker: Worker, versionId: Id })).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(16),
  ),
  reviewedGrantDigest: ReconciliationDigest,
});
export type KaraokeReleasePlan = typeof KaraokeReleasePlan.Type;

export type KaraokeReleaseSurface = "ingress" | "producers" | "database";

export type KaraokeSurfaceReceipt = {
  readonly surface: KaraokeReleaseSurface;
  readonly releasedAt: string;
  readonly receipt: string;
};

/** Thin per-surface executors. Live composition binds them to the same
 * authenticated provider transports the collectors use; each must perform
 * exactly its reviewed directive and return a provider receipt. */
export type KaraokeReleaseSurfaces = Readonly<
  Record<
    KaraokeReleaseSurface,
    (directive: unknown, releasedAt: () => string) => Promise<KaraokeSurfaceReceipt>
  >
>;

export type KaraokeReleaseResult =
  | {
      readonly disposition: "released";
      readonly receipts: readonly KaraokeSurfaceReceipt[];
      readonly releasedAt: string;
    }
  | { readonly disposition: "unresolved"; readonly receipts: readonly KaraokeSurfaceReceipt[] };

function missingDecision(plan: Partial<KaraokeReleasePlan>): string | null {
  if (plan.ingressApplicationId === undefined) return "ingress application id for exact reversal";
  if (!plan.resumeQueues?.length) return "approved queue resume list";
  if (!plan.servingWorkers?.length) return "approved serving worker versions";
  if (plan.reviewedGrantDigest === undefined) return "reviewed runtime grant digest";
  return null;
}

/** The concrete release operation. Surfaces restore in fixed order — ingress,
 * producers, database — and every attempt reports through `onAttempt` before
 * and after so the caller retains authenticated, intent-bound evidence
 * durably. A failed or uncertain surface leaves the result unresolved with
 * the receipts that did complete; this operation never retries, never
 * re-executes a completed surface, and never fabricates a release time: the
 * release time is the moment the last surface's restoration was confirmed. */
export async function executeKaraokeFenceRelease(input: {
  readonly plan: unknown;
  readonly surfaces: KaraokeReleaseSurfaces;
  readonly onAttempt?: (record: {
    readonly surface: KaraokeReleaseSurface;
    readonly phase: "intent" | "released" | "uncertain";
    readonly receipt?: KaraokeSurfaceReceipt;
  }) => void;
  readonly now?: () => string;
}) {
  const now = input.now ?? (() => new Date().toISOString());
  const decision = missingDecision(input.plan as Partial<KaraokeReleasePlan>);
  if (decision !== null) throw new Error(`karaoke_release_plan_incomplete:${decision}`);
  const plan = input.plan as KaraokeReleasePlan;
  const order: readonly [KaraokeReleaseSurface, unknown][] = [
    ["ingress", { applicationId: plan.ingressApplicationId }],
    ["producers", { resumeQueues: plan.resumeQueues, servingWorkers: plan.servingWorkers }],
    ["database", { reviewedGrantDigest: plan.reviewedGrantDigest }],
  ];
  const receipts: KaraokeSurfaceReceipt[] = [];
  for (const [surface, directive] of order) {
    input.onAttempt?.({ surface, phase: "intent" });
    try {
      const receipt = await input.surfaces[surface](directive, now);
      if (receipt.surface !== surface) throw new Error("karaoke_release_surface_mismatch");
      receipts.push(receipt);
      input.onAttempt?.({ surface, phase: "released", receipt });
    } catch (error) {
      input.onAttempt?.({ surface, phase: "uncertain" });
      void error;
      return { disposition: "unresolved" as const, receipts };
    }
  }
  const releasedAt = receipts.at(-1)?.releasedAt;
  if (releasedAt === undefined) return { disposition: "unresolved" as const, receipts };
  return { disposition: "released" as const, receipts, releasedAt };
}

/** Explicit released-state observation for one surface. This never weakens
 * held-fence validation: the held collector stays as-is, and this path
 * answers only whether the surface is positively restored, still fenced, or
 * uncertain. */
export async function observeKaraokeReleasedSurface(input: {
  readonly surface: KaraokeReleaseSurface;
  readonly observe: () => Promise<"restored" | "fenced" | "uncertain">;
}): Promise<"restored" | "fenced" | "uncertain"> {
  try {
    return await input.observe();
  } catch {
    return "uncertain";
  }
}
