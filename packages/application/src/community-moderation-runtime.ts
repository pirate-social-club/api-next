import type {
  CommunityContentReportResponseV1,
  CommunityModerationCapabilitiesV1,
  CommunityModerationCaseDetailV1,
  CommunityModerationCaseListV1,
  CommunityModerationPolicyV1,
  ModerateTextCaseResultV2,
  PutCommunityModerationPolicyV1,
} from "@pirate/contracts";
import {
  BadRequest,
  Conflict,
  IdempotencyConflict,
  InternalError,
  MembershipRequired,
  NotFound,
} from "@pirate/contracts";
import { Context, Data, Effect, type Schema } from "effect";
import type { ControlPlaneError, M2Actor } from "./ports.ts";

export { canonicalBodyHash } from "./use-cases/content/common.ts";

export type CommunityModerationCapabilities = Schema.Schema.Type<
  typeof CommunityModerationCapabilitiesV1
>;
export type CommunityModerationCaseList = Schema.Schema.Type<typeof CommunityModerationCaseListV1>;
export type CommunityModerationCaseDetail = Schema.Schema.Type<
  typeof CommunityModerationCaseDetailV1
>;
export type CommunityModerationPolicy = Schema.Schema.Type<typeof CommunityModerationPolicyV1>;
export type CommunityModerationPolicyUpdate = Schema.Schema.Type<
  typeof PutCommunityModerationPolicyV1
>;
export type CommunityContentReportOutcome = Schema.Schema.Type<
  typeof CommunityContentReportResponseV1
>;
export type ModerateTextCaseOutcome = Schema.Schema.Type<typeof ModerateTextCaseResultV2>;

export type LegacyModerationActionReplay = Readonly<{
  readonly action_id: string;
  readonly case_ref: string;
  readonly action: "approve" | "dismiss" | "hide" | "remove" | "restore";
  readonly target_status: "held" | "published" | "hidden" | "removed";
  readonly responseBytes: Uint8Array;
}>;

export type CommunityModerationStoreOperation =
  | "capabilities"
  | "list"
  | "detail"
  | "policy-read"
  | "policy-update"
  | "report"
  | "legacy-replay"
  | "action";

export type CommunityModerationStoreReason =
  | "not-found"
  | "membership-required"
  | "idempotency-conflict"
  | "conflict"
  | "constraint"
  | "invalid-row";

export class CommunityModerationStoreError extends Data.TaggedError(
  "CommunityModerationStoreError",
)<{
  readonly operation: CommunityModerationStoreOperation;
  readonly reason: CommunityModerationStoreReason;
  readonly resourceId?: string;
}> {}

export type CommunityModerationStoreFailure = CommunityModerationStoreError | ControlPlaneError;

export interface CommunityModerationStoreService {
  readonly getCapabilities: (input: {
    readonly communityId: string;
    readonly actor: M2Actor;
  }) => Effect.Effect<CommunityModerationCapabilities, CommunityModerationStoreFailure>;
  readonly listCases: (input: {
    readonly communityId: string;
    readonly actor: M2Actor;
    readonly view: "open" | "hidden";
  }) => Effect.Effect<CommunityModerationCaseList, CommunityModerationStoreFailure>;
  readonly getCase: (input: {
    readonly communityId: string;
    readonly caseRef: string;
    readonly actor: M2Actor;
  }) => Effect.Effect<CommunityModerationCaseDetail, CommunityModerationStoreFailure>;
  readonly getPolicy: (input: {
    readonly communityId: string;
    readonly actor: M2Actor;
  }) => Effect.Effect<CommunityModerationPolicy, CommunityModerationStoreFailure>;
  readonly updatePolicy: (input: {
    readonly communityId: string;
    readonly actor: M2Actor;
    readonly update: CommunityModerationPolicyUpdate;
  }) => Effect.Effect<CommunityModerationPolicy, CommunityModerationStoreFailure>;
  readonly reportTarget: (input: {
    readonly targetType: "post" | "comment";
    readonly targetId: string;
    readonly actor: M2Actor;
    readonly idempotencyKey: string;
    readonly reasonCode:
      | "spam"
      | "harassment"
      | "hate"
      | "sexual_content"
      | "graphic_content"
      | "misleading"
      | "other";
    readonly requestHash: string;
  }) => Effect.Effect<CommunityContentReportOutcome, CommunityModerationStoreFailure>;
  readonly replayLegacyAction: (input: {
    readonly caseRef: string;
    readonly actor: M2Actor;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  }) => Effect.Effect<LegacyModerationActionReplay | null, CommunityModerationStoreFailure>;
  readonly actOnCase: (input: {
    readonly caseRef: string;
    readonly actor: M2Actor;
    readonly idempotencyKey: string;
    readonly expectedCaseRevision: number;
    readonly action:
      | "approve_as_general"
      | "approve_as_adult_18"
      | "reject"
      | "dismiss_report"
      | "hide"
      | "raise_rating_to_adult_18"
      | "restore";
    readonly requestHash: string;
  }) => Effect.Effect<ModerateTextCaseOutcome, CommunityModerationStoreFailure>;
}

export class CommunityModerationStore extends Context.Service<
  CommunityModerationStore,
  CommunityModerationStoreService
>()("CommunityModerationStore") {}

const mapFailure = (failure: CommunityModerationStoreFailure, fallbackId: string) => {
  if (!(failure instanceof CommunityModerationStoreError)) {
    return new InternalError({ message: "Moderation store operation failed" });
  }
  switch (failure.reason) {
    case "not-found":
      return new NotFound({ message: "Moderation resource not found" });
    case "membership-required":
      return new MembershipRequired({ message: "Community membership is required" });
    case "idempotency-conflict":
      return new IdempotencyConflict({
        message: "The idempotency key was already used with a different request",
        details: {
          reason_code: "idempotency_conflict",
          submission_id: failure.resourceId ?? fallbackId,
        },
      });
    case "conflict":
      return new Conflict({ message: "Moderation operation conflicts with current state" });
    case "constraint":
      return new BadRequest({ message: "Invalid moderation request" });
    case "invalid-row":
      return new InternalError({ message: "Moderation store returned an invalid record" });
  }
};

const map = <A>(effect: Effect.Effect<A, CommunityModerationStoreFailure>, fallbackId: string) =>
  effect.pipe(Effect.mapError((failure) => mapFailure(failure, fallbackId)));

export const getCommunityModerationCapabilities = Effect.fn("getCommunityModerationCapabilities")(
  function* (
    input: { readonly communityId: string; readonly actor: M2Actor },
    services: { readonly moderationStore: CommunityModerationStoreService },
  ) {
    return yield* map(services.moderationStore.getCapabilities(input), input.communityId);
  },
);

export const listCommunityModerationCases = Effect.fn("listCommunityModerationCases")(function* (
  input: {
    readonly communityId: string;
    readonly actor: M2Actor;
    readonly view: "open" | "hidden";
  },
  services: { readonly moderationStore: CommunityModerationStoreService },
) {
  return yield* map(services.moderationStore.listCases(input), input.communityId);
});

export const getCommunityModerationCase = Effect.fn("getCommunityModerationCase")(function* (
  input: { readonly communityId: string; readonly caseRef: string; readonly actor: M2Actor },
  services: { readonly moderationStore: CommunityModerationStoreService },
) {
  return yield* map(services.moderationStore.getCase(input), input.caseRef);
});

export const getCommunityModerationPolicy = Effect.fn("getCommunityModerationPolicy")(function* (
  input: { readonly communityId: string; readonly actor: M2Actor },
  services: { readonly moderationStore: CommunityModerationStoreService },
) {
  return yield* map(services.moderationStore.getPolicy(input), input.communityId);
});

export const updateCommunityModerationPolicy = Effect.fn("updateCommunityModerationPolicy")(
  function* (
    input: {
      readonly communityId: string;
      readonly actor: M2Actor;
      readonly update: CommunityModerationPolicyUpdate;
    },
    services: { readonly moderationStore: CommunityModerationStoreService },
  ) {
    return yield* map(services.moderationStore.updatePolicy(input), input.communityId);
  },
);

export const reportCommunityContent = Effect.fn("reportCommunityContent")(function* (
  input: Parameters<CommunityModerationStoreService["reportTarget"]>[0],
  services: { readonly moderationStore: CommunityModerationStoreService },
) {
  return yield* map(services.moderationStore.reportTarget(input), input.targetId);
});

export const moderateCommunityCase = Effect.fn("moderateCommunityCase")(function* (
  input: Parameters<CommunityModerationStoreService["actOnCase"]>[0],
  services: { readonly moderationStore: CommunityModerationStoreService },
) {
  return yield* map(services.moderationStore.actOnCase(input), input.caseRef);
});

export const replayLegacyCommunityModerationAction = Effect.fn(
  "replayLegacyCommunityModerationAction",
)(function* (
  input: Parameters<CommunityModerationStoreService["replayLegacyAction"]>[0],
  services: { readonly moderationStore: CommunityModerationStoreService },
) {
  return yield* map(services.moderationStore.replayLegacyAction(input), input.caseRef);
});
