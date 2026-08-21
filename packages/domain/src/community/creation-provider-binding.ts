import { canonicalJson } from "../canonical-json.ts";
import { sha256Hex } from "../gates-v2/sha256.ts";
import type { CommunityRouteFamily } from "./canonical-route.ts";

export const COMMUNITY_CREATION_PROVIDER_BINDING_VERSION =
  "community-creation-provider-binding-v1" as const;
export const COMMUNITY_CREATION_CEREMONY_RESERVATION_VERSION =
  "community-creation-ceremony-reservation-v1" as const;

export type CommunityCreationProviderBinding = Readonly<{
  readonly requirement: "human_identity" | "namespace_ownership";
  readonly family: CommunityRouteFamily | null;
  readonly provider_id: string;
  readonly provider_configuration: Readonly<{
    readonly kind: "managed" | "dynamic";
    readonly reference: string;
    readonly version: string;
  }>;
  readonly protocol_version: string;
}>;

function canonicalIdentifier(value: string): boolean {
  return value.length > 0 && value.trim() === value && !value.includes("\u0000");
}

function validBinding(binding: CommunityCreationProviderBinding): boolean {
  return (
    canonicalIdentifier(binding.provider_id) &&
    canonicalIdentifier(binding.provider_configuration.reference) &&
    canonicalIdentifier(binding.provider_configuration.version) &&
    canonicalIdentifier(binding.protocol_version) &&
    ((binding.requirement === "human_identity" && binding.family === null) ||
      (binding.requirement === "namespace_ownership" && binding.family !== null))
  );
}

/** Internal authority fingerprint; the public requirement projection omits it. */
export function communityCreationProviderBindingPreimage(
  binding: CommunityCreationProviderBinding,
): string {
  if (!validBinding(binding)) {
    throw new TypeError("Invalid community creation provider binding");
  }
  return canonicalJson({
    family: binding.family,
    protocol_version: binding.protocol_version,
    provider_configuration: binding.provider_configuration,
    provider_id: binding.provider_id,
    requirement: binding.requirement,
    version: COMMUNITY_CREATION_PROVIDER_BINDING_VERSION,
  });
}

export function communityCreationProviderBindingHash(
  binding: CommunityCreationProviderBinding,
): string {
  return sha256Hex(communityCreationProviderBindingPreimage(binding));
}

export type CommunityCreationCeremonyReservation = Readonly<{
  readonly actor_id: string;
  readonly creation_intent_id: string;
  readonly ceremony_intent_id: string;
  readonly requirement: "human_identity" | "namespace_ownership";
  readonly generation: number;
  readonly requirement_hash: string;
  readonly provider_id: string;
  readonly provider_binding_hash: string;
  readonly route: Readonly<{
    readonly family: CommunityRouteFamily;
    readonly root_label: string;
    readonly root_label_display: string;
    readonly path_segment: string;
  }> | null;
}>;

export function communityCreationCeremonyReservationPreimage(
  reservation: CommunityCreationCeremonyReservation,
): string {
  if (
    !canonicalIdentifier(reservation.actor_id) ||
    !canonicalIdentifier(reservation.creation_intent_id) ||
    !canonicalIdentifier(reservation.ceremony_intent_id) ||
    !canonicalIdentifier(reservation.provider_id) ||
    !Number.isSafeInteger(reservation.generation) ||
    reservation.generation <= 0 ||
    !/^[0-9a-f]{64}$/u.test(reservation.requirement_hash) ||
    !/^[0-9a-f]{64}$/u.test(reservation.provider_binding_hash) ||
    (reservation.requirement === "human_identity" && reservation.route !== null) ||
    (reservation.requirement === "namespace_ownership" && reservation.route === null)
  ) {
    throw new TypeError("Invalid community creation ceremony reservation");
  }
  return canonicalJson({
    actor_id: reservation.actor_id,
    ceremony_intent_id: reservation.ceremony_intent_id,
    creation_intent_id: reservation.creation_intent_id,
    generation: reservation.generation,
    provider_binding_hash: reservation.provider_binding_hash,
    provider_id: reservation.provider_id,
    requirement: reservation.requirement,
    requirement_hash: reservation.requirement_hash,
    route: reservation.route,
    version: COMMUNITY_CREATION_CEREMONY_RESERVATION_VERSION,
  });
}

export function communityCreationCeremonyReservationHash(
  reservation: CommunityCreationCeremonyReservation,
): string {
  return sha256Hex(communityCreationCeremonyReservationPreimage(reservation));
}
