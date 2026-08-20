export type CreationVerificationRequirement = "human_identity" | "namespace_ownership";
export type CreationRequirementStatus = "unmet" | "pending" | "satisfied" | "failed" | "expired";

export type CreationRequirementProgress = Readonly<{
  readonly requirement: CreationVerificationRequirement;
  readonly status: CreationRequirementStatus;
  readonly requirement_hash: string;
  readonly provider_id: string;
  /** Internal authority fingerprint; public progress projections omit this field. */
  readonly provider_binding_hash: string;
  readonly generation: number;
  readonly ceremony_intent_id: string | null;
  readonly satisfied_at: string | null;
}>;

export type CreationRequirementEvent =
  | Readonly<{
      readonly type: "binding_replaced";
      readonly requirement_hash: string;
      readonly provider_id: string;
      readonly provider_binding_hash: string;
    }>
  | Readonly<{
      readonly type: "ceremony_reserved";
      readonly generation: number;
      readonly ceremony_intent_id: string;
    }>
  | Readonly<{
      readonly type: "ceremony_satisfied";
      readonly generation: number;
      readonly ceremony_intent_id: string;
      readonly satisfied_at: string;
    }>
  | Readonly<{
      readonly type: "ceremony_failed" | "ceremony_expired";
      readonly generation: number;
      readonly ceremony_intent_id: string;
    }>;

export type CreationRequirementTransitionRejection =
  | "invalid_state"
  | "invalid_event"
  | "stale_generation"
  | "session_fanout";

export type CreationRequirementTransitionResult =
  | Readonly<{ readonly kind: "accepted"; readonly state: CreationRequirementProgress }>
  | Readonly<{
      readonly kind: "rejected";
      readonly reason: CreationRequirementTransitionRejection;
    }>;

const SHA256_HEX = /^[0-9a-f]{64}$/u;
const CANONICAL_ISO_INSTANT =
  /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$/u;

function nonEmptyCanonical(value: string): boolean {
  return value.length > 0 && value.trim() === value;
}

function canonicalInstant(value: string): boolean {
  if (!CANONICAL_ISO_INSTANT.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

export function creationRequirementProgressInvariant(
  state: CreationRequirementProgress,
): string | null {
  if (state.requirement !== "human_identity" && state.requirement !== "namespace_ownership") {
    return "requirement";
  }
  if (
    state.status !== "unmet" &&
    state.status !== "pending" &&
    state.status !== "satisfied" &&
    state.status !== "failed" &&
    state.status !== "expired"
  ) {
    return "status";
  }
  if (!SHA256_HEX.test(state.requirement_hash)) return "requirement_hash";
  if (!nonEmptyCanonical(state.provider_id)) return "provider_id";
  if (!SHA256_HEX.test(state.provider_binding_hash)) return "provider_binding_hash";
  if (!Number.isSafeInteger(state.generation) || state.generation < 0) return "generation";

  if (state.status === "unmet") {
    return state.ceremony_intent_id === null && state.satisfied_at === null ? null : "unmet_shape";
  }
  if (state.generation === 0 || !nonEmptyCanonical(state.ceremony_intent_id ?? "")) {
    return "ceremony_shape";
  }
  if (state.status === "satisfied") {
    return state.satisfied_at !== null && canonicalInstant(state.satisfied_at)
      ? null
      : "satisfied_shape";
  }
  return state.satisfied_at === null ? null : "terminal_shape";
}

function accepted(state: CreationRequirementProgress): CreationRequirementTransitionResult {
  return creationRequirementProgressInvariant(state) === null
    ? { kind: "accepted", state }
    : { kind: "rejected", reason: "invalid_state" };
}

function rejected(
  reason: CreationRequirementTransitionRejection,
): CreationRequirementTransitionResult {
  return { kind: "rejected", reason };
}

function exactCeremony(
  state: CreationRequirementProgress,
  event: Readonly<{ readonly generation: number; readonly ceremony_intent_id: string }>,
): boolean {
  return (
    event.generation === state.generation && event.ceremony_intent_id === state.ceremony_intent_id
  );
}

/**
 * Pure per-requirement reducer; outer intent revision and actor/provider locks live in storage.
 * Storage also owns globally fresh ceremony ids. The private provider-binding fingerprint captures
 * configuration/version changes even when the public provider id is unchanged.
 */
export function transitionCreationRequirement(
  state: CreationRequirementProgress,
  event: CreationRequirementEvent,
): CreationRequirementTransitionResult {
  if (creationRequirementProgressInvariant(state) !== null) return rejected("invalid_state");

  if (event.type === "binding_replaced") {
    if (
      !SHA256_HEX.test(event.requirement_hash) ||
      !nonEmptyCanonical(event.provider_id) ||
      !SHA256_HEX.test(event.provider_binding_hash)
    ) {
      return rejected("invalid_event");
    }
    if (
      event.requirement_hash === state.requirement_hash &&
      event.provider_id === state.provider_id &&
      event.provider_binding_hash === state.provider_binding_hash
    ) {
      return accepted(state);
    }
    return accepted({
      ...state,
      status: "unmet",
      requirement_hash: event.requirement_hash,
      provider_id: event.provider_id,
      provider_binding_hash: event.provider_binding_hash,
      ceremony_intent_id: null,
      satisfied_at: null,
    });
  }

  if (
    !Number.isSafeInteger(event.generation) ||
    event.generation < 1 ||
    !nonEmptyCanonical(event.ceremony_intent_id)
  ) {
    return rejected("invalid_event");
  }

  if (event.type === "ceremony_reserved") {
    if (state.status === "pending" || state.status === "satisfied") {
      if (!exactCeremony(state, event)) return rejected("session_fanout");
      return accepted(state);
    }
    if (event.generation !== state.generation + 1) return rejected("stale_generation");
    return accepted({
      ...state,
      status: "pending",
      generation: event.generation,
      ceremony_intent_id: event.ceremony_intent_id,
      satisfied_at: null,
    });
  }

  if (event.generation !== state.generation) return rejected("stale_generation");
  if (event.ceremony_intent_id !== state.ceremony_intent_id) return rejected("session_fanout");

  if (event.type === "ceremony_satisfied") {
    if (!canonicalInstant(event.satisfied_at)) return rejected("invalid_event");
    if (state.status === "satisfied") {
      return state.satisfied_at === event.satisfied_at
        ? accepted(state)
        : rejected("invalid_event");
    }
    return state.status === "pending"
      ? accepted({ ...state, status: "satisfied", satisfied_at: event.satisfied_at })
      : rejected("invalid_event");
  }

  const nextStatus = event.type === "ceremony_failed" ? "failed" : "expired";
  if (state.status === nextStatus) return accepted(state);
  return state.status === "pending"
    ? accepted({ ...state, status: nextStatus, satisfied_at: null })
    : rejected("invalid_event");
}
