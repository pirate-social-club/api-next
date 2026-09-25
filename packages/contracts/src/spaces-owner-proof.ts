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

const CeremonyId = Schema.String.check(
  Schema.makeFilter((value) =>
    /^sowner_[0-9a-f]{32}$/u.test(value) ? undefined : "Invalid ceremony id",
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

export const SpacesOwnershipStartRequestV1 = Schema.Struct({
  idempotency_key: IdempotencyKey,
  canonical_root: SpacesCanonicalRootV1,
});

const Challenge = Schema.Struct({
  contract: Schema.Literal("pirate-spaces-ownership-start-v1"),
  ceremony_id: CeremonyId,
  generation: PositiveInteger,
  network: Schema.Literal("mainnet"),
  canonical_root: SpacesCanonicalRootV1,
  root_outpoint: Outpoint,
  root_key_hex: Sha256Hex,
  challenge_message: Schema.String,
  challenge_digest_hex: Sha256Hex,
  expires_at: Schema.String,
  replayed: Schema.Boolean,
});

const StartPending = Schema.Struct({
  contract: Schema.Literal("pirate-spaces-ownership-start-v1"),
  status: Schema.Literal("verification_pending"),
  retry_after_seconds: PositiveInteger,
});

export const SpacesOwnershipStartResponseV1 = Schema.Union([Challenge, StartPending]);

export const SpacesOwnershipPollRequestV1 = Schema.Struct({
  ceremony_id: CeremonyId,
  idempotency_key: IdempotencyKey,
  signature_hex: SignatureHex,
});

const ResultBase = {
  contract: Schema.Literal("pirate-spaces-ownership-result-v1"),
  ceremony_id: CeremonyId,
  generation: PositiveInteger,
};

const Verified = Schema.Struct({
  ...ResultBase,
  status: Schema.Literal("verified"),
  namespace_authority_reference: BoundedIdentifier,
  namespace_authority_generation: PositiveInteger,
  evidence_digest_hex: Sha256Hex,
  observed_at: Schema.String,
  fresh_until: Schema.String,
  replayed: Schema.Boolean,
});

const PollPending = Schema.Struct({
  ...ResultBase,
  status: Schema.Literal("verification_pending"),
  retry_after_seconds: PositiveInteger,
  replayed: Schema.Literal(false),
});

const Rejected = Schema.Struct({
  ...ResultBase,
  status: Schema.Literals(["expired", "root_changed", "signature_rejected"]),
  replayed: Schema.Boolean,
});

export const SpacesOwnershipPollResponseV1 = Schema.Union([Verified, PollPending, Rejected]);

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

export const StartSpacesOwnership = endpoint({
  method: "POST",
  path: "/communities/:communityId/spaces-ownership/start",
  auth: Auth.userOrAdmin({ browserSessionOnly: true }),
  request: {
    path: CommunityPath,
    exactRawPathParameters: ["communityId"],
    body: SpacesOwnershipStartRequestV1,
    bodyEncoding: "exact-json",
    maxBodyBytes: 2_048,
  },
  response: SpacesOwnershipStartResponseV1,
  successStatus: [200, 201, 202],
  errors,
});

export const PollSpacesOwnership = endpoint({
  method: "POST",
  path: "/communities/:communityId/spaces-ownership/poll",
  auth: Auth.userOrAdmin({ browserSessionOnly: true }),
  request: {
    path: CommunityPath,
    exactRawPathParameters: ["communityId"],
    body: SpacesOwnershipPollRequestV1,
    bodyEncoding: "exact-json",
    maxBodyBytes: 4_096,
  },
  response: SpacesOwnershipPollResponseV1,
  successStatus: [200, 202],
  errors,
});

/** Private application refusal; transport maps it to the public error wire. */
export class SpacesOwnerProofRefused extends Error {
  constructor(
    readonly reason: "invalid" | "forbidden" | "conflict" | "not_found" | "pending" | "unavailable",
  ) {
    super(`Spaces owner proof ${reason}`);
  }
}
