import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import {
  moderatedDanceIntakeFacts,
  noPoseModeratedDanceIntakeFacts,
} from "../../../../testing/src/moderated-dance-intake-fixture.ts";
import {
  ModeratedDanceIntakeProfile,
  prepareModeratedDanceTerms,
  selectModeratedDanceCue,
} from "./moderated-intake.ts";

const ids = { sessionId: "session", reviewId: "review", attemptId: "attempt" };
describe("moderated capture terms", () => {
  test("freezes cue and all objectives before consent, has an acyclic canonical identity", async () => {
    const f = moderatedDanceIntakeFacts();
    const a = await Effect.runPromise(prepareModeratedDanceTerms(f, ids, "hands_on_head"));
    expect(a.capture.bodyStartMs).toBe(2000);
    expect(a.capture.bodyEndMs).toBe(12000);
    expect(a.capture.cueEndMs).toBeLessThanOrEqual(a.capture.bodyStartMs);
    expect(a.capture.objectives).toEqual([]);
    expect(a.capture.rewardMode).toBe("practice");
    expect(a.capture.termsHash).toBe(a.terms_hash);
    expect(await Effect.runPromise(prepareModeratedDanceTerms(f, ids, "hands_on_head"))).toEqual(a);
    expect(
      (await Effect.runPromise(prepareModeratedDanceTerms(f, ids, "arms_t"))).terms_hash,
    ).not.toBe(a.terms_hash);
    expect(JSON.stringify(a)).not.toContain("sourceDigest");
  });
  test("a current money-admitted song pot freezes its exact objectives", async () => {
    const f = moderatedDanceIntakeFacts();
    const objective = {
      id: "leg",
      version: "v2",
      termsHash: "a".repeat(64),
      fundingPolicyHash: "b".repeat(64),
      gradingMode: "moderator_verdict" as const,
    };
    const a = await Effect.runPromise(
      prepareModeratedDanceTerms(
        { ...f, policy: { ...f.policy, admission: "money_admitted" }, objectives: [objective] },
        ids,
        "arms_t",
      ),
    );
    expect(a.capture.rewardMode).toBe("reward_eligible");
    expect(a.capture.objectives).toEqual([objective]);
    await expect(
      Effect.runPromise(
        prepareModeratedDanceTerms({ ...f, objectives: [objective] }, ids, "arms_t"),
      ),
    ).rejects.toBeDefined();
  });
  test("no unbounded profile, cue/body overlap or adapter-selected duration", async () => {
    const f = moderatedDanceIntakeFacts();
    for (const profile of [
      { ...f.profile, maximumProviderCalls: 0 },
      { ...f.profile, maximumReadsPerWindow: null },
      { ...f.profile, cueEndMs: 2001 },
      { ...f.profile, presignTtlSeconds: 61 },
      { ...f.profile, replayRetentionMs: undefined },
    ])
      expect(() => Schema.decodeUnknownSync(ModeratedDanceIntakeProfile)(profile)).toThrow();
    for (const bodyDurationMs of [5999, 30001])
      await expect(
        Effect.runPromise(
          prepareModeratedDanceTerms({ ...f, bodyDurationMs }, ids, "hands_on_hips"),
        ),
      ).rejects.toBeDefined();
  });
  test("disposition authority must outlast the latest upload, seven-day review and captured cleanup", async () => {
    const f = moderatedDanceIntakeFacts();
    const last =
      f.nowMs +
      f.profile.sessionTtlMs +
      f.policy.reviewWindowMs +
      Math.max(
        f.disposition.cleanupWithinMs,
        f.disposition.temporaryCleanupWithinMs,
        f.disposition.transferWithinMs,
      );
    for (const disposition of [
      { ...f.disposition, validUntilMs: last - 1 },
      { ...f.disposition, hold: { ...f.disposition.hold, disposeByMs: last - 1 } },
    ])
      await expect(
        Effect.runPromise(prepareModeratedDanceTerms({ ...f, disposition }, ids, "arms_t")),
      ).rejects.toThrow("Captured safety/disposition authority unavailable");
    await expect(
      Effect.runPromise(
        prepareModeratedDanceTerms(
          {
            ...f,
            disposition: {
              ...f.disposition,
              validUntilMs: last,
              hold: { ...f.disposition.hold, disposeByMs: last },
            },
          },
          ids,
          "arms_t",
        ),
      ),
    ).resolves.toHaveProperty("terms_hash");
  });
  test("cue selection uses all three choices with unbiased rejection, not a browser cue", () => {
    expect([0, 1, 2].map((n) => selectModeratedDanceCue(() => n))).toEqual([
      "hands_on_head",
      "arms_t",
      "hands_on_hips",
    ]);
    let reads = 0;
    expect(selectModeratedDanceCue(() => (++reads === 1 ? 0xffffffff : 1))).toBe("arms_t");
    expect(reads).toBe(2);
    expect(() => selectModeratedDanceCue(() => -1)).toThrow();
    expect(() => selectModeratedDanceCue(() => 0xffffffff)).toThrow();
  });
});

describe("prospective no-pose capture", () => {
  test.each([false, true])(
    "starts immediately and freezes funded=%s objectives without a pose",
    async (funded) => {
      const f = noPoseModeratedDanceIntakeFacts();
      const objective = {
        id: "leg",
        version: "no-pose-v2",
        termsHash: "a".repeat(64),
        fundingPolicyHash: "b".repeat(64),
        gradingMode: "moderator_verdict" as const,
      };
      const terms = await Effect.runPromise(
        prepareModeratedDanceTerms(
          {
            ...f,
            policy: { ...f.policy, admission: funded ? "money_admitted" : "streak_admitted" },
            objectives: funded ? [objective] : [],
          },
          ids,
          "none",
        ),
      );
      expect(terms.version).toBe("dance-moderated-capture-terms-v2");
      expect(terms.capture.cueId).toBe("none");
      expect([
        terms.capture.bodyStartMs,
        terms.capture.cueStartMs,
        terms.capture.cueEndMs,
        terms.capture.cueHoldMs,
      ]).toEqual([0, 0, 0, 0]);
      expect(terms.capture.bodyEndMs).toBe(f.bodyDurationMs);
      expect(terms.capture.objectives).toEqual(funded ? [objective] : []);
      expect(terms.capture.rewardMode).toBe(funded ? "reward_eligible" : "practice");
    },
  );
  test("rejects mixed policy/profile modes, a disguised cue and any pre-roll", async () => {
    const f = noPoseModeratedDanceIntakeFacts(),
      old = moderatedDanceIntakeFacts();
    for (const facts of [
      { ...f, profile: old.profile },
      { ...old, profile: f.profile },
      { ...f, profile: { ...f.profile, bodyStartMs: 1 } },
      { ...f, profile: { ...f.profile, cueHoldMs: 1 } },
    ])
      await expect(
        Effect.runPromise(prepareModeratedDanceTerms(facts, ids, "none")),
      ).rejects.toBeDefined();
    await expect(
      Effect.runPromise(prepareModeratedDanceTerms(f, ids, "arms_t")),
    ).rejects.toBeDefined();
    await expect(
      Effect.runPromise(prepareModeratedDanceTerms(old, ids, "none")),
    ).rejects.toBeDefined();
  });
});
