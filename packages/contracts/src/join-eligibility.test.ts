import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { GetJoinEligibility } from "./v1.ts";

const base = {
  community: "community-jazleeuw",
  membership_mode: "gated" as const,
  human_verification_lane: "very" as const,
  preferred_verification_provider: "very.oauth",
  membership_gate_summaries: [
    {
      gate_id: "curated-human-membership-v1",
      gate_type: "human_verification" as const,
      accepted_providers: ["very.oauth"],
    },
  ],
};

describe("join eligibility contract", () => {
  test("freezes the provider-neutral human verification next action", () => {
    expect(GetJoinEligibility.successStatus).toBe(200);
    expect(
      Schema.decodeUnknownSync(GetJoinEligibility.response)({
        ...base,
        joinable_now: false,
        status: "verification_required",
        missing_capabilities: ["human_verification"],
        suggested_verification_provider: "very.oauth",
        suggested_verification_intent: "community_join",
        failure_reason: "missing_verification",
        gate_evaluation: {
          outcome: "needs_evidence",
        },
        next_action: {
          kind: "start_verification",
          provider_id: "very.oauth",
          intent_id: "join-intent-1",
        },
      }).next_action,
    ).toEqual({
      kind: "start_verification",
      provider_id: "very.oauth",
      intent_id: "join-intent-1",
    });
  });

  test("accepts every frozen terminal/action shape", () => {
    const decode = Schema.decodeUnknownSync(GetJoinEligibility.response);
    for (const candidate of [
      {
        ...base,
        joinable_now: true,
        status: "joinable",
        gate_evaluation: { outcome: "pass" },
        next_action: { kind: "join" },
      },
      {
        ...base,
        joinable_now: false,
        status: "pending_request",
        next_action: { kind: "wait", reason_code: "membership_pending" },
      },
      {
        ...base,
        joinable_now: false,
        status: "gate_failed",
        failure_reason: "unsupported",
        next_action: { kind: "blocked", reason: "gate_failed" },
      },
      {
        ...base,
        joinable_now: false,
        status: "already_joined",
        next_action: { kind: "none", reason: "already_joined" },
      },
    ]) {
      expect(decode(candidate).community).toBe("community-jazleeuw");
    }
  });

  test("rejects legacy provider aliases, claim-shaped capabilities, and free-form waits", () => {
    const decode = Schema.decodeUnknownSync(GetJoinEligibility.response);
    const valid = {
      ...base,
      joinable_now: false,
      status: "verification_required",
      missing_capabilities: ["human_verification"],
      next_action: {
        kind: "start_verification",
        provider_id: "very.oauth",
        intent_id: "join-intent-1",
      },
    };
    for (const candidate of [
      { ...valid, next_action: { ...valid.next_action, provider_id: "very oauth" } },
      { ...valid, missing_capabilities: ["human.personhood"] },
      { ...valid, next_action: { kind: "wait", reason_code: "provider_said_later" } },
    ]) {
      expect(() => decode(candidate)).toThrow();
    }
  });
});
