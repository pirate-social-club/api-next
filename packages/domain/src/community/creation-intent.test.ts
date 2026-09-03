import { describe, expect, test } from "bun:test";
import {
  type CommunityCreationIntentEvent,
  type CommunityCreationIntentState,
  communityCreationIntentInvariant,
  creationNextAction,
  transitionCommunityCreationIntent,
} from "./creation-intent.ts";

const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const requirementHash = "c".repeat(64);

function state(
  status: CommunityCreationIntentState["status"] = "draft",
): CommunityCreationIntentState {
  return {
    intent_id: "community-creation-intent-1",
    revision: 1,
    status,
    canonical_policy_revision: 1,
    canonical_policy_hash: hashA,
    verification_requirement_hash: requirementHash,
    verification_provider_id: "very.oauth",
    expires_at: "2026-08-20T13:00:00.000Z",
    committed_resource:
      status === "committed"
        ? { community_id: "community-jazleeuw", href: "/communities/community-jazleeuw" }
        : null,
  };
}

function transition(
  current: CommunityCreationIntentState,
  event: CommunityCreationIntentEvent,
): CommunityCreationIntentState {
  const result = transitionCommunityCreationIntent(current, event);
  if (result.kind === "rejected") throw new Error(`Unexpected rejection: ${result.reason}`);
  return result.state;
}

describe("community creation intent state machine", () => {
  test("implements the verification happy path and derives every next action", () => {
    const draft = state();
    expect(creationNextAction(draft)).toEqual({
      kind: "wait",
      reason_code: "operation_pending",
    });
    const verification = transition(draft, {
      type: "preflight_completed",
      expected_revision: 1,
      outcome: "verification_required",
    });
    expect(creationNextAction(verification)).toEqual({
      kind: "start_verification",
      provider_id: "very.oauth",
      intent_id: "community-creation-intent-1",
    });
    const ready = transition(verification, {
      type: "verification_completed",
      expected_revision: 2,
    });
    expect(creationNextAction(ready)).toEqual({ kind: "commit" });
    const committed = transition(ready, {
      type: "commit_completed",
      expected_revision: 3,
      resource: {
        community_id: "community-jazleeuw",
        href: "/communities/community-jazleeuw",
      },
    });
    expect(committed).toMatchObject({
      revision: 4,
      status: "committed",
      committed_resource: { community_id: "community-jazleeuw" },
    });
    expect(creationNextAction(committed)).toEqual({ kind: "none", reason: "committed" });
  });

  test("reuses accepted evidence without another verification transition", () => {
    const ready = transition(state(), {
      type: "preflight_completed",
      expected_revision: 1,
      outcome: "evidence_satisfied",
    });
    expect(ready.status).toBe("commit_ready");
    expect(creationNextAction(ready)).toEqual({ kind: "commit" });
  });

  test("makes quota and unsupported capability durable terminal outcomes", () => {
    for (const outcome of ["quota_exceeded", "gate_unsupported"] as const) {
      const blocked = transition(state(), {
        type: "preflight_completed",
        expected_revision: 1,
        outcome,
      });
      expect(blocked.status).toBe(outcome);
      expect(creationNextAction(blocked)).toEqual({ kind: "blocked", reason: outcome });
      expect(
        transitionCommunityCreationIntent(blocked, {
          type: "preflight_completed",
          expected_revision: 2,
          outcome: "evidence_satisfied",
        }),
      ).toEqual({ kind: "rejected", reason: "terminal" });
    }
  });

  test("makes a quota race lost at commit a durable terminal outcome", () => {
    const ready = { ...state("commit_ready"), revision: 5 };
    const blocked = transition(ready, {
      type: "commit_quota_exceeded",
      expected_revision: 5,
    });
    expect(blocked).toMatchObject({ revision: 6, status: "quota_exceeded" });
    expect(creationNextAction(blocked)).toEqual({
      kind: "blocked",
      reason: "quota_exceeded",
    });
    expect(
      transitionCommunityCreationIntent(state(), {
        type: "commit_quota_exceeded",
        expected_revision: 1,
      }),
    ).toEqual({ kind: "rejected", reason: "invalid_event" });
  });

  test("draft revisions return to preflight and fence stale writers", () => {
    const verification = transition(state(), {
      type: "preflight_completed",
      expected_revision: 1,
      outcome: "verification_required",
    });
    const revised = transition(verification, {
      type: "draft_saved",
      expected_revision: 2,
      canonical_policy_revision: 2,
      canonical_policy_hash: hashB,
      verification_requirement_hash: requirementHash,
    });
    expect(revised).toMatchObject({
      revision: 3,
      status: "draft",
      canonical_policy_revision: 2,
      canonical_policy_hash: hashB,
    });
    expect(
      transitionCommunityCreationIntent(revised, {
        type: "preflight_completed",
        expected_revision: 2,
        outcome: "evidence_satisfied",
      }),
    ).toEqual({ kind: "rejected", reason: "stale_revision" });
  });

  test("persists synchronous draft save and preflight as one replayable revision", () => {
    const changedRequirementHash = "d".repeat(64);
    const transitioned = transition(
      { ...state("commit_ready"), revision: 3 },
      {
        type: "draft_preflight_completed",
        expected_revision: 3,
        canonical_policy_revision: 2,
        canonical_policy_hash: hashB,
        verification_requirement_hash: changedRequirementHash,
        outcome: "verification_required",
      },
    );
    expect(transitioned).toMatchObject({
      revision: 4,
      status: "verification_required",
      canonical_policy_revision: 2,
      canonical_policy_hash: hashB,
      verification_requirement_hash: changedRequirementHash,
    });
  });

  test("expires or cancels any nonterminal state and rejects terminal mutation", () => {
    for (const status of ["draft", "verification_required", "commit_ready"] as const) {
      const current = { ...state(status), revision: 7 };
      for (const type of ["expired", "cancelled"] as const) {
        const terminal = transition(current, { type, expected_revision: 7 });
        expect(terminal.status).toBe(type);
        expect(creationNextAction(terminal)).toEqual({ kind: "none", reason: type });
      }
    }
  });

  test("rejects invalid state, invalid ordering, malformed commit links, and revision jumps", () => {
    expect(
      transitionCommunityCreationIntent(
        { ...state(), canonical_policy_hash: "bad" },
        {
          type: "preflight_completed",
          expected_revision: 1,
          outcome: "evidence_satisfied",
        },
      ),
    ).toEqual({ kind: "rejected", reason: "invalid_state" });
    expect(
      transitionCommunityCreationIntent(state(), {
        type: "verification_completed",
        expected_revision: 1,
      }),
    ).toEqual({ kind: "rejected", reason: "invalid_event" });
    expect(
      transitionCommunityCreationIntent(state("commit_ready"), {
        type: "commit_completed",
        expected_revision: 1,
        resource: { community_id: "community-1", href: "https://external.example/community-1" },
      }),
    ).toEqual({ kind: "rejected", reason: "invalid_event" });
    expect(
      transitionCommunityCreationIntent(state(), {
        type: "draft_saved",
        expected_revision: 1,
        canonical_policy_revision: 3,
        canonical_policy_hash: hashB,
        verification_requirement_hash: requirementHash,
      }),
    ).toEqual({ kind: "rejected", reason: "invalid_event" });
  });

  test("the invariant requires committed resources only on committed states", () => {
    expect(communityCreationIntentInvariant(state())).toBeNull();
    expect(communityCreationIntentInvariant(state("committed"))).toBeNull();
    expect(
      communityCreationIntentInvariant({
        ...state(),
        committed_resource: { community_id: "community-1", href: "/communities/community-1" },
      }),
    ).toBe("unexpected_committed_resource");
  });

  test("accepts requirement-free creator authority only as an all-or-nothing null pair", () => {
    const requirementFree = {
      ...state("commit_ready"),
      verification_requirement_hash: null,
      verification_provider_id: null,
    };
    expect(communityCreationIntentInvariant(requirementFree)).toBeNull();
    expect(creationNextAction(requirementFree)).toEqual({ kind: "commit" });
    expect(
      communityCreationIntentInvariant({ ...requirementFree, status: "verification_required" }),
    ).toBe("verification_required_without_authority");
    expect(
      communityCreationIntentInvariant({ ...requirementFree, verification_provider_id: "very.web" }),
    ).toBe("verification_authority_shape");
    const expired = transitionCommunityCreationIntent(requirementFree, {
      type: "expired",
      expected_revision: 1,
    });
    expect(expired.kind === "accepted" && expired.state.status).toBe("expired");
  });
});
