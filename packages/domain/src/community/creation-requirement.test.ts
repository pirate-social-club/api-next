import { describe, expect, test } from "bun:test";
import {
  type CreationRequirementEvent,
  type CreationRequirementProgress,
  creationRequirementProgressInvariant,
  transitionCreationRequirement,
} from "./creation-requirement.ts";

const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const bindingHashA = "c".repeat(64);
const bindingHashB = "d".repeat(64);

function state(overrides: Partial<CreationRequirementProgress> = {}): CreationRequirementProgress {
  return {
    requirement: "namespace_ownership",
    status: "unmet",
    requirement_hash: hashA,
    provider_id: "hns.owner.v1",
    provider_binding_hash: bindingHashA,
    generation: 0,
    ceremony_intent_id: null,
    satisfied_at: null,
    ...overrides,
  };
}

function transition(
  current: CreationRequirementProgress,
  event: CreationRequirementEvent,
): CreationRequirementProgress {
  const result = transitionCreationRequirement(current, event);
  if (result.kind === "rejected") throw new Error(`unexpected rejection: ${result.reason}`);
  return result.state;
}

describe("creation requirement progress", () => {
  test("pins the closed public progress shape", () => {
    expect(creationRequirementProgressInvariant(state())).toBeNull();
    expect(creationRequirementProgressInvariant(state({ requirement_hash: "bad" }))).toBe(
      "requirement_hash",
    );
    expect(creationRequirementProgressInvariant(state({ provider_id: " provider" }))).toBe(
      "provider_id",
    );
    expect(creationRequirementProgressInvariant(state({ provider_binding_hash: "bad" }))).toBe(
      "provider_binding_hash",
    );
    expect(
      creationRequirementProgressInvariant(
        state({ status: "unknown" as CreationRequirementProgress["status"] }),
      ),
    ).toBe("status");
    expect(
      creationRequirementProgressInvariant(
        state({ status: "pending", generation: 1, ceremony_intent_id: null }),
      ),
    ).toBe("ceremony_shape");
    expect(
      creationRequirementProgressInvariant(
        state({
          status: "satisfied",
          generation: 1,
          ceremony_intent_id: "ceremony-1",
          satisfied_at: null,
        }),
      ),
    ).toBe("satisfied_shape");
  });

  test("reserves one monotonic ceremony generation with exact replay", () => {
    const reserved = transition(state(), {
      type: "ceremony_reserved",
      generation: 1,
      ceremony_intent_id: "ceremony-1",
    });
    expect(reserved).toMatchObject({ status: "pending", generation: 1 });
    expect(
      transitionCreationRequirement(reserved, {
        type: "ceremony_reserved",
        generation: 1,
        ceremony_intent_id: "ceremony-1",
      }),
    ).toEqual({ kind: "accepted", state: reserved });
    expect(
      transitionCreationRequirement(reserved, {
        type: "ceremony_reserved",
        generation: 1,
        ceremony_intent_id: "ceremony-fanout",
      }),
    ).toEqual({ kind: "rejected", reason: "session_fanout" });
    expect(
      transitionCreationRequirement(reserved, {
        type: "ceremony_reserved",
        generation: 2,
        ceremony_intent_id: "ceremony-2",
      }),
    ).toEqual({ kind: "rejected", reason: "session_fanout" });
  });

  test("settles only the exact current generation and replays the result", () => {
    const pending = transition(state(), {
      type: "ceremony_reserved",
      generation: 1,
      ceremony_intent_id: "ceremony-1",
    });
    const event = {
      type: "ceremony_satisfied",
      generation: 1,
      ceremony_intent_id: "ceremony-1",
      satisfied_at: "2026-08-20T13:00:00.000Z",
    } as const;
    const satisfied = transition(pending, event);
    expect(satisfied.status).toBe("satisfied");
    expect(
      transitionCreationRequirement(satisfied, {
        type: "ceremony_reserved",
        generation: 1,
        ceremony_intent_id: "ceremony-1",
      }),
    ).toEqual({ kind: "accepted", state: satisfied });
    expect(
      transitionCreationRequirement(satisfied, {
        type: "ceremony_reserved",
        generation: 1,
        ceremony_intent_id: "ceremony-fanout",
      }),
    ).toEqual({ kind: "rejected", reason: "session_fanout" });
    expect(transitionCreationRequirement(satisfied, event)).toEqual({
      kind: "accepted",
      state: satisfied,
    });
    expect(transitionCreationRequirement(pending, { ...event, generation: 2 })).toEqual({
      kind: "rejected",
      reason: "stale_generation",
    });
    expect(
      transitionCreationRequirement(pending, { ...event, ceremony_intent_id: "other" }),
    ).toEqual({ kind: "rejected", reason: "session_fanout" });
  });

  test("advances after failed or expired ceremonies and rejects old callbacks", () => {
    const pending = transition(state(), {
      type: "ceremony_reserved",
      generation: 1,
      ceremony_intent_id: "ceremony-1",
    });
    const failed = transition(pending, {
      type: "ceremony_failed",
      generation: 1,
      ceremony_intent_id: "ceremony-1",
    });
    expect(failed.status).toBe("failed");
    const retry = transition(failed, {
      type: "ceremony_reserved",
      generation: 2,
      ceremony_intent_id: "ceremony-2",
    });
    expect(retry).toMatchObject({ status: "pending", generation: 2 });
    expect(
      transitionCreationRequirement(retry, {
        type: "ceremony_satisfied",
        generation: 1,
        ceremony_intent_id: "ceremony-1",
        satisfied_at: "2026-08-20T13:00:00.000Z",
      }),
    ).toEqual({ kind: "rejected", reason: "stale_generation" });

    const expired = transition(retry, {
      type: "ceremony_expired",
      generation: 2,
      ceremony_intent_id: "ceremony-2",
    });
    expect(expired.status).toBe("expired");
  });

  test("preserves exact bindings and invalidates changed route bindings", () => {
    const pending = transition(state(), {
      type: "ceremony_reserved",
      generation: 1,
      ceremony_intent_id: "ceremony-1",
    });
    const satisfied = transition(pending, {
      type: "ceremony_satisfied",
      generation: 1,
      ceremony_intent_id: "ceremony-1",
      satisfied_at: "2026-08-20T13:00:00.000Z",
    });
    expect(
      transition(satisfied, {
        type: "binding_replaced",
        requirement_hash: hashA,
        provider_id: "hns.owner.v1",
        provider_binding_hash: bindingHashA,
      }),
    ).toEqual(satisfied);

    const rebound = transition(satisfied, {
      type: "binding_replaced",
      requirement_hash: hashB,
      provider_id: "spaces.owner.v1",
      provider_binding_hash: bindingHashB,
    });
    expect(rebound).toMatchObject({
      status: "unmet",
      requirement_hash: hashB,
      provider_id: "spaces.owner.v1",
      provider_binding_hash: bindingHashB,
      generation: 1,
      ceremony_intent_id: null,
      satisfied_at: null,
    });
    expect(
      transitionCreationRequirement(rebound, {
        type: "ceremony_satisfied",
        generation: 1,
        ceremony_intent_id: "ceremony-1",
        satisfied_at: "2026-08-20T13:00:00.000Z",
      }),
    ).toEqual({ kind: "rejected", reason: "session_fanout" });
  });

  test("invalidates evidence when a provider binding rotates under the same public id", () => {
    const pending = transition(state(), {
      type: "ceremony_reserved",
      generation: 1,
      ceremony_intent_id: "ceremony-1",
    });
    const satisfied = transition(pending, {
      type: "ceremony_satisfied",
      generation: 1,
      ceremony_intent_id: "ceremony-1",
      satisfied_at: "2026-08-20T13:00:00.000Z",
    });

    expect(
      transition(satisfied, {
        type: "binding_replaced",
        requirement_hash: hashA,
        provider_id: "hns.owner.v1",
        provider_binding_hash: bindingHashB,
      }),
    ).toMatchObject({
      status: "unmet",
      provider_id: "hns.owner.v1",
      provider_binding_hash: bindingHashB,
      generation: 1,
      ceremony_intent_id: null,
      satisfied_at: null,
    });
  });
});
