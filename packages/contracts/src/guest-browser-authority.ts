import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { type EndpointDefinition, endpoint } from "./endpoint.ts";
import {
  GuestAuthError,
  GuestBadRequest,
  GuestConflict,
  GuestPendingConflict,
  InternalError,
  NotFound,
  RateLimited,
} from "./errors.ts";
import {
  GuestAttachmentIntentIdV1,
  GuestAuthorityV1,
  GuestCleanupAuthorityV1,
  GuestCountV1,
  GuestCredentialIdV1,
  GuestIdentifierV1,
  GuestInstantV1,
  GuestOperationLocatorV1,
  GuestParticipationProjectionV1,
  GuestPositiveIntegerV1,
  GuestProofLocatorHeadersV1,
} from "./guest-participation.ts";

export const guestBrowserErrorsV1 = [
  GuestAuthError,
  GuestBadRequest,
  GuestConflict,
  GuestPendingConflict,
  NotFound,
  RateLimited,
  InternalError,
] as const;
/** Frozen declarations create no guest runtime authority during this checkpoint. */
export function guestInterfaceEndpoint<const E extends EndpointDefinition>(definition: E) {
  return endpoint({
    ...definition,
    implementation: "disabled",
    cacheControl: "private, no-store",
  } as const);
}
/** Source-admitted learning declaration. Managed serving and native readiness
 * remain mandatory at transport; metadata alone creates no runtime authority.
 * Other checkpoints retain guestInterfaceEndpoint's historical disabled default.
 */
export function guestLearningEndpoint<const E extends EndpointDefinition>(
  definition: E,
): E & Readonly<{ implementation?: "disabled"; cacheControl: "private, no-store" }> {
  if (definition.implementation !== undefined)
    throw new Error("Learning declarations must not override implementation metadata");
  return endpoint({ ...definition, cacheControl: "private, no-store" } as const);
}
/** Source-admitted financial declaration. The complete verified financial graph,
 * nonproduction flags and native readiness remain mandatory at transport. This
 * helper never creates a runtime, permission, role grant or configuration value.
 */
export function guestFinancialEndpoint<const E extends EndpointDefinition>(
  definition: E,
): E & Readonly<{ implementation?: "disabled"; cacheControl: "private, no-store" }> {
  if (definition.implementation !== undefined)
    throw new Error("Financial declarations must not override implementation metadata");
  return endpoint({ ...definition, cacheControl: "private, no-store" } as const);
}
const command = { idempotency_key: GuestIdentifierV1 };
const owner = { expected_owner_id: GuestIdentifierV1 };
const selected = { headers: GuestProofLocatorHeadersV1 };
const distinctCredentials = Schema.Array(GuestCredentialIdV1).check(
  Schema.isMaxLength(16),
  Schema.makeFilter((ids) =>
    new Set(ids).size === ids.length ? undefined : "Candidate credentials must be distinct",
  ),
);
const distinctIntents = Schema.Array(GuestAttachmentIntentIdV1).check(
  Schema.isMaxLength(16),
  Schema.makeFilter((ids) =>
    new Set(ids).size === ids.length ? undefined : "Candidate intents must be distinct",
  ),
);
const control = { bodyEncoding: "json", maxBodyBytes: 4_096 } as const;

export const GetGuestAuthorityV1 = guestLearningEndpoint({
  method: "GET",
  path: "/guest/authority",
  auth: Auth.browserParticipation({ authority: "bootstrap", operation: "discover" }),
  request: {
    ...selected,
    query: Schema.Struct({
      expected_owner_id: Schema.optional(GuestIdentifierV1),
      previous_credential_id: Schema.optional(GuestCredentialIdV1),
    }),
  },
  response: GuestAuthorityV1,
  errors: guestBrowserErrorsV1,
});
export const IssueGuestBootstrapV1 = guestLearningEndpoint({
  method: "POST",
  path: "/guest/bootstrap",
  auth: Auth.browserParticipation({ authority: "bootstrap", operation: "issue" }),
  request: { ...selected, ...control, body: Schema.Struct(command) },
  response: GuestAuthorityV1,
  errors: guestBrowserErrorsV1,
});
export const ConfirmGuestBootstrapV1 = guestLearningEndpoint({
  method: "POST",
  path: "/guest/bootstrap/confirm",
  auth: Auth.browserParticipation({ authority: "bootstrap", operation: "confirm" }),
  request: {
    ...selected,
    ...control,
    body: Schema.Struct({ ...owner, credential_id: GuestCredentialIdV1 }),
  },
  response: GuestAuthorityV1,
  errors: guestBrowserErrorsV1,
});
export const RenewGuestAuthorityV1 = guestLearningEndpoint({
  method: "POST",
  path: "/guest/authority/renew",
  auth: Auth.browserParticipation({ authority: "recovery", operation: "renew" }),
  request: { ...selected, ...control, body: Schema.Struct(owner) },
  response: GuestAuthorityV1,
  errors: guestBrowserErrorsV1,
});
export const RotateGuestCredentialV1 = guestLearningEndpoint({
  method: "POST",
  path: "/guest/credentials/rotate",
  auth: Auth.browserParticipation({ authority: "recovery", operation: "rotate" }),
  request: { ...selected, ...control, body: Schema.Struct({ ...owner, ...command }) },
  response: GuestAuthorityV1,
  errors: guestBrowserErrorsV1,
});
export const AcknowledgeGuestCredentialV1 = guestLearningEndpoint({
  method: "POST",
  path: "/guest/credentials/acknowledge",
  auth: Auth.browserParticipation({ authority: "recovery", operation: "acknowledge" }),
  request: {
    ...selected,
    ...control,
    body: Schema.Struct({
      ...owner,
      predecessor_credential_id: GuestCredentialIdV1,
      successor_credential_id: GuestCredentialIdV1,
    }),
  },
  response: GuestAuthorityV1,
  errors: guestBrowserErrorsV1,
});
export const CleanupGuestBrowserProofV1 = guestLearningEndpoint({
  method: "POST",
  path: "/guest/credentials/cleanup",
  auth: Auth.browserParticipation({ authority: "recovery", operation: "cleanup" }),
  request: {
    ...control,
    ...selected,
    body: Schema.Struct({
      selected_credential_id: Schema.NullOr(GuestCredentialIdV1),
      candidate_credential_ids: distinctCredentials,
      candidate_intent_ids: distinctIntents,
    }),
  },
  response: Schema.Struct({
    authority: GuestCleanupAuthorityV1,
    expired_credential_ids: distinctCredentials,
    expired_intent_ids: distinctIntents,
  }),
  errors: guestBrowserErrorsV1,
});
export const ListGuestParticipationsV1 = guestLearningEndpoint({
  method: "GET",
  path: "/guest/participations",
  auth: Auth.browserParticipation({ authority: "recovery", operation: "participations" }),
  request: {
    ...selected,
    query: Schema.Struct({
      cursor: Schema.optional(GuestIdentifierV1),
      limit: Schema.optional(Schema.String.check(Schema.isPattern(/^(?:[1-9]|[1-9][0-9]|100)$/u))),
    }),
  },
  response: Schema.Struct({
    items: Schema.Array(GuestParticipationProjectionV1).check(Schema.isMaxLength(100)),
    next_cursor: Schema.NullOr(GuestIdentifierV1),
  }),
  errors: guestBrowserErrorsV1,
});
export const GuestLearningRetentionV1 = Schema.Struct({
  mode: Schema.Literals(["private_learning", "ephemeral"]),
  effective_at: GuestInstantV1,
});
export type GuestLearningRetentionV1 = Schema.Schema.Type<typeof GuestLearningRetentionV1>;
export const SetGuestLearningRetentionV1 = guestLearningEndpoint({
  method: "PUT",
  path: "/guest/learning-retention",
  auth: Auth.browserParticipation({ authority: "recovery", operation: "retention" }),
  request: {
    ...selected,
    ...control,
    body: Schema.Struct({ ...command, mode: Schema.Literals(["private_learning", "ephemeral"]) }),
  },
  response: GuestLearningRetentionV1,
  errors: guestBrowserErrorsV1,
});
export const GuestLearnerAudioDeletionV1 = Schema.Struct({
  operation: GuestOperationLocatorV1,
  state: Schema.Literals(["pending", "completed"]),
  deleted_count: GuestCountV1,
  remaining_count: GuestCountV1,
  provider_disposition: Schema.Literals([
    "not_stored",
    "deletion_confirmed",
    "pending",
    "unknown",
    "unavailable",
  ]),
});
export type GuestLearnerAudioDeletionV1 = Schema.Schema.Type<typeof GuestLearnerAudioDeletionV1>;
export const DeleteGuestLearnerAudioV1 = guestLearningEndpoint({
  method: "DELETE",
  path: "/guest/learner-audio",
  auth: Auth.browserParticipation({ authority: "recovery", operation: "delete_audio" }),
  request: {
    headers: Schema.Struct({
      ...GuestProofLocatorHeadersV1.fields,
      "idempotency-key": GuestIdentifierV1,
    }),
  },
  response: GuestLearnerAudioDeletionV1,
  successStatus: [200, 202],
  errors: guestBrowserErrorsV1,
});
export const GuestAttachmentBindingV1 = Schema.Struct({
  attachment_id: GuestIdentifierV1,
  owner_id: GuestIdentifierV1,
  account_id: GuestIdentifierV1,
  state: Schema.Literal("bound"),
  bound_at: GuestInstantV1,
});
export type GuestAttachmentBindingV1 = Schema.Schema.Type<typeof GuestAttachmentBindingV1>;
export const GuestAccountConfirmationV1 = Schema.Struct({
  account_id: GuestIdentifierV1,
  display_name: Schema.NullOr(Schema.NonEmptyString.check(Schema.isMaxLength(256))),
});
export const GuestAttachmentIntentV1 = Schema.Struct({
  intent_id: GuestAttachmentIntentIdV1,
  expires_at: GuestInstantV1,
  state: Schema.Literal("awaiting_account"),
});
export type GuestAttachmentIntentV1 = Schema.Schema.Type<typeof GuestAttachmentIntentV1>;
export const GuestAttachmentPreparedV1 = Schema.Struct({
  intent_id: GuestAttachmentIntentIdV1,
  target_revision: GuestPositiveIntegerV1,
  account_confirmation: GuestAccountConfirmationV1,
  state: Schema.Literal("awaiting_confirmation"),
});
export type GuestAttachmentPreparedV1 = Schema.Schema.Type<typeof GuestAttachmentPreparedV1>;
const intentPath = Schema.Struct({ id: GuestAttachmentIntentIdV1 });
export const CreateGuestAttachmentIntentV1 = guestLearningEndpoint({
  method: "POST",
  path: "/guest/attachment-intents",
  auth: Auth.browserParticipation({ authority: "recovery", operation: "create_attachment_intent" }),
  request: { ...selected, ...control, body: Schema.Struct({ ...owner, ...command }) },
  response: GuestAttachmentIntentV1,
  errors: guestBrowserErrorsV1,
});
export const PrepareGuestAttachmentTargetV1 = guestFinancialEndpoint({
  method: "POST",
  path: "/guest/attachment-intents/:id/prepare",
  auth: Auth.browserParticipation({ authority: "attachment", operation: "prepare_target" }),
  request: { ...selected, path: intentPath },
  response: GuestAttachmentPreparedV1,
  errors: guestBrowserErrorsV1,
});
export const ConfirmGuestAttachmentTargetV1 = guestFinancialEndpoint({
  method: "POST",
  path: "/guest/attachment-intents/:id/confirm",
  auth: Auth.browserParticipation({ authority: "attachment", operation: "confirm_target" }),
  request: {
    ...selected,
    ...control,
    path: intentPath,
    body: Schema.Struct({
      target_revision: GuestPositiveIntegerV1,
      expected_account_id: GuestIdentifierV1,
    }),
  },
  response: GuestAttachmentBindingV1,
  errors: guestBrowserErrorsV1,
});
export const GetMySuccessfulGuestAttachmentV1 = guestFinancialEndpoint({
  method: "GET",
  path: "/users/me/guest-attachments/:id",
  auth: Auth.successfulGuestAttachment(),
  request: { path: Schema.Struct({ id: GuestIdentifierV1 }) },
  response: GuestAttachmentBindingV1,
  errors: guestBrowserErrorsV1,
});
