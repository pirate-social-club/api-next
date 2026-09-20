import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { endpoint } from "./endpoint.ts";
import {
  AuthError,
  BadRequest,
  Conflict,
  InternalError,
  NotFound,
  ProviderUnavailable,
  RateLimited,
} from "./errors.ts";

export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
export const AVATAR_MAX_PIXELS = 16_000_000;
export const AvatarAssetId = Schema.String.check(
  Schema.isPattern(/^avatar-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u),
);
export const AvatarPurpose = Schema.Literals(["community", "persona"]);
export const AvatarContentType = Schema.Literals(["image/jpeg", "image/png", "image/webp"]);
export const AvatarAttachmentOutcome = Schema.Literals([
  "not_requested",
  "attached",
  "omitted_unavailable",
  "preserved_existing",
]);
export const AvatarAttachmentOutcomes = Schema.Struct({
  community: Schema.Literals(["not_requested", "attached", "omitted_unavailable"]),
  persona: AvatarAttachmentOutcome,
});
export const ReserveAvatarUpload = endpoint({
  method: "POST",
  path: "/avatar-upload-reservations",
  auth: Auth.userOrAdmin(),
  request: {
    body: Schema.Struct({
      idempotency_key: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
      purpose: AvatarPurpose,
      content_type: AvatarContentType,
      byte_length: Schema.Int.check(
        Schema.isGreaterThan(0),
        Schema.isLessThanOrEqualTo(AVATAR_MAX_BYTES),
      ),
    }),
  },
  response: Schema.Struct({
    asset_id: AvatarAssetId,
    upload_url: Schema.String,
    required_headers: Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
    expires_at: Schema.String,
  }),
  errors: [AuthError, BadRequest, Conflict, RateLimited, ProviderUnavailable, InternalError],
});
export const FinalizeAvatarUpload = endpoint({
  method: "POST",
  path: "/avatar-upload-reservations/:assetId/finalize",
  auth: Auth.userOrAdmin(),
  request: { path: Schema.Struct({ assetId: AvatarAssetId }) },
  response: Schema.Struct({ asset_id: AvatarAssetId, status: Schema.Literal("ready") }),
  errors: [AuthError, BadRequest, Conflict, NotFound, ProviderUnavailable, InternalError],
});
export const GetAvatar = endpoint({
  method: "GET",
  path: "/avatars/:assetId",
  auth: Auth.public(),
  request: {
    path: Schema.Struct({ assetId: AvatarAssetId }),
    headers: Schema.Struct({ "if-none-match": Schema.optional(Schema.String) }),
  },
  response: Schema.Unknown,
  responseRepresentation: {
    kind: "binary",
    contentType: "image/jpeg",
    cacheControl: "private, no-cache",
    conditional: "authorized-etag",
  },
  successStatus: [200, 304],
  errors: [BadRequest, NotFound, ProviderUnavailable, InternalError],
});
export const RemoveAvatar = endpoint({
  method: "DELETE",
  path: "/avatars/:assetId",
  auth: Auth.admin("avatars:moderate"),
  request: { path: Schema.Struct({ assetId: AvatarAssetId }) },
  response: Schema.Struct({ removed: Schema.Literal(true) }),
  errors: [AuthError, BadRequest, NotFound, InternalError],
});
