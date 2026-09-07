import { Schema } from "effect";
import { reconciliationDigest } from "../packages/platform-cf/src/karaoke-reconciliation-evidence.ts";
import {
  decodeReconciliation,
  ReconciliationDigest,
  ReconciliationTime,
} from "../packages/platform-cf/src/karaoke-reconciliation-schema.ts";
import { KaraokeResetSnapshotSchema } from "../packages/platform-cf/src/karaoke-reset-inspection.ts";
import {
  KARAOKE_RESET_GENERATION,
  KARAOKE_RESET_INVENTORY_DIGEST,
  KARAOKE_RESET_NAMESPACE_ID,
  KARAOKE_RESET_OBJECT_IDS,
} from "../packages/platform-cf/src/karaoke-reset-installation.ts";
import type { KaraokeJournalTrust } from "./karaoke-maintenance-journal.ts";
import { signedBytes, verifiedPayload } from "./karaoke-maintenance-journal.ts";
import type {
  KaraokeAdapterTrust,
  KaraokeCollectorChallenge,
} from "./karaoke-reconciliation-adapter.ts";
import {
  IntentRecord,
  NotExecutedRecord,
  recordKaraokeFenceRelease,
} from "./staging-karaoke-record-release.ts";
import {
  persistKaraokeReleaseClaim,
  replaceCancelledKaraokeReleaseClaim,
} from "./staging-karaoke-release-claim.ts";
import {
  executeKaraokeFenceRelease,
  KaraokeReleasePlan,
  type KaraokeReleaseResult,
  type KaraokeReleaseSurface,
  observeKaraokeReleasedSurface,
} from "./staging-karaoke-release-operation.ts";
import type { KaraokeSigningReaders } from "./staging-karaoke-signing-collector.ts";

const ClaimRecord = Schema.Struct({
  kind: Schema.Literals(["executing", "cancelled"]),
  planDigest: ReconciliationDigest,
  intentId: ReconciliationDigest,
  recordedAt: ReconciliationTime,
});

/** Durable, authenticated surface-attempt evidence. The writer signs with the
 * pinned collector key; the reader verifies signatures and rejects anything
 * unsigned or foreign. */
export interface KaraokeReleaseEvidenceStore {
  put(record: unknown): void;
  list(intentId: string): {
    surface?: KaraokeReleaseSurface;
    phase: string;
    releasedAt?: string;
    recordedAt?: string;
    planDigest?: string;
  }[];
  /** Exactly one of executing or cancelled may ever be claimed for this
   * intent. The winner is decided atomically by create-once semantics with
   * file and directory durability; a partially written or malformed claim,
   * or one bound to a different plan digest, refuses rather than granting a
   * retry. Keyed by the ceremony's intent, not by the mutable plan. */
  claim(
    kind: "executing" | "cancelled",
    planDigest: string,
    intentId: string,
  ): Promise<
    "granted" | "refused-cancelled" | "refused-executing" | "refused-foreign" | "uncertain"
  >;
}

export function makeKaraokeReleaseEvidenceStore(
  directory: string,
  privateKeyPem: string,
  publicKeyPem: string,
  write: (bytes: string) => void,
  names: () => string[],
  read: (name: string) => string,
): KaraokeReleaseEvidenceStore {
  const claimFile = "release-claim.json";
  const readSigned = (id: string) => {
    decodeReconciliation(ReconciliationDigest, id);
    const bytes = read(`${id}.json`);
    if (reconciliationDigest(bytes) !== id)
      throw new Error("karaoke_release_evidence_digest_changed");
    return verifiedPayload(bytes, publicKeyPem);
  };
  const readClaim = (): {
    kind: "executing" | "cancelled";
    planDigest: string;
    intentId: string;
    recordedAt: string;
  } => {
    return decodeReconciliation(ClaimRecord, verifiedPayload(read(claimFile), publicKeyPem));
  };
  return {
    put(record) {
      write(
        signedBytes(
          { ...(record as object), scope: "staging-karaoke-release-surface" },
          privateKeyPem,
        ),
      );
    },
    async claim(kind, planDigest, intentId) {
      const intent = decodeReconciliation(IntentRecord, readSigned(intentId));
      if (intent.planDigest !== planDigest) throw new Error("karaoke_release_plan_changed");
      const bytes = signedBytes(
        { kind, planDigest, intentId, recordedAt: new Date().toISOString() },
        privateKeyPem,
      );
      if (persistKaraokeReleaseClaim(directory, bytes)) return "granted" as const;
      // Someone claimed first. Malformed or partial content is uncertain —
      // never permission to retry — and a foreign plan digest refuses.
      const existing = (() => {
        try {
          return readClaim();
        } catch {
          return undefined;
        }
      })();
      if (existing === undefined) return "uncertain";
      if (existing.planDigest !== planDigest) return "refused-foreign";
      if (existing.intentId !== intentId) {
        if (existing.kind !== "cancelled" || intent.previousNotExecutedId === null)
          return "refused-foreign";
        const prior = decodeReconciliation(IntentRecord, readSigned(existing.intentId));
        const closed = decodeReconciliation(
          NotExecutedRecord,
          readSigned(intent.previousNotExecutedId),
        );
        if (
          closed.kind !== "release-not-executed" ||
          closed.intentId !== existing.intentId ||
          closed.epoch !== intent.epoch ||
          closed.bucket !== intent.bucket ||
          closed.residualDispositionId !== intent.residualDispositionId ||
          prior.epoch !== intent.epoch ||
          prior.bucket !== intent.bucket ||
          prior.residualDispositionId !== intent.residualDispositionId ||
          prior.planDigest !== planDigest ||
          Date.parse(closed.recordedAt) < Date.parse(prior.recordedAt) ||
          Date.parse(closed.recordedAt) > Date.parse(intent.recordedAt) ||
          closed.expectedHead.sequence < prior.expectedHead.sequence ||
          closed.expectedHead.sequence > intent.expectedHead.sequence
        )
          return "refused-foreign";
        const previousBytes = read(claimFile);
        const previous = decodeReconciliation(
          ClaimRecord,
          verifiedPayload(previousBytes, publicKeyPem),
        );
        if (
          previous.kind !== "cancelled" ||
          previous.intentId !== existing.intentId ||
          previous.planDigest !== planDigest
        )
          return "uncertain";
        return replaceCancelledKaraokeReleaseClaim(directory, previousBytes, bytes)
          ? "granted"
          : "uncertain";
      }
      return existing.kind === kind
        ? kind === "executing"
          ? "refused-executing"
          : "refused-cancelled"
        : existing.kind === "cancelled"
          ? "refused-cancelled"
          : "refused-executing";
    },
    list(intentId) {
      const found: {
        surface?: KaraokeReleaseSurface;
        phase: string;
        releasedAt?: string;
        recordedAt?: string;
        planDigest?: string;
      }[] = [];
      try {
        const claim = readClaim();
        if (claim.intentId !== intentId) throw new Error("karaoke_release_claim_foreign_intent");
        found.push({
          phase: claim.kind === "cancelled" ? "cancelled" : "executing",
          planDigest: claim.planDigest,
          recordedAt: claim.recordedAt,
        });
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      for (const name of names()) {
        const bytes = read(name);
        if (reconciliationDigest(bytes) !== name.replace(/\.json$/u, ""))
          throw new Error("karaoke_release_evidence_digest_changed");
        const outer = JSON.parse(bytes);
        const candidate = typeof outer.payload === "string" ? JSON.parse(outer.payload) : outer;
        if (candidate?.scope !== "staging-karaoke-release-surface") continue;
        const payload = verifiedPayload(bytes, publicKeyPem) as {
          scope?: string;
          surface?: KaraokeReleaseSurface;
          phase?: string;
          releasedAt?: string;
          recordedAt?: string;
          planDigest?: string;
          intentId?: string;
        };
        if (payload.scope === "staging-karaoke-release-surface") {
          if (payload.intentId !== intentId)
            throw new Error("karaoke_release_claim_foreign_intent");
          found.push({
            ...(payload.surface === undefined ? {} : { surface: payload.surface }),
            phase: payload.phase ?? "unknown",
            ...(payload.releasedAt === undefined ? {} : { releasedAt: payload.releasedAt }),
            ...(payload.recordedAt === undefined ? {} : { recordedAt: payload.recordedAt }),
            ...(payload.planDigest === undefined ? {} : { planDigest: payload.planDigest }),
          });
        }
      }
      return found;
    },
  };
}

/** The thin binding between the concrete release operation and the release
 * origin. It closes over the owned surfaces, observers and evidence store,
 * assembles the origin's port results, and owns no disposition logic: an
 * unresolved operation throws to the origin (which records it), recovery
 * reads only authenticated retained receipts, and a release time is never
 * reconstructed from current state. */
export function makeKaraokeReleaseBinding(input: {
  /** Reviewed plan; its digest is cryptographically bound into every retained
   * attempt record and cancellation, and recovery refuses evidence bound to
   * a different plan. Shape completeness does not establish approval; the
   * recorded owner approval must match this exact digest. */
  readonly plan: KaraokeReleasePlan;
  readonly surfaces: Parameters<typeof executeKaraokeFenceRelease>[0]["surfaces"];
  readonly observeRestored: Record<
    KaraokeReleaseSurface,
    () => Promise<"restored" | "fenced" | "uncertain">
  >;
  readonly evidence: KaraokeReleaseEvidenceStore;
  readonly readers: KaraokeSigningReaders;
  readonly now?: () => string;
}) {
  // Do not retain caller-owned arrays after binding the signed digest.
  const plan = decodeReconciliation(KaraokeReleasePlan, structuredClone(input.plan));
  const planDigest = reconciliationDigest(JSON.stringify(plan));
  const observeSurfaces = () =>
    Promise.all(
      (["ingress", "producers", "database"] as const).map((surface) =>
        observeKaraokeReleasedSurface({
          surface,
          observe: async () => input.observeRestored[surface]?.() ?? "uncertain",
        }),
      ),
    );
  const allSixRetired = async () => {
    for (const objectId of KARAOKE_RESET_OBJECT_IDS) {
      const snapshot = decodeReconciliation(
        KaraokeResetSnapshotSchema,
        await input.readers.inspect({
          namespaceId: KARAOKE_RESET_NAMESPACE_ID,
          objectId,
          generation: KARAOKE_RESET_GENERATION,
          inventoryDigest: KARAOKE_RESET_INVENTORY_DIGEST,
        }),
      );
      if (snapshot.markerState !== "retired") return false;
    }
    return true;
  };
  const claimExclusive = async (
    kind: "executing" | "cancelled",
    intent: { planDigest: string; intentId: string },
  ) => {
    if (intent.planDigest !== planDigest) throw new Error("karaoke_release_plan_changed");
    const claim = await input.evidence.claim(kind, planDigest, intent.intentId);
    if (claim !== "granted") throw new Error(`karaoke_release_claim_${claim}`);
  };
  return {
    /** Durable pre-execution cancellation through the same exclusive claim
     * the executor must acquire: exactly one of executing or cancelled may
     * ever exist for this intent, and cancellation cannot supersede it. */
    async cancelBeforeExecution(intent: {
      readonly planDigest: string;
      readonly intentId: string;
    }): Promise<void> {
      await claimExclusive("cancelled", intent);
    },
    async verifyFenceRelease(intent: {
      readonly planDigest: string;
      readonly intentId: string;
    }): Promise<{ releasedAt: string; allSixRetired: boolean }> {
      if (intent.planDigest !== planDigest) throw new Error("karaoke_release_plan_changed");
      if (!(await allSixRetired())) throw new Error("karaoke_release_markers_unproven");
      // Mutation requires a successfully persisted executing claim; failed,
      // malformed or uncertain claim persistence refuses here.
      await claimExclusive("executing", intent);
      const result: KaraokeReleaseResult = await executeKaraokeFenceRelease({
        plan,
        surfaces: input.surfaces,
        ...(input.now === undefined ? {} : { now: input.now }),
        onAttempt: (record) =>
          input.evidence.put({
            planDigest,
            intentId: intent.intentId,
            surface: record.surface,
            phase: record.phase,
            ...(record.receipt === undefined
              ? {}
              : {
                  releasedAt: record.receipt.releasedAt,
                  receipt: record.receipt.receipt,
                }),
          }),
      });
      if (result.disposition !== "released")
        throw new Error("karaoke_release_operation_unresolved");
      if (!(await observeSurfaces()).every((surface) => surface === "restored"))
        throw new Error("karaoke_release_operation_unresolved");
      return { releasedAt: result.releasedAt, allSixRetired: await allSixRetired() };
    },
    async reconcileReleasedFence(intent: {
      readonly planDigest: string;
      readonly intentId: string;
      readonly recordedAt?: string;
    }): Promise<unknown> {
      if (intent.planDigest !== planDigest) throw new Error("karaoke_release_plan_changed");
      const observations = await observeSurfaces();
      if (observations.some((observation) => observation === "uncertain"))
        return { disposition: "unresolved" };
      // Retained, signed release receipts inside this intent's window are the
      // only positive execution evidence. Current state alone never proves
      // not-executed: a partial release followed by re-fencing is identical.
      if (
        input.evidence
          .list(intent.intentId)
          .some((record) => record.planDigest !== undefined && record.planDigest !== planDigest)
      )
        throw new Error("karaoke_release_plan_changed");
      const receipts = input.evidence
        .list(intent.intentId)
        .filter(
          (record) =>
            record.phase === "released" &&
            record.releasedAt !== undefined &&
            record.planDigest === planDigest &&
            (intent.recordedAt === undefined || record.releasedAt >= intent.recordedAt),
        )
        .sort((left, right) => (left.releasedAt ?? "").localeCompare(right.releasedAt ?? ""));
      if (observations.every((observation) => observation === "fenced")) {
        // Absence of receipts is NOT proof of non-execution: a mutation may
        // have succeeded while its receipt persistence failed, with the
        // surface later re-fenced. Only a durable pre-execution cancellation,
        // recorded before any attempt could start and bound to this plan,
        // positively establishes execution never began.
        const cancelled = input.evidence
          .list(intent.intentId)
          .some(
            (record) =>
              record.phase === "cancelled" &&
              record.planDigest === planDigest &&
              (intent.recordedAt === undefined ||
                record.recordedAt === undefined ||
                record.recordedAt >= intent.recordedAt),
          );
        return receipts.length > 0 || !cancelled
          ? { disposition: "unresolved" }
          : { disposition: "not-executed" };
      }
      // Some surface restored: every surface independently observed restored
      // plus one authenticated receipt per surface; missing or contradictory
      // evidence stays unresolved, and the time is the last receipt's
      // confirmation time — never an observation-time substitute.
      if (!observations.every((observation) => observation === "restored"))
        return { disposition: "unresolved" };
      const receiptSurfaces = new Set(receipts.map((receipt) => receipt.surface));
      if (receipts.length < 3 || receiptSurfaces.size < 3) return { disposition: "unresolved" };
      const releasedAt = receipts.at(-1)?.releasedAt;
      if (releasedAt === undefined) return { disposition: "unresolved" };
      return {
        disposition: "released",
        release: { releasedAt, allSixRetired: await allSixRetired() },
      };
    },
  };
}

/** Convenience composition: the origin with the binding's ports. */
export function recordKaraokeFenceReleaseThroughBinding(input: {
  readonly releasePlanDigest: string;
  readonly trust: KaraokeAdapterTrust;
  readonly journal: KaraokeJournalTrust;
  readonly privateKeyPem: string;
  readonly assertion: string;
  readonly challenge: KaraokeCollectorChallenge;
  readonly readers: KaraokeSigningReaders;
  readonly binding: ReturnType<typeof makeKaraokeReleaseBinding>;
  readonly now?: () => string;
}) {
  return recordKaraokeFenceRelease({
    ...input,
    verifyFenceRelease: input.binding.verifyFenceRelease,
    reconcileReleasedFence: input.binding.reconcileReleasedFence,
  });
}
