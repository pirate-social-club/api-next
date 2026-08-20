import { describe, expect, test } from "bun:test";
import { communityNamespaceRequirementHash } from "./canonical-route.ts";
import {
  type CreationRequirementProgress,
  transitionCreationRequirement,
} from "./creation-requirement.ts";
import {
  type CreationRequirementBindings,
  type CreationRequirementsState,
  creationRequirementsInvariant,
  replaceCreationRequirementBindings,
  selectCreationRequirement,
} from "./creation-requirements.ts";

const humanHash = "a".repeat(64);
const namespaceHash = "b".repeat(64);
const humanBindingHash = "c".repeat(64);
const namespaceBindingHash = "d".repeat(64);

function progress(
  requirement: CreationRequirementProgress["requirement"],
  overrides: Partial<CreationRequirementProgress> = {},
): CreationRequirementProgress {
  return {
    requirement,
    status: "unmet",
    requirement_hash: requirement === "human_identity" ? humanHash : namespaceHash,
    provider_id: requirement === "human_identity" ? "very.oauth" : "test.hns-owner",
    provider_binding_hash:
      requirement === "human_identity" ? humanBindingHash : namespaceBindingHash,
    generation: 0,
    ceremony_intent_id: null,
    satisfied_at: null,
    ...overrides,
  };
}

function requirements(
  overrides: Partial<CreationRequirementsState> = {},
): CreationRequirementsState {
  return {
    human_identity: progress("human_identity"),
    namespace_ownership: progress("namespace_ownership"),
    ...overrides,
  };
}

function pending(state: CreationRequirementProgress): CreationRequirementProgress {
  const result = transitionCreationRequirement(state, {
    type: "ceremony_reserved",
    generation: state.generation + 1,
    ceremony_intent_id: `${state.requirement}-ceremony-${state.generation + 1}`,
  });
  if (result.kind === "rejected") throw new Error(result.reason);
  return result.state;
}

function satisfied(state: CreationRequirementProgress): CreationRequirementProgress {
  const reserved = pending(state);
  const result = transitionCreationRequirement(reserved, {
    type: "ceremony_satisfied",
    generation: reserved.generation,
    ceremony_intent_id: reserved.ceremony_intent_id ?? "",
    satisfied_at: "2026-08-20T12:00:00.000Z",
  });
  if (result.kind === "rejected") throw new Error(result.reason);
  return result.state;
}

function bindings(state: CreationRequirementsState): CreationRequirementBindings {
  return {
    human_identity: {
      requirement_hash: state.human_identity.requirement_hash,
      provider_id: state.human_identity.provider_id,
      provider_binding_hash: state.human_identity.provider_binding_hash,
    },
    namespace_ownership: {
      requirement_hash: state.namespace_ownership.requirement_hash,
      provider_id: state.namespace_ownership.provider_id,
      provider_binding_hash: state.namespace_ownership.provider_binding_hash,
    },
  };
}

describe("community creation requirement aggregate", () => {
  test("selects the two ceremonies in fixed order and commits only after both satisfy", () => {
    const initial = requirements();
    expect(selectCreationRequirement(initial)).toEqual({
      kind: "accepted",
      selection: {
        kind: "reserve_verification",
        requirement: "human_identity",
        provider_id: "very.oauth",
        next_generation: 1,
      },
    });

    const humanSatisfied = requirements({
      human_identity: satisfied(initial.human_identity),
    });
    expect(selectCreationRequirement(humanSatisfied)).toEqual({
      kind: "accepted",
      selection: {
        kind: "reserve_verification",
        requirement: "namespace_ownership",
        provider_id: "test.hns-owner",
        next_generation: 1,
      },
    });

    const namespaceSatisfied = requirements({
      namespace_ownership: satisfied(initial.namespace_ownership),
    });
    expect(selectCreationRequirement(namespaceSatisfied)).toMatchObject({
      selection: { kind: "reserve_verification", requirement: "human_identity" },
    });

    expect(
      selectCreationRequirement(
        requirements({
          human_identity: humanSatisfied.human_identity,
          namespace_ownership: satisfied(initial.namespace_ownership),
        }),
      ),
    ).toEqual({ kind: "accepted", selection: { kind: "commit" } });
  });

  test("waits on pending work before starting another ceremony", () => {
    expect(
      selectCreationRequirement(
        requirements({ namespace_ownership: pending(progress("namespace_ownership")) }),
      ),
    ).toEqual({
      kind: "accepted",
      selection: {
        kind: "wait",
        requirement: "namespace_ownership",
        reason_code: "verification_pending",
      },
    });

    expect(
      selectCreationRequirement(
        requirements({
          human_identity: pending(progress("human_identity")),
          namespace_ownership: pending(progress("namespace_ownership")),
        }),
      ),
    ).toMatchObject({ selection: { kind: "wait", requirement: "human_identity" } });
  });

  test("advances failed and expired requirements from their current generation", () => {
    for (const status of ["failed", "expired"] as const) {
      const current = requirements({
        human_identity: progress("human_identity", {
          status,
          generation: 3,
          ceremony_intent_id: "human-ceremony-3",
        }),
      });
      expect(selectCreationRequirement(current)).toMatchObject({
        selection: {
          kind: "reserve_verification",
          requirement: "human_identity",
          next_generation: 4,
        },
      });
    }
    expect(
      selectCreationRequirement(
        requirements({
          human_identity: progress("human_identity", { generation: Number.MAX_SAFE_INTEGER }),
        }),
      ),
    ).toEqual({ kind: "rejected", reason: "invalid_state" });
  });

  test("replaces both bindings atomically and invalidates only changed authority", () => {
    const current = requirements({
      human_identity: satisfied(progress("human_identity")),
      namespace_ownership: satisfied(progress("namespace_ownership")),
    });
    const unchanged = replaceCreationRequirementBindings(current, bindings(current));
    expect(unchanged).toEqual({ kind: "accepted", state: current });

    const changedNamespace = bindings(current);
    const namespaceResult = replaceCreationRequirementBindings(current, {
      ...changedNamespace,
      namespace_ownership: {
        ...changedNamespace.namespace_ownership,
        requirement_hash: "e".repeat(64),
      },
    });
    expect(namespaceResult).toMatchObject({
      kind: "accepted",
      state: {
        human_identity: { status: "satisfied" },
        namespace_ownership: {
          status: "unmet",
          generation: 1,
          ceremony_intent_id: null,
          satisfied_at: null,
        },
      },
    });

    const changedHuman = bindings(current);
    const humanResult = replaceCreationRequirementBindings(current, {
      ...changedHuman,
      human_identity: {
        ...changedHuman.human_identity,
        provider_binding_hash: "f".repeat(64),
      },
    });
    expect(humanResult).toMatchObject({
      kind: "accepted",
      state: {
        human_identity: { status: "unmet" },
        namespace_ownership: { status: "satisfied" },
      },
    });
  });

  test("preserves equivalent Unicode/ACE namespace authority and invalidates a changed route", () => {
    const unicode = communityNamespaceRequirementHash({ family: "hns", root_label: "🔥" });
    const ace = communityNamespaceRequirementHash({ family: "hns", root_label: "xn--4v8h" });
    const other = communityNamespaceRequirementHash({ family: "spaces", root_label: "xn--4v8h" });
    if (unicode.kind === "rejected" || ace.kind === "rejected" || other.kind === "rejected") {
      throw new Error("expected canonical route fixtures");
    }
    expect(unicode.value).toBe(ace.value);
    expect(other.value).not.toBe(ace.value);

    const current = requirements({
      namespace_ownership: satisfied(
        progress("namespace_ownership", { requirement_hash: unicode.value }),
      ),
    });
    expect(
      replaceCreationRequirementBindings(current, {
        ...bindings(current),
        namespace_ownership: {
          ...bindings(current).namespace_ownership,
          requirement_hash: ace.value,
        },
      }),
    ).toEqual({ kind: "accepted", state: current });
    expect(
      replaceCreationRequirementBindings(current, {
        ...bindings(current),
        namespace_ownership: {
          ...bindings(current).namespace_ownership,
          requirement_hash: other.value,
        },
      }),
    ).toMatchObject({
      kind: "accepted",
      state: { namespace_ownership: { status: "unmet" } },
    });
  });

  test("rejects swapped, malformed, partial, or excess aggregate authority", () => {
    expect(
      creationRequirementsInvariant(
        requirements({
          human_identity: progress("namespace_ownership"),
          namespace_ownership: progress("human_identity"),
        }),
      ),
    ).toBe("human_identity_key");
    expect(
      selectCreationRequirement(
        requirements({ human_identity: progress("human_identity", { requirement_hash: "bad" }) }),
      ),
    ).toEqual({ kind: "rejected", reason: "invalid_state" });

    const current = requirements();
    const partial = {
      human_identity: bindings(current).human_identity,
    } as CreationRequirementBindings;
    expect(replaceCreationRequirementBindings(current, partial)).toEqual({
      kind: "rejected",
      reason: "invalid_state",
    });
    expect(replaceCreationRequirementBindings(current, null as never)).toEqual({
      kind: "rejected",
      reason: "invalid_state",
    });
    expect(
      replaceCreationRequirementBindings(current, {
        ...bindings(current),
        namespace_ownership: {
          ...bindings(current).namespace_ownership,
          unexpected_authority: "forged",
        },
      } as CreationRequirementBindings),
    ).toEqual({ kind: "rejected", reason: "invalid_state" });
    expect(
      creationRequirementsInvariant({
        ...current,
        extra: current.human_identity,
      } as CreationRequirementsState),
    ).toBe("requirement_keys");
    expect(creationRequirementsInvariant(null as never)).toBe("requirement_keys");
  });
});
