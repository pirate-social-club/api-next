import {
  type MegapotCutoffFailure,
  MegapotCutoffRejected,
  type MegapotCutoffResult,
  type MegapotCutoffStore,
} from "@pirate/application";
import { buildMegapotBeneficiarySnapshot } from "@pirate/domain";
import { Effect } from "effect";
import { sha256 } from "viem";

const rejected = (reason: MegapotCutoffRejected["reason"]) => new MegapotCutoffRejected({ reason });

export interface MegapotCutoffCoordinator {
  readonly freezeDue: (input?: {
    readonly limit?: number;
  }) => Effect.Effect<readonly MegapotCutoffResult[], MegapotCutoffFailure>;
}

export function makeMegapotCutoffCoordinator(input: {
  readonly store: MegapotCutoffStore;
  readonly externalSponsorDailyTicketCeiling: number;
  readonly externalSponsorDailySpendCeilingAtomic: bigint;
  readonly sharedSponsorDailyTicketCeiling: number;
  readonly sharedSponsorDailySpendCeilingAtomic: bigint;
  readonly now?: () => number;
}): MegapotCutoffCoordinator {
  const now = input.now ?? Date.now;
  const configValid =
    Number.isSafeInteger(input.externalSponsorDailyTicketCeiling) &&
    input.externalSponsorDailyTicketCeiling > 0 &&
    input.externalSponsorDailySpendCeilingAtomic > 0n &&
    Number.isSafeInteger(input.sharedSponsorDailyTicketCeiling) &&
    input.sharedSponsorDailyTicketCeiling > 0 &&
    input.sharedSponsorDailySpendCeilingAtomic > 0n;

  return {
    freezeDue: Effect.fn("MegapotCutoffCoordinator.freezeDue")(function* (command) {
      if (!configValid) return yield* rejected("invalid-config");
      const limit = command?.limit ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
        return yield* rejected("invalid-config");
      }
      const frozenMilliseconds = now();
      if (!Number.isFinite(frozenMilliseconds)) return yield* rejected("invalid-config");
      const frozenAt = new Date(frozenMilliseconds).toISOString();
      const due = yield* input.store.loadDue({ cutoffAtOrBefore: frozenAt, limit });
      return yield* Effect.forEach(due, (candidate) => {
        if (Date.parse(candidate.entryCutoffAt) > frozenMilliseconds) {
          return Effect.fail(rejected("too-early"));
        }
        const beneficiaries =
          candidate.shares.length > 0
            ? candidate.shares
            : candidate.emptyPoolPolicy === "funder_fallback" &&
                candidate.fallbackBeneficiary !== null
              ? [candidate.fallbackBeneficiary]
              : [];
        const snapshot =
          beneficiaries.length === 0
            ? null
            : buildMegapotBeneficiarySnapshot({
                poolLegId: candidate.poolLegId,
                drawingId: candidate.drawingId,
                termsHash: candidate.termsHash,
                fallback: candidate.shares.length === 0,
                beneficiaries,
                sha256: (bytes) => sha256(bytes, "bytes"),
              });
        if (
          snapshot === null &&
          (candidate.shares.length > 0 || candidate.emptyPoolPolicy === "funder_fallback")
        ) {
          return Effect.fail(rejected("snapshot-required"));
        }
        return input.store.freeze({
          candidate,
          snapshot,
          frozenAt,
          externalSponsorDailyTicketCeiling: input.externalSponsorDailyTicketCeiling,
          externalSponsorDailySpendCeilingAtomic: input.externalSponsorDailySpendCeilingAtomic,
          sharedSponsorDailyTicketCeiling: input.sharedSponsorDailyTicketCeiling,
          sharedSponsorDailySpendCeilingAtomic: input.sharedSponsorDailySpendCeilingAtomic,
        });
      });
    }),
  };
}
