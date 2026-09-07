import { Schema } from "effect";
import { reconciliationDigest } from "../packages/platform-cf/src/karaoke-reconciliation-evidence.ts";
import {
  decodeReconciliation,
  ReconciliationDigest,
  ReconciliationText,
  ReconciliationTime,
} from "../packages/platform-cf/src/karaoke-reconciliation-schema.ts";
import { KaraokeReleaseFailure } from "./staging-karaoke-release-failure.ts";

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
  restorationDigest: Schema.optional(ReconciliationDigest),
  surfaceOrder: Schema.Array(Schema.Literals(["ingress", "producers", "database"] as const)).check(
    Schema.isMinLength(3),
    Schema.isMaxLength(3),
  ),
});
export type KaraokeReleasePlan = typeof KaraokeReleasePlan.Type;

export type KaraokeReleaseSurface = "ingress" | "producers" | "database";

export type KaraokeSurfaceReceipt = {
  readonly surface: KaraokeReleaseSurface;
  readonly releasedAt: string;
  readonly receipt: string;
  readonly providerEvidence?: string | undefined;
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
  const order = plan.surfaceOrder;
  if (
    order === undefined ||
    new Set(order).size !== 3 ||
    !["ingress", "producers", "database"].every((surface) => order.includes(surface as never))
  )
    return "approved release surface order";
  return null;
}

/** The concrete release operation. Surfaces restore in the reviewed
 * `surfaceOrder` (an approved plan decision, never a code default, because
 * restoring ingress before writers would admit requests into a still-fenced
 * system). Every attempt reports through `onAttempt` before and after so the
 * caller retains authenticated, intent-bound evidence durably. A failed or
 * uncertain surface leaves the result unresolved with the receipts that did
 * complete; this operation never retries and never re-executes a completed
 * surface. The returned time is the last surface restoration *confirmation*
 * — an exact collector observation and an upper bound on a proved effect,
 * not the physical mutation time. A lost response produces neither a receipt
 * nor a bound from which execution time may be reconstructed. */
export async function executeKaraokeFenceRelease(input: {
  readonly plan: unknown;
  readonly surfaces: KaraokeReleaseSurfaces;
  readonly onAttempt?: (record: {
    readonly surface: KaraokeReleaseSurface;
    readonly phase: "intent" | "released" | "uncertain";
    readonly receipt?: KaraokeSurfaceReceipt;
    readonly failure?: { readonly stage: string; readonly sqlstate: string | null };
  }) => void;
  readonly now?: () => string;
}) {
  const now = input.now ?? (() => new Date().toISOString());
  if (typeof input.plan !== "object" || input.plan === null || Array.isArray(input.plan))
    throw new Error("karaoke_release_plan_incomplete:approved restoration plan");
  const decision = missingDecision(input.plan as Partial<KaraokeReleasePlan>);
  if (decision !== null) throw new Error(`karaoke_release_plan_incomplete:${decision}`);
  const plan = decodeReconciliation(KaraokeReleasePlan, input.plan);
  if (
    new Set(plan.resumeQueues.map((queue) => queue.id)).size !== plan.resumeQueues.length ||
    new Set(plan.resumeQueues.map((queue) => queue.name)).size !== plan.resumeQueues.length ||
    new Set(plan.servingWorkers.map((worker) => worker.worker)).size !== plan.servingWorkers.length
  )
    throw new Error("karaoke_release_plan_duplicate_target");
  const directives: Record<KaraokeReleaseSurface, unknown> = {
    ingress: { applicationId: plan.ingressApplicationId },
    producers: { resumeQueues: plan.resumeQueues, servingWorkers: plan.servingWorkers },
    database: { reviewedGrantDigest: plan.reviewedGrantDigest },
  };
  const order = plan.surfaceOrder.map(
    (surface) => [surface, directives[surface]] as [KaraokeReleaseSurface, unknown],
  );
  const receipts: KaraokeSurfaceReceipt[] = [];
  for (const [surface, directive] of order) {
    input.onAttempt?.({ surface, phase: "intent" });
    try {
      const startedAt = decodeReconciliation(ReconciliationTime, now());
      const receipt = decodeReconciliation(
        Schema.Struct({
          surface: Schema.Literal(surface),
          releasedAt: ReconciliationTime,
          receipt: ReconciliationText,
          providerEvidence: Schema.optional(Schema.String.check(Schema.isMaxLength(65_536))),
        }),
        await input.surfaces[surface](directive, now),
      );
      if (
        Date.parse(receipt.releasedAt) < Date.parse(startedAt) ||
        Date.parse(receipt.releasedAt) > Date.parse(now())
      )
        throw new Error("karaoke_release_confirmation_time_unproven");
      if (receipt.surface !== surface) throw new Error("karaoke_release_surface_mismatch");
      if (
        receipt.providerEvidence !== undefined &&
        reconciliationDigest(receipt.providerEvidence) !== receipt.receipt
      )
        throw new Error("karaoke_release_provider_evidence_changed");
      receipts.push(receipt);
      input.onAttempt?.({ surface, phase: "released", receipt });
    } catch (error) {
      input.onAttempt?.({
        surface,
        phase: "uncertain",
        failure:
          error instanceof KaraokeReleaseFailure
            ? { stage: error.stage, sqlstate: error.sqlstate }
            : { stage: surface, sqlstate: null },
      });
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
