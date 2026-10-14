import { describe, expect, test } from "bun:test";
import { projectPracticePreparedGuestStudyContentV2 } from "./guest-practice-prepared-v2.ts";
import {
  type GuestStudyManagedBindings,
  makeDefaultOwnerNativeGuestStudyManagedRuntime,
  makeDefaultOwnerRewardGuestStudyManagedRuntime,
  ownerFinancialGuestStudySelected,
} from "./guest-study-managed-bindings.ts";

describe("Financial Guest selector retains inert and practice authority", () => {
  test("financial admission cannot be inferred from learning and refuses production before binding reads", () => {
    let reads = 0;
    const closed = (): never => {
      reads++;
      throw new Error("inert selector touched managed binding");
    };
    const bindings: GuestStudyManagedBindings = {
      GUEST_STUDY_SERVING_ENABLED: "true",
      get GUEST_STUDY_PUBLIC_READ() {
        return closed();
      },
      get GUEST_STUDY_CONTROLLED_LEARNING() {
        return closed();
      },
      get GUEST_STUDY_CRON() {
        return closed();
      },
      get GUEST_STUDY_READINESS_OBSERVER() {
        return closed();
      },
      get LEARNER_AUDIO() {
        return closed();
      },
      get ELEVENLABS_API_KEY() {
        return closed();
      },
      get GUEST_STUDY_PRODUCT_ORIGIN() {
        return closed();
      },
    };
    expect(ownerFinancialGuestStudySelected(bindings, "staging")).toBe(false);
    expect(makeDefaultOwnerRewardGuestStudyManagedRuntime(bindings, "staging")).toBeNull();
    expect(
      ownerFinancialGuestStudySelected(
        { GUEST_STUDY_SERVING_ENABLED: "true", GUEST_STUDY_REWARDS_ENABLED: "false" },
        "staging",
      ),
    ).toBe(false);
    expect(() =>
      ownerFinancialGuestStudySelected(
        { GUEST_STUDY_SERVING_ENABLED: "false", GUEST_STUDY_REWARDS_ENABLED: "true" },
        "staging",
      ),
    ).toThrow("learning");
    for (const environment of ["production", "prod", "unknown"])
      expect(() =>
        ownerFinancialGuestStudySelected(
          { GUEST_STUDY_SERVING_ENABLED: "true", GUEST_STUDY_REWARDS_ENABLED: "true" },
          environment,
        ),
      ).toThrow("nonproduction");
    expect(() =>
      ownerFinancialGuestStudySelected(
        { GUEST_STUDY_SERVING_ENABLED: "true", GUEST_STUDY_REWARDS_ENABLED: "TRUE" },
        "staging",
      ),
    ).toThrow();
    expect(reads).toBe(0);
  });
  test("current native source factory retains learning with NEW rewards disabled and never reads the purchase policy", () => {
    let policyReads = 0;
    const bindings: GuestStudyManagedBindings = {
      GUEST_STUDY_SERVING_ENABLED: "true",
      GUEST_STUDY_REWARDS_ENABLED: "false",
      GUEST_STUDY_PRODUCT_ORIGIN: "https://community.example",
      LEARNER_AUDIO: { put: async () => ({ size: 0 }), delete: async () => {} },
      CONTROL_PLANE: { connectionString: "postgres://ordinary.invalid/db" },
      GUEST_STUDY_PUBLIC_READ: { connectionString: "postgres://public.invalid/db" },
      GUEST_STUDY_CONTROLLED_LEARNING: { connectionString: "postgres://learning.invalid/db" },
      GUEST_STUDY_CRON: { connectionString: "postgres://cron.invalid/db" },
      GUEST_STUDY_READINESS_OBSERVER: { connectionString: "postgres://observer.invalid/db" },
      get MEGAPOT_PURCHASE_SAFETY_MARGIN_SECONDS() {
        policyReads++;
        throw new Error("Disabled NEW rewards must not read purchase policy");
      },
    };
    const actual = makeDefaultOwnerNativeGuestStudyManagedRuntime(bindings, "test");
    expect(actual).not.toBeNull();
    expect(actual?.newRewardsEnabled).toBe(false);
    expect(actual?.purchaseSafetyMarginSeconds).toBeNull();
    expect(actual?.schema).toBe("api_next");
    expect(ownerFinancialGuestStudySelected(bindings, "test")).toBe(false);
    expect(policyReads).toBe(0);
    for (const environment of ["production", "prod", "unknown"])
      expect(() => makeDefaultOwnerNativeGuestStudyManagedRuntime(bindings, environment)).toThrow(
        "nonproduction",
      );
    expect(makeDefaultOwnerNativeGuestStudyManagedRuntime({}, "production")).toBeNull();
  });
  test("actual practice availability and disclosure surviveV2 without a reward/hash; nonnull rewards and private extras refuse", () => {
    const actual = {
      object: "guest_study_prepared_content_v1",
      availability: {
        state: "ready",
        available_exercise_types: ["say_it_back"],
        learning_language: "en",
        target_languages: ["es"],
        learner_bands: ["A1"],
      },
      disclosure: { version: "disclosure-v1", text: "Actual microphone disclosure" },
      reward_preview: null,
    } as const;
    const projected = projectPracticePreparedGuestStudyContentV2(actual);
    expect(projected.availability).toEqual(actual.availability);
    expect(projected.disclosure).toEqual(actual.disclosure);
    expect(projected.reward_preview).toBeNull();
    expect(projected.reward_preview_terms_hash).toBeNull();
    expect(projected.object).toBe("guest_study_prepared_content_v2");
    const terms = {
      offer_id: "offer-1",
      pool_leg_id: "leg-1",
      original_drawing_id: "7",
      community_id: "community-1",
      post_id: "post-1",
      audio_revision: 1,
      lyrics_revision: 1,
      qualification_policy_version_id: "study-v1",
      policy_hash: "a".repeat(64),
      terms_hash: "b".repeat(64),
      entry_cutoff_at: "2026-10-13T00:00:00.000Z",
      disclosure_version: "disclosure-v1",
    };
    expect(() =>
      projectPracticePreparedGuestStudyContentV2({ ...actual, reward_preview: terms }),
    ).toThrow();
    expect(() =>
      projectPracticePreparedGuestStudyContentV2({ ...actual, sourceOwnerId: "private-owner" }),
    ).toThrow();
  });
});
