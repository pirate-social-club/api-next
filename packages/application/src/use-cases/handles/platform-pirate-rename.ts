import {
  isPlatformPirateLabelV1,
  isReservedPlatformPirateLabelV1,
  type PlatformPirateLabelPolicyV1,
  platformPirateConfusabilityKeyV1,
  platformPirateLabelPolicyV1,
  platformPirateRenameRequestV1Hash,
} from "@pirate/domain";
import { Data, Effect } from "effect";
import type { ControlPlaneError } from "../../ports.ts";

export type PlatformPiratePublicPersonaV1 = Readonly<{
  persona_id: string;
  object: "persona";
  display_name: string | null;
  avatar_ref: string | null;
  primary_public_handle: string | null;
}>;

export type PlatformPirateHandleProjectionV1 = Readonly<{
  platform_handle_id: string;
  owner_persona: PlatformPiratePublicPersonaV1;
  handle_label: string;
  display_identifier: string;
  generation: number;
  state: "active";
  state_hash: string;
  cleanup_rename_available: boolean;
}>;

export type PlatformPirateHandleRedirectProjectionV1 = Readonly<{
  platform_handle_id: string;
  handle_label: string;
  display_identifier: string;
  generation: number;
  state: "redirect";
  redirect_to_label: string;
}>;

export type PlatformPirateAvailabilityStoreOutcome =
  | Readonly<{ kind: "available" }>
  | Readonly<{ kind: "current_label" }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "platform_handle_unavailable" }>
  | Readonly<{ kind: "rate_limited"; retryAfterSeconds: number }>;

export type PlatformPirateRenameStoreOutcome =
  | Readonly<{
      kind: "renamed" | "replayed";
      handle: PlatformPirateHandleProjectionV1;
      previous: PlatformPirateHandleRedirectProjectionV1;
    }>
  | Readonly<{
      kind:
        | "invalid_label"
        | "platform_handle_unavailable"
        | "handle_unavailable"
        | "stale_platform_handle"
        | "cleanup_rename_unavailable"
        | "idempotency_conflict";
    }>
  | Readonly<{ kind: "rate_limited"; retryAfterSeconds: number }>;

export interface PlatformPirateHandleStore {
  readonly checkAvailability: (input: {
    accountId: string;
    personaId: string;
    platformHandleId: string;
    desiredLabel: string;
    confusabilityKey: string;
    desiredLabelValid: boolean;
    policy: PlatformPirateLabelPolicyV1;
  }) => Effect.Effect<PlatformPirateAvailabilityStoreOutcome, ControlPlaneError>;
  readonly rename: (input: {
    accountId: string;
    personaId: string;
    platformHandleId: string;
    expectedStateHash: string;
    desiredLabel: string;
    confusabilityKey: string;
    desiredLabelValid: boolean;
    policy: PlatformPirateLabelPolicyV1;
    idempotencyKey: string;
    requestHash: string;
  }) => Effect.Effect<PlatformPirateRenameStoreOutcome, ControlPlaneError>;
}

export class PlatformPirateRenameRejected extends Data.TaggedError("PlatformPirateRenameRejected")<{
  readonly reason:
    | "invalid_label"
    | "platform_handle_unavailable"
    | "handle_unavailable"
    | "stale_platform_handle"
    | "cleanup_rename_unavailable"
    | "idempotency_conflict";
}> {}

export class PlatformPirateRenameRateLimited extends Data.TaggedError(
  "PlatformPirateRenameRateLimited",
)<{ readonly retryAfterSeconds: number }> {}

export type PlatformPirateRenameFailure =
  | PlatformPirateRenameRejected
  | PlatformPirateRenameRateLimited
  | ControlPlaneError;

const conflict = (reason: PlatformPirateRenameRejected["reason"]): PlatformPirateRenameRejected =>
  new PlatformPirateRenameRejected({ reason });

export function makePlatformPirateHandleService(store: PlatformPirateHandleStore) {
  const policy = platformPirateLabelPolicyV1();

  const checkAvailability = Effect.fn("PlatformPirateHandle.checkAvailability")(function* (input: {
    accountId: string;
    personaId: string;
    platformHandleId: string;
    desiredLabel: string;
  }) {
    const desiredLabelValid = isPlatformPirateLabelV1(input.desiredLabel);
    const outcome = yield* store.checkAvailability({
      ...input,
      confusabilityKey: platformPirateConfusabilityKeyV1(input.desiredLabel),
      desiredLabelValid,
      policy,
    });
    if (outcome.kind === "rate_limited") {
      return yield* Effect.fail(
        new PlatformPirateRenameRateLimited({ retryAfterSeconds: outcome.retryAfterSeconds }),
      );
    }
    if (outcome.kind === "platform_handle_unavailable") {
      return yield* Effect.fail(conflict("platform_handle_unavailable"));
    }
    if (!desiredLabelValid) {
      return { kind: "unavailable", reason: "invalid_label" } as const;
    }
    if (outcome.kind === "current_label") {
      return { kind: "unavailable", reason: "current_label" } as const;
    }
    if (outcome.kind === "unavailable" || isReservedPlatformPirateLabelV1(input.desiredLabel)) {
      return { kind: "unavailable", reason: "unavailable" } as const;
    }
    return {
      kind: "available",
      desired_label: input.desiredLabel,
      display_identifier: `${input.desiredLabel}.pirate`,
      policy,
    } as const;
  });

  const rename = Effect.fn("PlatformPirateHandle.rename")(function* (input: {
    accountId: string;
    personaId: string;
    platformHandleId: string;
    expectedStateHash: string;
    desiredLabel: string;
    idempotencyKey: string;
  }) {
    const desiredLabelValid = isPlatformPirateLabelV1(input.desiredLabel);
    const requestHash = platformPirateRenameRequestV1Hash({
      actor_account_id: input.accountId,
      persona_id: input.personaId,
      platform_handle_id: input.platformHandleId,
      expected_state_hash: input.expectedStateHash,
      desired_label: input.desiredLabel,
      label_policy_hash: policy.label_policy_hash,
      idempotency_key: input.idempotencyKey,
    }).sha256;
    const outcome = yield* store.rename({
      ...input,
      confusabilityKey: platformPirateConfusabilityKeyV1(input.desiredLabel),
      desiredLabelValid,
      policy,
      requestHash,
    });
    if (outcome.kind === "rate_limited") {
      return yield* Effect.fail(
        new PlatformPirateRenameRateLimited({ retryAfterSeconds: outcome.retryAfterSeconds }),
      );
    }
    if (outcome.kind !== "renamed" && outcome.kind !== "replayed") {
      return yield* Effect.fail(conflict(outcome.kind));
    }
    return {
      handle: outcome.handle,
      previous: outcome.previous,
      replayed: outcome.kind === "replayed",
    };
  });

  return { checkAvailability, rename } as const;
}
