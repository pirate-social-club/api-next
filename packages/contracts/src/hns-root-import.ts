import { parseCanonicalRouteLabelV1 } from "@pirate/route-label-codec";
import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { endpoint } from "./endpoint.ts";
import {
  AuthError,
  BadRequest,
  Conflict,
  InternalError,
  NotFound,
  ProviderMisconfigured,
  ProviderUnavailable,
  RetryableConflict,
} from "./errors.ts";

const encoder = new TextEncoder();

function utf8Length(value: string): number {
  return encoder.encode(value).byteLength;
}

function controlFree(value: string): boolean {
  return [...value].every((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point >= 0x20 && !(point >= 0x7f && point <= 0x9f);
  });
}

const OpaqueId = Schema.NonEmptyString.check(
  Schema.makeFilter((value) =>
    value.trim() === value && controlFree(value) && utf8Length(value) <= 256
      ? undefined
      : "Expected a bounded canonical opaque id",
  ),
);

const PositiveSafeInteger = Schema.Int.check(
  Schema.makeFilter((value) =>
    Number.isSafeInteger(value) && value > 0 ? undefined : "Expected a positive safe integer",
  ),
);

const RetryAfterSeconds = PositiveSafeInteger.check(
  Schema.makeFilter((value) =>
    value <= 3_600 ? undefined : "Expected retry_after_seconds no greater than 3600",
  ),
);

const Sha256Hex = Schema.String.check(
  Schema.makeFilter((value) =>
    /^[0-9a-f]{64}$/u.test(value) ? undefined : "Expected lowercase SHA-256 hexadecimal",
  ),
);

function canonicalCompactHnsSignature(value: string): boolean {
  try {
    const decoded = atob(value);
    return decoded.length === 64 && btoa(decoded) === value;
  } catch {
    return false;
  }
}

const HnsNameSignature = Schema.NonEmptyString.check(
  Schema.makeFilter((value) =>
    value.trim() === value &&
    controlFree(value) &&
    utf8Length(value) <= 512 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value) &&
    canonicalCompactHnsSignature(value)
      ? undefined
      : "Expected a canonical compact HNS name signature",
  ),
);

const HnsNameProofMessage = Schema.NonEmptyString.check(
  Schema.makeFilter((value) =>
    controlFree(value) && utf8Length(value) <= 2_048
      ? undefined
      : "Expected a bounded HNS name-proof message",
  ),
);

const CanonicalIsoInstant = Schema.String.check(
  Schema.makeFilter((value) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
      ? undefined
      : "Expected a canonical UTC ISO instant";
  }),
);

const RootLabel = Schema.NonEmptyString.check(
  Schema.makeFilter((value) =>
    parseCanonicalRouteLabelV1("hns", value).kind === "accepted"
      ? undefined
      : "Expected a canonical HNS root label",
  ),
);

const HnsResourceRecordV1 = Schema.Record(Schema.String, Schema.Json).check(
  Schema.makeFilter((record) => {
    const type = record.type;
    return typeof type === "string" &&
      /^[A-Z][A-Z0-9]{0,31}$/u.test(type) &&
      utf8Length(JSON.stringify(record)) <= 65_536
      ? undefined
      : "Expected a bounded HNS resource record with a canonical type";
  }),
);

const HnsRootImportPublishPlanV1 = Schema.Struct({
  version: Schema.Literal("pirate-hns-root-import-publish-plan-v1"),
  replacement_semantics: Schema.Literal("complete_resource"),
  current_records: Schema.Array(HnsResourceRecordV1),
  preserved_records: Schema.Array(HnsResourceRecordV1),
  removed_conflicts: Schema.Array(HnsResourceRecordV1),
  added_records: Schema.Array(HnsResourceRecordV1),
  replacement_records: Schema.Array(HnsResourceRecordV1),
  preserved_unknown_record_types: Schema.Array(Schema.String),
  acknowledgement_required: Schema.Literal(true),
});
export type HnsRootImportPublishPlanV1 = Schema.Schema.Type<typeof HnsRootImportPublishPlanV1>;

const HnsRootImportStartRequestV1 = Schema.Struct({
  ceremony_intent_id: OpaqueId,
  expected_revision: PositiveSafeInteger,
  idempotency_key: OpaqueId,
});
export type HnsRootImportStartRequestV1 = Schema.Schema.Type<typeof HnsRootImportStartRequestV1>;

const HnsRootImportPollRequestV1 = Schema.Struct({
  expected_revision: PositiveSafeInteger,
  idempotency_key: OpaqueId,
  provisioning_name_signature: Schema.optional(HnsNameSignature),
});
export type HnsRootImportPollRequestV1 = Schema.Schema.Type<typeof HnsRootImportPollRequestV1>;

const HnsRootImportActivateRequestV1 = Schema.Struct({
  expected_revision: PositiveSafeInteger,
  idempotency_key: OpaqueId,
  publish_plan_sha256: Sha256Hex,
  readiness_result_sha256: Sha256Hex,
  acknowledged_complete_resource_replacement: Schema.Literal(true),
});
export type HnsRootImportActivateRequestV1 = Schema.Schema.Type<
  typeof HnsRootImportActivateRequestV1
>;

const HnsRootImportSessionPath = Schema.Struct({
  intentId: OpaqueId,
  sessionId: OpaqueId,
});

const HnsCommunityRootImportSessionPath = Schema.Struct({
  communityId: OpaqueId,
  sessionId: OpaqueId,
});

const HnsRootImportSessionBaseV1 = {
  creation_intent_id: OpaqueId,
  ceremony_intent_id: OpaqueId,
  root_import_session_id: OpaqueId,
  namespace_session_id: OpaqueId,
  root_label: RootLabel,
  revision: PositiveSafeInteger,
  expires_at: CanonicalIsoInstant,
  replayed: Schema.Boolean,
} as const;

const HnsRootImportAwaitingOwnershipResponseV1 = Schema.Struct({
  ...HnsRootImportSessionBaseV1,
  status: Schema.Literal("awaiting_ownership"),
  ownership_challenge: Schema.Struct({
    ownership_source: Schema.Literal("hns_parent_chain_txt"),
    record: Schema.Struct({
      type: Schema.Literal("TXT"),
      txt: Schema.Tuple([Schema.NonEmptyString]),
    }),
  }),
  provisioning_authorization: Schema.Struct({
    kind: Schema.Literal("hns_name_signature_v1"),
    wallet_rpc_method: Schema.Literal("signmessagewithname"),
    message: HnsNameProofMessage,
    expires_at: CanonicalIsoInstant,
  }),
  publish_plan: Schema.Null,
  publish_plan_sha256: Schema.Null,
  readiness_result_sha256: Schema.Null,
  retry_after_seconds: RetryAfterSeconds,
});

const HnsRootImportProvisioningResponseV1 = Schema.Struct({
  ...HnsRootImportSessionBaseV1,
  status: Schema.Literal("provisioning"),
  publish_plan: Schema.Null,
  publish_plan_sha256: Schema.Null,
  readiness_result_sha256: Schema.Null,
  retry_after_seconds: RetryAfterSeconds,
});

const HnsRootImportAwaitingOwnerResponseV1 = Schema.Struct({
  ...HnsRootImportSessionBaseV1,
  status: Schema.Literals(["awaiting_owner_update", "observing"]),
  publish_plan: HnsRootImportPublishPlanV1,
  publish_plan_sha256: Sha256Hex,
  readiness_result_sha256: Schema.Null,
  retry_after_seconds: RetryAfterSeconds,
});

const HnsRootImportReadyResponseV1 = Schema.Struct({
  ...HnsRootImportSessionBaseV1,
  status: Schema.Literal("ready"),
  publish_plan: HnsRootImportPublishPlanV1,
  publish_plan_sha256: Sha256Hex,
  readiness_result_sha256: Sha256Hex,
  retry_after_seconds: Schema.Null,
});

const HnsRootImportTerminalResponseV1 = Schema.Struct({
  ...HnsRootImportSessionBaseV1,
  status: Schema.Literals(["activated", "failed", "expired"]),
  publish_plan: Schema.NullOr(HnsRootImportPublishPlanV1),
  publish_plan_sha256: Schema.NullOr(Sha256Hex),
  readiness_result_sha256: Schema.NullOr(Sha256Hex),
  retry_after_seconds: Schema.Null,
});

export const HnsRootImportSessionResponseV1 = Schema.Union([
  HnsRootImportAwaitingOwnershipResponseV1,
  HnsRootImportProvisioningResponseV1,
  HnsRootImportAwaitingOwnerResponseV1,
  HnsRootImportReadyResponseV1,
  HnsRootImportTerminalResponseV1,
]);
export type HnsRootImportSessionResponseV1 = Schema.Schema.Type<
  typeof HnsRootImportSessionResponseV1
>;

const HnsRootImportActivationResponseV1 = Schema.Struct({
  creation_intent_id: OpaqueId,
  root_import_session_id: OpaqueId,
  root_label: RootLabel,
  revision: PositiveSafeInteger,
  status: Schema.Literal("activated"),
  community_id: OpaqueId,
  app_host: Schema.NonEmptyString,
  dns_zone_activation_id: OpaqueId,
  dns_zone_activation_generation: Schema.Literal(1),
  app_host_activation_id: OpaqueId,
  app_host_activation_generation: Schema.Literal(1),
  sale_namespace_activation_id: OpaqueId,
  sale_namespace_activation_generation: Schema.Literal(1),
  sale_namespace_activation_sha256: Sha256Hex,
  handle_issuance_enabled: Schema.Literal(true),
  replayed: Schema.Boolean,
});
export type HnsRootImportActivationResponseV1 = Schema.Schema.Type<
  typeof HnsRootImportActivationResponseV1
>;

const HnsCommunityRootImportStartRequestV1 = Schema.Struct({
  root_label: RootLabel,
  idempotency_key: OpaqueId,
});
export type HnsCommunityRootImportStartRequestV1 = Schema.Schema.Type<
  typeof HnsCommunityRootImportStartRequestV1
>;

const HnsCommunityRootImportSessionBaseV1 = {
  community_id: OpaqueId,
  attachment_intent_id: OpaqueId,
  root_import_session_id: OpaqueId,
  root_label: RootLabel,
  revision: PositiveSafeInteger,
  expires_at: CanonicalIsoInstant,
  replayed: Schema.Boolean,
} as const;

const HnsCommunityRootImportAwaitingOwnershipResponseV1 = Schema.Struct({
  ...HnsCommunityRootImportSessionBaseV1,
  status: Schema.Literal("awaiting_ownership"),
  provisioning_authorization: Schema.Struct({
    kind: Schema.Literal("hns_name_signature_v1"),
    wallet_rpc_method: Schema.Literal("signmessagewithname"),
    message: HnsNameProofMessage,
    expires_at: CanonicalIsoInstant,
  }),
  publish_plan: Schema.Null,
  publish_plan_sha256: Schema.Null,
  readiness_result_sha256: Schema.Null,
  retry_after_seconds: RetryAfterSeconds,
});

const HnsCommunityRootImportProvisioningResponseV1 = Schema.Struct({
  ...HnsCommunityRootImportSessionBaseV1,
  status: Schema.Literal("provisioning"),
  publish_plan: Schema.Null,
  publish_plan_sha256: Schema.Null,
  readiness_result_sha256: Schema.Null,
  retry_after_seconds: RetryAfterSeconds,
});

const HnsCommunityRootImportAwaitingOwnerResponseV1 = Schema.Struct({
  ...HnsCommunityRootImportSessionBaseV1,
  status: Schema.Literals(["awaiting_owner_update", "observing"]),
  publish_plan: HnsRootImportPublishPlanV1,
  publish_plan_sha256: Sha256Hex,
  readiness_result_sha256: Schema.Null,
  retry_after_seconds: RetryAfterSeconds,
});

const HnsCommunityRootImportReadyResponseV1 = Schema.Struct({
  ...HnsCommunityRootImportSessionBaseV1,
  status: Schema.Literal("ready"),
  publish_plan: HnsRootImportPublishPlanV1,
  publish_plan_sha256: Sha256Hex,
  readiness_result_sha256: Sha256Hex,
  retry_after_seconds: Schema.Null,
});

const HnsCommunityRootImportTerminalResponseV1 = Schema.Struct({
  ...HnsCommunityRootImportSessionBaseV1,
  status: Schema.Literals(["activated", "failed", "expired"]),
  publish_plan: Schema.NullOr(HnsRootImportPublishPlanV1),
  publish_plan_sha256: Schema.NullOr(Sha256Hex),
  readiness_result_sha256: Schema.NullOr(Sha256Hex),
  retry_after_seconds: Schema.Null,
});

export const HnsCommunityRootImportSessionResponseV1 = Schema.Union([
  HnsCommunityRootImportAwaitingOwnershipResponseV1,
  HnsCommunityRootImportProvisioningResponseV1,
  HnsCommunityRootImportAwaitingOwnerResponseV1,
  HnsCommunityRootImportReadyResponseV1,
  HnsCommunityRootImportTerminalResponseV1,
]);
export type HnsCommunityRootImportSessionResponseV1 = Schema.Schema.Type<
  typeof HnsCommunityRootImportSessionResponseV1
>;

const HnsCommunityRootImportActivationResponseV1 = Schema.Struct({
  community_id: OpaqueId,
  attachment_intent_id: OpaqueId,
  root_import_session_id: OpaqueId,
  root_label: RootLabel,
  revision: PositiveSafeInteger,
  status: Schema.Literal("activated"),
  app_host: Schema.NonEmptyString,
  dns_zone_activation_id: OpaqueId,
  dns_zone_activation_generation: Schema.Literal(1),
  app_host_activation_id: OpaqueId,
  app_host_activation_generation: Schema.Literal(1),
  sale_namespace_activation_id: OpaqueId,
  sale_namespace_activation_generation: Schema.Literal(1),
  sale_namespace_activation_sha256: Sha256Hex,
  handle_issuance_enabled: Schema.Literal(true),
  replayed: Schema.Boolean,
});
export type HnsCommunityRootImportActivationResponseV1 = Schema.Schema.Type<
  typeof HnsCommunityRootImportActivationResponseV1
>;

const rootImportErrors = [
  AuthError,
  BadRequest,
  Conflict,
  RetryableConflict,
  NotFound,
  ProviderUnavailable,
  ProviderMisconfigured,
  InternalError,
] as const;

export const StartHnsRootImport = endpoint({
  method: "POST",
  path: "/community-creation-intents/:intentId/hns-root-imports",
  auth: Auth.userOrAdmin(),
  request: {
    path: Schema.Struct({ intentId: OpaqueId }),
    exactRawPathParameters: ["intentId"],
    body: HnsRootImportStartRequestV1,
    bodyEncoding: "exact-json",
    maxBodyBytes: 2_048,
  },
  response: HnsRootImportSessionResponseV1,
  successStatus: [200, 202],
  errors: rootImportErrors,
});

export const GetHnsRootImport = endpoint({
  method: "GET",
  path: "/community-creation-intents/:intentId/hns-root-imports/:sessionId",
  auth: Auth.userOrAdmin(),
  request: {
    path: HnsRootImportSessionPath,
    exactRawPathParameters: ["intentId", "sessionId"],
  },
  response: HnsRootImportSessionResponseV1,
  successStatus: 200,
  errors: rootImportErrors,
});

export const PollHnsRootImport = endpoint({
  method: "POST",
  path: "/community-creation-intents/:intentId/hns-root-imports/:sessionId/poll",
  auth: Auth.userOrAdmin(),
  request: {
    path: HnsRootImportSessionPath,
    exactRawPathParameters: ["intentId", "sessionId"],
    body: HnsRootImportPollRequestV1,
    bodyEncoding: "json",
    maxBodyBytes: 2_048,
  },
  response: HnsRootImportSessionResponseV1,
  successStatus: [200, 202, 422],
  errors: rootImportErrors,
});

export const ActivateHnsRootImport = endpoint({
  method: "POST",
  path: "/community-creation-intents/:intentId/hns-root-imports/:sessionId/activate",
  auth: Auth.userOrAdmin(),
  request: {
    path: HnsRootImportSessionPath,
    exactRawPathParameters: ["intentId", "sessionId"],
    body: HnsRootImportActivateRequestV1,
    bodyEncoding: "exact-json",
    maxBodyBytes: 4_096,
  },
  response: HnsRootImportActivationResponseV1,
  successStatus: [200, 201],
  errors: rootImportErrors,
});

export const StartHnsCommunityRootImport = endpoint({
  method: "POST",
  path: "/communities/:communityId/hns-root-imports",
  auth: Auth.userOrAdmin(),
  request: {
    path: Schema.Struct({ communityId: OpaqueId }),
    exactRawPathParameters: ["communityId"],
    body: HnsCommunityRootImportStartRequestV1,
    bodyEncoding: "exact-json",
    maxBodyBytes: 2_048,
  },
  response: HnsCommunityRootImportSessionResponseV1,
  successStatus: [200, 202],
  errors: rootImportErrors,
});

export const GetHnsCommunityRootImport = endpoint({
  method: "GET",
  path: "/communities/:communityId/hns-root-imports/:sessionId",
  auth: Auth.userOrAdmin(),
  request: {
    path: HnsCommunityRootImportSessionPath,
    exactRawPathParameters: ["communityId", "sessionId"],
  },
  response: HnsCommunityRootImportSessionResponseV1,
  successStatus: 200,
  errors: rootImportErrors,
});

export const PollHnsCommunityRootImport = endpoint({
  method: "POST",
  path: "/communities/:communityId/hns-root-imports/:sessionId/poll",
  auth: Auth.userOrAdmin(),
  request: {
    path: HnsCommunityRootImportSessionPath,
    exactRawPathParameters: ["communityId", "sessionId"],
    body: HnsRootImportPollRequestV1,
    bodyEncoding: "json",
    maxBodyBytes: 2_048,
  },
  response: HnsCommunityRootImportSessionResponseV1,
  successStatus: [200, 202, 422],
  errors: rootImportErrors,
});

export const ActivateHnsCommunityRootImport = endpoint({
  method: "POST",
  path: "/communities/:communityId/hns-root-imports/:sessionId/activate",
  auth: Auth.userOrAdmin(),
  request: {
    path: HnsCommunityRootImportSessionPath,
    exactRawPathParameters: ["communityId", "sessionId"],
    body: HnsRootImportActivateRequestV1,
    bodyEncoding: "exact-json",
    maxBodyBytes: 4_096,
  },
  response: HnsCommunityRootImportActivationResponseV1,
  successStatus: [200, 201],
  errors: rootImportErrors,
});
