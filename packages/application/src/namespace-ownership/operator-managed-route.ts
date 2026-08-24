import { deriveCommunityRoute } from "@pirate/domain";
import { Sha256Hex, type Sha256Hex as Sha256HexValue } from "@pirate/domain/verification";
import { Data, Effect, Schema } from "effect";
import type { ControlPlaneError } from "../ports.ts";

export const OPERATOR_MANAGED_ROUTE_ACTIVATION_REQUEST_VERSION =
  "pirate-operator-managed-route-activation-request-v1" as const;
export const OPERATOR_MANAGED_ROUTE_REVOCATION_REQUEST_VERSION =
  "pirate-operator-managed-route-revocation-request-v1" as const;

const encoder = new TextEncoder();

export type OperatorManagedRouteOutcome = Readonly<{
  readonly outcome: "activated" | "revoked" | "replayed";
  readonly operator_route_activation_id: string;
  readonly route_binding_id: string;
  readonly activation_generation: number;
}>;

export type ActivateOperatorManagedRouteInput = Readonly<{
  readonly operation_id: string;
  readonly operator_principal_id: string;
  readonly operator_authority_grant_id: string;
  readonly idempotency_key: string;
  readonly community_id: string;
  readonly canonical_root: string;
  readonly registry_reference: string;
  readonly registry_version: number;
  readonly registry_digest: Sha256HexValue;
  readonly operator_route_activation_id: string;
  readonly route_binding_id: string;
  readonly reason_code: string;
}>;

export type RevokeOperatorManagedRouteInput = Readonly<{
  readonly operation_id: string;
  readonly operator_principal_id: string;
  readonly operator_authority_grant_id: string;
  readonly idempotency_key: string;
  readonly community_id: string;
  readonly canonical_root: string;
  readonly operator_route_activation_id: string;
  readonly route_binding_id: string;
  readonly expected_activation_generation: number;
  readonly reason_code: string;
}>;

export type OperatorManagedRouteStoreActivateInput = ActivateOperatorManagedRouteInput &
  Readonly<{
    readonly root_label_display: string;
    readonly request_hash: Sha256HexValue;
  }>;

export type OperatorManagedRouteStoreRevokeInput = RevokeOperatorManagedRouteInput &
  Readonly<{ readonly request_hash: Sha256HexValue }>;

export type OperatorManagedRouteStoreService = Readonly<{
  readonly activate: (
    input: OperatorManagedRouteStoreActivateInput,
  ) => Effect.Effect<OperatorManagedRouteOutcome, ControlPlaneError>;
  readonly revoke: (
    input: OperatorManagedRouteStoreRevokeInput,
  ) => Effect.Effect<OperatorManagedRouteOutcome, ControlPlaneError>;
}>;

export class OperatorManagedRouteRejected extends Data.TaggedError("OperatorManagedRouteRejected")<{
  readonly reason: "invalid_input";
}> {}

function validIdentity(value: unknown, maximumBytes = 512): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    !value.includes("\u0000") &&
    encoder.encode(value).byteLength <= maximumBytes
  );
}

function validPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

async function hashPreimage(preimage: string): Promise<Sha256HexValue> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(preimage)));
  return Schema.decodeUnknownSync(Sha256Hex)(
    [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
  );
}

export function operatorManagedRouteActivationRequestPreimage(
  input: ActivateOperatorManagedRouteInput,
): string {
  return JSON.stringify([
    OPERATOR_MANAGED_ROUTE_ACTIVATION_REQUEST_VERSION,
    input.operation_id,
    input.operator_principal_id,
    input.operator_authority_grant_id,
    input.idempotency_key,
    input.community_id,
    input.canonical_root,
    input.registry_reference,
    input.registry_version,
    input.registry_digest,
    input.operator_route_activation_id,
    input.route_binding_id,
    input.reason_code,
  ]);
}

export function operatorManagedRouteRevocationRequestPreimage(
  input: RevokeOperatorManagedRouteInput,
): string {
  return JSON.stringify([
    OPERATOR_MANAGED_ROUTE_REVOCATION_REQUEST_VERSION,
    input.operation_id,
    input.operator_principal_id,
    input.operator_authority_grant_id,
    input.idempotency_key,
    input.community_id,
    input.canonical_root,
    input.operator_route_activation_id,
    input.route_binding_id,
    input.expected_activation_generation,
    input.reason_code,
  ]);
}

function validCommonInput(
  input: ActivateOperatorManagedRouteInput | RevokeOperatorManagedRouteInput,
): boolean {
  return (
    validIdentity(input.operation_id) &&
    validIdentity(input.operator_principal_id) &&
    validIdentity(input.operator_authority_grant_id) &&
    validIdentity(input.idempotency_key) &&
    validIdentity(input.community_id) &&
    validIdentity(input.operator_route_activation_id) &&
    validIdentity(input.route_binding_id) &&
    validIdentity(input.reason_code)
  );
}

export const activateOperatorManagedRoute = Effect.fn("activateOperatorManagedRoute")(function* (
  input: ActivateOperatorManagedRouteInput,
  services: Readonly<{ readonly store: OperatorManagedRouteStoreService }>,
) {
  const route = deriveCommunityRoute({ family: "hns", root_label: input.canonical_root });
  if (
    !validCommonInput(input) ||
    route.kind === "rejected" ||
    route.value.root_label !== input.canonical_root ||
    !validIdentity(input.registry_reference, 256) ||
    !validPositiveInteger(input.registry_version) ||
    !/^[0-9a-f]{64}$/u.test(input.registry_digest)
  ) {
    return yield* new OperatorManagedRouteRejected({ reason: "invalid_input" });
  }
  const requestHash = yield* Effect.promise(() =>
    hashPreimage(operatorManagedRouteActivationRequestPreimage(input)),
  );
  return yield* services.store.activate({
    ...input,
    root_label_display: route.value.root_label_display,
    request_hash: requestHash,
  });
});

export const revokeOperatorManagedRoute = Effect.fn("revokeOperatorManagedRoute")(function* (
  input: RevokeOperatorManagedRouteInput,
  services: Readonly<{ readonly store: OperatorManagedRouteStoreService }>,
) {
  const route = deriveCommunityRoute({ family: "hns", root_label: input.canonical_root });
  if (
    !validCommonInput(input) ||
    route.kind === "rejected" ||
    route.value.root_label !== input.canonical_root ||
    !validPositiveInteger(input.expected_activation_generation)
  ) {
    return yield* new OperatorManagedRouteRejected({ reason: "invalid_input" });
  }
  const requestHash = yield* Effect.promise(() =>
    hashPreimage(operatorManagedRouteRevocationRequestPreimage(input)),
  );
  return yield* services.store.revoke({ ...input, request_hash: requestHash });
});
