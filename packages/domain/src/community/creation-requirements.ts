import {
  type CreationRequirementProgress,
  type CreationVerificationRequirement,
  creationRequirementProgressInvariant,
  transitionCreationRequirement,
} from "./creation-requirement.ts";

export const CREATION_REQUIREMENT_ORDER = [
  "human_identity",
  "namespace_ownership",
] as const satisfies readonly CreationVerificationRequirement[];

export type CreationRequirementsState = Readonly<{
  readonly human_identity: CreationRequirementProgress;
  readonly namespace_ownership: CreationRequirementProgress;
}>;

export type CreationRequirementBinding = Readonly<{
  readonly requirement_hash: string;
  readonly provider_id: string;
  readonly provider_binding_hash: string;
}>;

export type CreationRequirementBindings = Readonly<{
  readonly human_identity: CreationRequirementBinding;
  readonly namespace_ownership: CreationRequirementBinding;
}>;

export type CreationRequirementSelection =
  | Readonly<{
      readonly kind: "reserve_verification";
      readonly requirement: CreationVerificationRequirement;
      readonly provider_id: string;
      readonly next_generation: number;
    }>
  | Readonly<{
      readonly kind: "wait";
      readonly requirement: CreationVerificationRequirement;
      readonly reason_code: "verification_pending";
    }>
  | Readonly<{ readonly kind: "commit" }>;

export type CreationRequirementSelectionResult =
  | Readonly<{ readonly kind: "accepted"; readonly selection: CreationRequirementSelection }>
  | Readonly<{ readonly kind: "rejected"; readonly reason: "invalid_state" }>;

export type CreationRequirementBindingReplacementResult =
  | Readonly<{ readonly kind: "accepted"; readonly state: CreationRequirementsState }>
  | Readonly<{
      readonly kind: "rejected";
      readonly reason: "invalid_state" | "invalid_binding";
    }>;

const REQUIREMENT_KEYS = new Set<string>(CREATION_REQUIREMENT_ORDER);
const BINDING_KEYS = new Set<string>(["requirement_hash", "provider_id", "provider_binding_hash"]);

function hasExactRequirementMapKeys(
  value: unknown,
): value is Record<CreationVerificationRequirement, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === REQUIREMENT_KEYS.size && keys.every((key) => REQUIREMENT_KEYS.has(key));
}

function hasExactBindingKeys(value: unknown): value is CreationRequirementBinding {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === BINDING_KEYS.size && keys.every((key) => BINDING_KEYS.has(key));
}

export function creationRequirementsInvariant(state: CreationRequirementsState): string | null {
  if (!hasExactRequirementMapKeys(state)) return "requirement_keys";
  for (const requirement of CREATION_REQUIREMENT_ORDER) {
    const progress = state[requirement];
    if (progress === null || typeof progress !== "object" || Array.isArray(progress)) {
      return `${requirement}.shape`;
    }
    if (progress.requirement !== requirement) return `${requirement}_key`;
    const childError = creationRequirementProgressInvariant(progress);
    if (childError !== null) return `${requirement}.${childError}`;
  }
  return null;
}

/**
 * Selects the next internal storage action for exactly two creation requirements.
 *
 * A reservation is deliberately not a wire action: storage allocates and persists
 * the next generation and ceremony id before application code may expose a
 * `start_verification` action. Pending work serializes the two ceremonies and the
 * fixed order makes concurrent preflights deterministic.
 */
export function selectCreationRequirement(
  state: CreationRequirementsState,
): CreationRequirementSelectionResult {
  if (creationRequirementsInvariant(state) !== null) {
    return { kind: "rejected", reason: "invalid_state" };
  }

  for (const requirement of CREATION_REQUIREMENT_ORDER) {
    if (state[requirement].status === "pending") {
      return {
        kind: "accepted",
        selection: { kind: "wait", requirement, reason_code: "verification_pending" },
      };
    }
  }

  for (const requirement of CREATION_REQUIREMENT_ORDER) {
    const progress = state[requirement];
    if (progress.status !== "satisfied") {
      const nextGeneration = progress.generation + 1;
      if (!Number.isSafeInteger(nextGeneration)) {
        return { kind: "rejected", reason: "invalid_state" };
      }
      return {
        kind: "accepted",
        selection: {
          kind: "reserve_verification",
          requirement,
          provider_id: progress.provider_id,
          next_generation: nextGeneration,
        },
      };
    }
  }

  return { kind: "accepted", selection: { kind: "commit" } };
}

/** Applies both binding comparisons without returning a partially updated aggregate. */
export function replaceCreationRequirementBindings(
  state: CreationRequirementsState,
  bindings: CreationRequirementBindings,
): CreationRequirementBindingReplacementResult {
  if (
    creationRequirementsInvariant(state) !== null ||
    !hasExactRequirementMapKeys(bindings) ||
    !CREATION_REQUIREMENT_ORDER.every((requirement) => hasExactBindingKeys(bindings[requirement]))
  ) {
    return { kind: "rejected", reason: "invalid_state" };
  }

  const next = {} as Record<CreationVerificationRequirement, CreationRequirementProgress>;
  for (const requirement of CREATION_REQUIREMENT_ORDER) {
    const binding = bindings[requirement];
    const transitioned = transitionCreationRequirement(state[requirement], {
      type: "binding_replaced",
      requirement_hash: binding.requirement_hash,
      provider_id: binding.provider_id,
      provider_binding_hash: binding.provider_binding_hash,
    });
    if (transitioned.kind === "rejected") {
      return { kind: "rejected", reason: "invalid_binding" };
    }
    next[requirement] = transitioned.state;
  }

  const replaced: CreationRequirementsState = {
    human_identity: next.human_identity,
    namespace_ownership: next.namespace_ownership,
  };
  return creationRequirementsInvariant(replaced) === null
    ? { kind: "accepted", state: replaced }
    : { kind: "rejected", reason: "invalid_state" };
}
