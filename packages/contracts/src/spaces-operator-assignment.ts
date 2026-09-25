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
import { BoundedIdentifier, IdempotencyKey, PositiveInteger } from "./handle-sales-scalars.ts";
import { SpacesCanonicalRootV1 } from "./handle-sales-spaces.ts";

const AssignmentId = Schema.String.check(
  Schema.makeFilter((value) =>
    /^sassign_[0-9a-f]{32}$/u.test(value) ? undefined : "Invalid assignment id",
  ),
);

export const SpacesOperatorAssignmentV1 = Schema.Struct({
  operator_assignment_id: AssignmentId,
  generation: PositiveInteger,
  network: Schema.Literal("mainnet"),
  canonical_root: SpacesCanonicalRootV1,
  delegation_address: Schema.String,
  replayed: Schema.Boolean,
});

export const SpacesOperatorPrepareRequestV1 = Schema.Struct({
  idempotency_key: IdempotencyKey,
  operator_instance_id: BoundedIdentifier,
  network: Schema.Literal("mainnet"),
  canonical_root: SpacesCanonicalRootV1,
  operator_wallet_reference: BoundedIdentifier,
  delegation_address: Schema.String.check(
    Schema.makeFilter((value) =>
      /^bcs1p[a-z0-9]{8,120}$/u.test(value) ? undefined : "Invalid Spaces delegation address",
    ),
  ),
});

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

export const GetSpacesOperatorAssignments = endpoint({
  method: "GET",
  path: "/communities/:communityId/spaces-operator-assignments",
  auth: Auth.userOrAdmin({ browserSessionOnly: true }),
  request: {
    path: CommunityPath,
    exactRawPathParameters: ["communityId"],
    query: Schema.Struct({ root: SpacesCanonicalRootV1 }),
  },
  response: Schema.Struct({
    candidate: Schema.NullOr(SpacesOperatorAssignmentV1),
  }),
  errors,
});

export const ConfirmSpacesOperatorAssignment = endpoint({
  method: "POST",
  path: "/communities/:communityId/spaces-operator-assignments/confirm",
  auth: Auth.userOrAdmin({ browserSessionOnly: true }),
  request: {
    path: CommunityPath,
    exactRawPathParameters: ["communityId"],
    body: Schema.Struct({
      idempotency_key: IdempotencyKey,
      operator_assignment_id: AssignmentId,
      expected_generation: PositiveInteger,
      namespace_authority_reference: BoundedIdentifier,
      expected_authority_generation: PositiveInteger,
    }),
    bodyEncoding: "exact-json",
    maxBodyBytes: 4_096,
  },
  response: SpacesOperatorAssignmentV1,
  successStatus: [200, 201],
  errors,
});
