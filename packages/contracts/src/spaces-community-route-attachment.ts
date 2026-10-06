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
  VerificationRequired,
} from "./errors.ts";
import {
  BoundedIdentifier,
  IdempotencyKey,
  PositiveInteger,
  Sha256Hex,
} from "./handle-sales-scalars.ts";
import { SpacesCanonicalRootV1 } from "./handle-sales-spaces.ts";

/**
 * Attaching an already-owned Spaces root as a community address. The owner
 * signs one route-only message; nothing is moved, delegated or published.
 */
const AttachmentIntentId = Schema.String.check(
  Schema.makeFilter((value) =>
    /^sroute_[0-9a-f]{32}$/u.test(value) ? undefined : "Invalid attachment intent id",
  ),
);
const CeremonyIntentId = Schema.String.check(
  Schema.makeFilter((value) =>
    /^srcer_[0-9a-f]{32}$/u.test(value) ? undefined : "Invalid ceremony intent id",
  ),
);
const SignatureHex = Schema.String.check(
  Schema.makeFilter((value) => (/^[0-9a-f]{128}$/u.test(value) ? undefined : "Invalid signature")),
);
const Outpoint = Schema.String.check(
  Schema.makeFilter((value) =>
    /^[0-9a-f]{64}:(0|[1-9][0-9]{0,9})$/u.test(value) ? undefined : "Invalid outpoint",
  ),
);
const CONTRACT = Schema.Literal("pirate-spaces-community-route-attachment-v1");

export const SpacesRouteAttachmentStartRequestV1 = Schema.Struct({
  idempotency_key: IdempotencyKey,
  canonical_root: SpacesCanonicalRootV1,
});

export const SpacesRouteAttachmentProveRequestV1 = Schema.Struct({
  signature_hex: SignatureHex,
});

/** The generation the client reviewed; a successor generation refuses the commit. */
export const SpacesRouteAttachmentCommitRequestV1 = Schema.Struct({
  generation: PositiveInteger,
});

const State = Schema.Struct({
  contract: CONTRACT,
  attachment_intent_id: AttachmentIntentId,
  ceremony_intent_id: CeremonyIntentId,
  generation: PositiveInteger,
  community_id: BoundedIdentifier,
  network: Schema.Literal("mainnet"),
  canonical_root: SpacesCanonicalRootV1,
  status: Schema.Literals([
    "awaiting_signature",
    "proved",
    "committed",
    "expired",
    "root_changed",
    "signature_rejected",
  ]),
  root_outpoint: Outpoint,
  owner_public_key_hex: Sha256Hex,
  public_origin: Schema.String,
  canonical_href: Schema.String,
  /** Sign exactly these UTF-8 bytes with the Spaces signed-message convention. */
  challenge_message: Schema.String,
  challenge_digest_hex: Sha256Hex,
  expires_at: Schema.String,
  route_binding_id: Schema.NullOr(BoundedIdentifier),
  /** Present once committed: when the current ownership lease runs out. */
  route_expires_at: Schema.optional(Schema.String),
  replayed: Schema.Boolean,
});

const Pending = Schema.Struct({
  contract: CONTRACT,
  status: Schema.Literal("verification_pending"),
  retry_after_seconds: PositiveInteger,
});

export const SpacesRouteAttachmentResponseV1 = Schema.Union([State, Pending]);

const errors = [
  AuthError,
  BadRequest,
  Conflict,
  NotFound,
  ProviderUnavailable,
  VerificationRequired,
  InternalError,
] as const;
const CommunityPath = Schema.Struct({ communityId: BoundedIdentifier });
const AttachmentPath = Schema.Struct({
  communityId: BoundedIdentifier,
  attachmentIntentId: AttachmentIntentId,
});
const auth = Auth.userOrAdmin({ browserSessionOnly: true });

export const StartSpacesRouteAttachment = endpoint({
  method: "POST",
  path: "/communities/:communityId/spaces-route-attachments",
  auth,
  request: {
    path: CommunityPath,
    exactRawPathParameters: ["communityId"],
    body: SpacesRouteAttachmentStartRequestV1,
    bodyEncoding: "exact-json",
    maxBodyBytes: 2_048,
  },
  response: SpacesRouteAttachmentResponseV1,
  successStatus: [200, 201, 202],
  errors,
});

export const GetCurrentSpacesRouteAttachment = endpoint({
  method: "GET",
  path: "/communities/:communityId/spaces-route-attachments/current",
  auth,
  request: { path: CommunityPath, exactRawPathParameters: ["communityId"] },
  response: SpacesRouteAttachmentResponseV1,
  errors,
});

export const ProveSpacesRouteAttachment = endpoint({
  method: "POST",
  path: "/communities/:communityId/spaces-route-attachments/:attachmentIntentId/prove",
  auth,
  request: {
    path: AttachmentPath,
    exactRawPathParameters: ["communityId", "attachmentIntentId"],
    body: SpacesRouteAttachmentProveRequestV1,
    bodyEncoding: "exact-json",
    maxBodyBytes: 2_048,
  },
  response: SpacesRouteAttachmentResponseV1,
  successStatus: [200, 202],
  errors,
});

export const CommitSpacesRouteAttachment = endpoint({
  method: "POST",
  path: "/communities/:communityId/spaces-route-attachments/:attachmentIntentId/commit",
  auth,
  request: {
    path: AttachmentPath,
    exactRawPathParameters: ["communityId", "attachmentIntentId"],
    body: SpacesRouteAttachmentCommitRequestV1,
    bodyEncoding: "exact-json",
    maxBodyBytes: 64,
  },
  response: SpacesRouteAttachmentResponseV1,
  errors,
});

/** Private application refusal; transport maps it to the public error wire. */
export class SpacesRouteAttachmentRefused extends Error {
  constructor(readonly reason: "invalid" | "forbidden" | "conflict" | "not_found" | "unavailable") {
    super(`Spaces route attachment ${reason}`);
  }
}
