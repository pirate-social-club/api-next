import { Sha256Hex, type Sha256Hex as Sha256HexValue } from "@pirate/domain/verification";
import { Data, Effect, Schema } from "effect";
import type { ControlPlaneError } from "../ports.ts";

export const OPERATOR_CONTROL_PROMOTION_REQUEST_VERSION =
  "pirate-hns-operator-control-promotion-request-v1" as const;

export type OperatorControlPromotionOutcome = Readonly<{
  readonly outcome: "promoted" | "replayed";
  readonly receipt_id: string;
  readonly evidence_ref: string;
  readonly route_binding_id: string;
  readonly binding_generation: number;
  readonly app_host_activation_generation: number;
}>;

export type PromoteOperatorControlRouteInput = Readonly<{
  readonly receipt_id: string;
  readonly operation_id: string;
  readonly operator_principal_id: string;
  readonly operator_authority_grant_id: string;
  readonly idempotency_key: string;
  readonly community_id: string;
  readonly route_binding_id: string;
  readonly operator_route_activation_id: string;
  readonly evidence_ref: string;
  readonly reviewed_candidate_bytes: Uint8Array;
}>;

export type OperatorControlPromotionStoreInput = PromoteOperatorControlRouteInput &
  Readonly<{
    readonly request_hash: Sha256HexValue;
  }>;

export type OperatorControlPromotionStoreService = Readonly<{
  readonly promote: (
    input: OperatorControlPromotionStoreInput,
  ) => Effect.Effect<OperatorControlPromotionOutcome, ControlPlaneError>;
}>;

export class OperatorControlPromotionRejected extends Data.TaggedError(
  "OperatorControlPromotionRejected",
)<{ readonly reason: "invalid_input" }> {}

const encoder = new TextEncoder();

function validIdentity(value: unknown, maximumBytes = 512): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    !value.includes("\u0000") &&
    encoder.encode(value).byteLength <= maximumBytes
  );
}

async function sha256(value: Uint8Array): Promise<Sha256HexValue> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", value));
  return Schema.decodeUnknownSync(Sha256Hex)(
    [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
  );
}

export function operatorControlPromotionRequestPreimage(
  input: Omit<PromoteOperatorControlRouteInput, "reviewed_candidate_bytes">,
  candidateSha256: Sha256HexValue,
): string {
  return JSON.stringify([
    OPERATOR_CONTROL_PROMOTION_REQUEST_VERSION,
    input.receipt_id,
    input.operation_id,
    input.operator_principal_id,
    input.operator_authority_grant_id,
    input.idempotency_key,
    input.community_id,
    input.route_binding_id,
    input.operator_route_activation_id,
    input.evidence_ref,
    candidateSha256,
  ]);
}

export const promoteOperatorControlRoute = Effect.fn("promoteOperatorControlRoute")(function* (
  input: PromoteOperatorControlRouteInput,
  services: Readonly<{ readonly store: OperatorControlPromotionStoreService }>,
) {
  if (
    !validIdentity(input.receipt_id, 256) ||
    !validIdentity(input.operation_id, 256) ||
    !validIdentity(input.operator_principal_id) ||
    !validIdentity(input.operator_authority_grant_id) ||
    !validIdentity(input.idempotency_key) ||
    !validIdentity(input.community_id) ||
    !validIdentity(input.route_binding_id) ||
    !validIdentity(input.operator_route_activation_id) ||
    !validIdentity(input.evidence_ref) ||
    !(input.reviewed_candidate_bytes instanceof Uint8Array) ||
    input.reviewed_candidate_bytes.byteLength === 0 ||
    input.reviewed_candidate_bytes.byteLength > 1_048_576
  ) {
    return yield* new OperatorControlPromotionRejected({ reason: "invalid_input" });
  }
  const candidateSha256 = yield* Effect.promise(() => sha256(input.reviewed_candidate_bytes));
  const { reviewed_candidate_bytes: reviewedCandidateBytes, ...authority } = input;
  const requestHash = yield* Effect.promise(() =>
    sha256(encoder.encode(operatorControlPromotionRequestPreimage(authority, candidateSha256))),
  );
  return yield* services.store.promote({
    ...input,
    reviewed_candidate_bytes: new Uint8Array(reviewedCandidateBytes),
    request_hash: requestHash,
  });
});
