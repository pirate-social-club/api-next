import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { endpoint } from "./endpoint.ts";
import {
  AuthError,
  BadRequest,
  CleanupPirateRenameUnavailable,
  InternalError,
  PirateHandleUnavailable,
  PlatformPirateHandleUnavailable,
  PlatformPirateInvalidLabel,
  PlatformPirateRenameIdempotencyConflict,
  RateLimited,
  StalePlatformPirateHandle,
} from "./errors.ts";
import { PersonaIdV1, PublicPersonaV1 } from "./personas.ts";

const BoundedIdentifier = Schema.String.check(
  Schema.makeFilter((value) =>
    value.length > 0 &&
    value.length <= 256 &&
    value === value.trim() &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    })
      ? undefined
      : "Expected a bounded identifier",
  ),
);
const IdempotencyKey = Schema.String.check(
  Schema.makeFilter((value) =>
    value.length > 0 &&
    value.length <= 128 &&
    value === value.trim() &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    })
      ? undefined
      : "Expected a bounded idempotency key",
  ),
);
const Sha256Hex = Schema.String.check(
  Schema.makeFilter((value) =>
    /^[0-9a-f]{64}$/u.test(value) ? undefined : "Expected a lowercase SHA-256 digest",
  ),
);
export const PlatformPirateLabelV1 = Schema.String.check(
  Schema.makeFilter((value) => {
    const bytes = new TextEncoder().encode(value).byteLength;
    return bytes >= 3 &&
      bytes <= 32 &&
      !value.startsWith("xn--") &&
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)
      ? undefined
      : "Expected a canonical platform Pirate label";
  }),
);

const PositiveInteger = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);

export const PlatformPirateLabelPolicyV1 = Schema.Struct({
  label_policy_id: Schema.Literal("pirate_ascii_ldh_3_32_v1"),
  label_policy_revision: Schema.Literal(1),
  label_policy_hash: Sha256Hex,
  reserved_labels_id: Schema.Literal("pirate_platform_reserved_labels_v1"),
  reserved_labels_revision: Schema.Literal(1),
  reserved_labels_hash: Sha256Hex,
  confusability_policy_id: Schema.Literal("pirate_ascii_skeleton_v1"),
  confusability_policy_revision: Schema.Literal(1),
  confusability_policy_hash: Sha256Hex,
});

export const PlatformPirateHandleV1 = Schema.Struct({
  platform_handle_id: BoundedIdentifier,
  owner_persona: PublicPersonaV1,
  handle_label: PlatformPirateLabelV1,
  display_identifier: Schema.String,
  generation: PositiveInteger,
  state: Schema.Literal("active"),
  state_hash: Sha256Hex,
  cleanup_rename_available: Schema.Boolean,
});

export const PlatformPirateHandleRedirectV1 = Schema.Struct({
  platform_handle_id: BoundedIdentifier,
  handle_label: PlatformPirateLabelV1,
  display_identifier: Schema.String,
  generation: PositiveInteger,
  state: Schema.Literal("redirect"),
  redirect_to_label: PlatformPirateLabelV1,
});

const AvailabilityRequestV1 = Schema.Struct({
  persona_id: PersonaIdV1,
  platform_handle_id: BoundedIdentifier,
  desired_label: Schema.String,
});

export const PlatformPirateLabelAvailabilityResultV1 = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("available"),
    desired_label: PlatformPirateLabelV1,
    display_identifier: Schema.String,
    policy: PlatformPirateLabelPolicyV1,
  }),
  Schema.Struct({
    kind: Schema.Literal("unavailable"),
    reason: Schema.Literals(["invalid_label", "current_label", "unavailable"]),
  }),
]);

const RenameRequestV1 = Schema.Struct({
  idempotency_key: IdempotencyKey,
  persona_id: PersonaIdV1,
  platform_handle_id: BoundedIdentifier,
  expected_state_hash: Sha256Hex,
  desired_label: Schema.String,
});

export const RenamePlatformPirateHandleResultV1 = Schema.Struct({
  handle: PlatformPirateHandleV1,
  previous: PlatformPirateHandleRedirectV1,
  replayed: Schema.Boolean,
});

const errors = [
  AuthError,
  BadRequest,
  PlatformPirateInvalidLabel,
  PlatformPirateHandleUnavailable,
  PirateHandleUnavailable,
  StalePlatformPirateHandle,
  CleanupPirateRenameUnavailable,
  PlatformPirateRenameIdempotencyConflict,
  RateLimited,
  InternalError,
] as const;

export const CheckPlatformPirateLabelAvailability = endpoint({
  method: "POST",
  path: "/platform-pirate-handles/availability",
  auth: Auth.userOrAdmin(),
  request: { body: AvailabilityRequestV1 },
  response: PlatformPirateLabelAvailabilityResultV1,
  errors,
});

export const RenamePlatformPirateHandle = endpoint({
  method: "POST",
  path: "/platform-pirate-handles/rename",
  auth: Auth.userOrAdmin(),
  request: { body: RenameRequestV1 },
  response: RenamePlatformPirateHandleResultV1,
  errors,
});

export const platformPirateHandleRegistry = {
  CheckPlatformPirateLabelAvailability,
  RenamePlatformPirateHandle,
} as const;
