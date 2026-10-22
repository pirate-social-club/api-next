import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { moderatedDanceIntakeFacts } from "../../../../testing/src/moderated-dance-intake-fixture.ts";
import { prepareModeratedDancePolicyPublication } from "./moderated-policy.ts";

const draft = () => {
  const f = moderatedDanceIntakeFacts();
  return {
    version: "dance-moderated-policy-publication-v1",
    policy_id: "test-policy",
    community_id: f.communityId,
    policy: f.policy,
    profile: f.profile,
    disposition: f.disposition,
    safety_policy: f.safetyPolicy,
    disclosure: {
      version: "dance-moderated-disclosure-v1",
      consent_text: "Test private recording consent",
      retention_text: "Test finite private retention",
      publication_text: "Test optional independent Post",
      owner_rubric_text: "Test owner inspects the assigned cue and selected dance",
    },
    valid_from: "1970-01-01T00:00:01.000Z",
    valid_until: "1970-01-01T01:00:00.000Z",
    accepted_by: "test-operator",
    acceptance_ref: "test-only-no-activation",
    acceptance_hash: "a".repeat(64),
    producer_registration: {
      status: "reserved",
      acceptance_ref: "test-producer-no-activation",
      acceptance_hash: "b".repeat(64),
    },
  };
};
describe("moderated policy publication preparation (no runtime acceptance)", () => {
  test("hashes real disclosure/retention/safety/normalization bytes without selecting profile values", async () => {
    const input = draft(),
      prepared = await Effect.runPromise(prepareModeratedDancePolicyPublication(input));
    expect(prepared.profile).toEqual(input.profile);
    expect(prepared.policy.qualificationHash).toBe(
      prepared.qualification_policy_document.policy_hash,
    );
    expect(prepared.qualification_policy_document.score_bps).toBeNull();
    expect(prepared.policy.retentionHash).toBe(prepared.disposition.hash);
    expect(prepared.policy.hash).not.toBe(input.policy.hash);
    expect(await Effect.runPromise(prepareModeratedDancePolicyPublication(prepared))).toEqual(
      prepared,
    );
    const changed = await Effect.runPromise(
      prepareModeratedDancePolicyPublication({
        ...input,
        disclosure: { ...input.disclosure, consent_text: "Different test consent" },
      }),
    );
    expect(changed.policy.consentHash).not.toBe(prepared.policy.consentHash);
    expect(changed.policy.hash).not.toBe(prepared.policy.hash);
  });
  test("missing limits, missing hold authority or invalid windows cannot provision intake", async () => {
    const input = draft();
    for (const invalid of [
      { ...input, profile: { ...input.profile, maximumProviderCalls: undefined } },
      { ...input, disposition: { ...input.disposition, hold: null } },
      { ...input, valid_until: input.valid_from },
    ])
      await expect(
        Effect.runPromise(prepareModeratedDancePolicyPublication(invalid)),
      ).rejects.toBeDefined();
  });
});
