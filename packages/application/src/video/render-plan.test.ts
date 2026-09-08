import { describe, expect, it } from "bun:test";

import {
  type AcceptedMasterRevision,
  type CanonicalSongReference,
  resolveSongVideoPolicyConfiguration,
  SONG_VIDEO_SAMPLE_RATE_HZ,
  type SongVideoOperationalPolicy,
  type SongVideoRenderAttempt,
  type SongVideoRenderPlan,
} from "@pirate/domain";

import {
  checkAcceptedMaster,
  checkIntentFields,
  checkRenderPlan,
  checkSongBinding,
  clipSamplesFromMs,
} from "./render-plan.ts";

const song: CanonicalSongReference = {
  songPostId: "post-song-1",
  audioRevision: 1,
  songAssetId: "asset-song-1",
  songDurationSamples: 180 * SONG_VIDEO_SAMPLE_RATE_HZ,
};

const plan: SongVideoRenderPlan = {
  planId: "plan-1",
  song,
  clipStartSamples: 30 * SONG_VIDEO_SAMPLE_RATE_HZ,
  clipDurationSamples: 15 * SONG_VIDEO_SAMPLE_RATE_HZ,
};

const attempt: SongVideoRenderAttempt = { attemptId: "attempt-1", planId: "plan-1", generation: 1 };

// Test-only values. These are fixture policy, not ratified defaults: U.5 and
// U.6 remain unresolved and nothing in the source supplies either.
const policy: SongVideoOperationalPolicy = {
  sourceOverrunDisposition: "reject_overrun",
  masterMaxBytes: 64 * 1024 * 1024,
};

const master: AcceptedMasterRevision = {
  masterRevisionId: "master-1",
  planId: "plan-1",
  attemptId: "attempt-1",
  claimedSourceSha256: "a".repeat(64),
  masterSha256: "b".repeat(64),
  masterByteLength: 12_000_000,
  decision: {
    clipStartSamples: plan.clipStartSamples,
    clipDurationSamples: plan.clipDurationSamples,
    rendererPolicyRevision: 1,
    rendererIdentity: "ffmpeg-7.1.5-0+deb13u1",
  },
};

describe("canonical containment", () => {
  it("accepts an interval inside the song, including one ending exactly at its end", () => {
    expect(checkRenderPlan(plan)).toMatchObject({ accepted: true });
    expect(
      checkRenderPlan({
        ...plan,
        clipStartSamples: song.songDurationSamples - plan.clipDurationSamples,
      }),
    ).toMatchObject({ accepted: true });
  });

  it("rejects a one-sample overrun", () => {
    expect(
      checkRenderPlan({
        ...plan,
        song: { ...song, songDurationSamples: song.songDurationSamples },
        clipStartSamples: song.songDurationSamples - plan.clipDurationSamples + 1,
      }),
    ).toEqual({ accepted: false, reason: "canonical_song_interval_uncovered" });
  });

  it("rejects degenerate and non-integer timelines", () => {
    expect(checkRenderPlan({ ...plan, clipDurationSamples: 0 })).toEqual({
      accepted: false,
      reason: "invalid_timeline",
    });
    expect(checkRenderPlan({ ...plan, clipStartSamples: -1 })).toEqual({
      accepted: false,
      reason: "invalid_timeline",
    });
    expect(checkRenderPlan({ ...plan, clipDurationSamples: 1.5 })).toEqual({
      accepted: false,
      reason: "invalid_timeline",
    });
  });

  it("converts exact millisecond intervals and refuses inexact ones", () => {
    expect(clipSamplesFromMs(1_000)).toBe(SONG_VIDEO_SAMPLE_RATE_HZ);
    expect(clipSamplesFromMs(0.001)).toBeNull();
    expect(clipSamplesFromMs(-1)).toBeNull();
  });
});

describe("intent field discipline", () => {
  it("rejects song fields on original audio", () => {
    expect(checkIntentFields({ intent: "original_audio", songReferencePresent: true })).toEqual({
      accepted: false,
      reason: "song_fields_not_permitted",
    });
  });

  it("requires a song reference for song reference intent", () => {
    expect(checkIntentFields({ intent: "song_reference", songReferencePresent: false })).toEqual({
      accepted: false,
      reason: "song_reference_required",
    });
  });

  it("accepts each variant carrying only its own fields", () => {
    expect(
      checkIntentFields({ intent: "original_audio", songReferencePresent: false }),
    ).toMatchObject({ accepted: true });
    expect(
      checkIntentFields({ intent: "song_reference", songReferencePresent: true }),
    ).toMatchObject({ accepted: true });
  });
});

describe("song binding", () => {
  it("accepts only the exact frozen reference", () => {
    expect(checkSongBinding({ frozen: song, observed: song })).toBe(true);
  });

  it("rejects a different song, revision, asset or probed duration", () => {
    expect(checkSongBinding({ frozen: song, observed: { ...song, songPostId: "other" } })).toBe(
      false,
    );
    expect(checkSongBinding({ frozen: song, observed: { ...song, audioRevision: 2 } })).toBe(false);
    expect(checkSongBinding({ frozen: song, observed: { ...song, songAssetId: "other" } })).toBe(
      false,
    );
    expect(checkSongBinding({ frozen: song, observed: { ...song, songDurationSamples: 1 } })).toBe(
      false,
    );
  });
});

describe("accepted master binding", () => {
  it("accepts a master carrying a verified source, the applied decision and a policy revision", () => {
    expect(checkAcceptedMaster({ plan, attempt, master, policy })).toEqual({
      accepted: true,
      masterRevisionId: "master-1",
    });
  });

  it("refuses a master bound to another plan or attempt", () => {
    expect(
      checkAcceptedMaster({ plan, attempt, master: { ...master, planId: "plan-2" }, policy }),
    ).toEqual({ accepted: false, reason: "plan_mismatch" });
    expect(
      checkAcceptedMaster({ plan, attempt, master: { ...master, attemptId: "attempt-2" }, policy }),
    ).toEqual({ accepted: false, reason: "attempt_mismatch" });
  });

  it("refuses a master with no source digest, so a plan cannot stand in for one", () => {
    expect(
      checkAcceptedMaster({
        plan,
        attempt,
        master: { ...master, claimedSourceSha256: "" },
        policy,
      }),
    ).toEqual({ accepted: false, reason: "malformed_source_digest" });
  });

  it("refuses a master whose identity was substituted for its source", () => {
    expect(
      checkAcceptedMaster({
        plan,
        attempt,
        master: { ...master, masterSha256: master.claimedSourceSha256 },
        policy,
      }),
    ).toEqual({ accepted: false, reason: "identity_substituted" });
  });

  it("refuses an incomplete render decision", () => {
    for (const decision of [
      { ...master.decision, rendererIdentity: "" },
      { ...master.decision, rendererPolicyRevision: -1 },
      { ...master.decision, clipDurationSamples: 0 },
    ]) {
      expect(
        checkAcceptedMaster({ plan, attempt, master: { ...master, decision }, policy }),
      ).toEqual({ accepted: false, reason: "incomplete_render_decision" });
    }
  });

  it("refuses a decision that does not match the frozen plan", () => {
    expect(
      checkAcceptedMaster({
        plan,
        attempt,
        master: {
          ...master,
          decision: { ...master.decision, clipStartSamples: plan.clipStartSamples + 1 },
        },
        policy,
      }),
    ).toEqual({ accepted: false, reason: "decision_does_not_match_plan" });
  });

  it("refuses a master outside the configured byte ceiling, which duration never implies", () => {
    expect(
      checkAcceptedMaster({
        plan,
        attempt,
        master: { ...master, masterByteLength: policy.masterMaxBytes + 1 },
        policy,
      }),
    ).toEqual({ accepted: false, reason: "master_exceeds_configured_ceiling" });
  });
});

describe("operational policy authority", () => {
  it("reports unavailable authority when neither unresolved value is configured", () => {
    expect(resolveSongVideoPolicyConfiguration(null)).toEqual({
      configured: false,
      missing: ["U.5", "U.6"],
    });
  });

  it("names exactly which gate is unconfigured rather than falling back", () => {
    expect(
      resolveSongVideoPolicyConfiguration({ sourceOverrunDisposition: "reject_overrun" }),
    ).toEqual({
      configured: false,
      missing: ["U.6"],
    });
    expect(resolveSongVideoPolicyConfiguration({ masterMaxBytes: 1 })).toEqual({
      configured: false,
      missing: ["U.5"],
    });
  });

  it("rejects a nonsensical ceiling instead of treating it as permission", () => {
    expect(
      resolveSongVideoPolicyConfiguration({
        sourceOverrunDisposition: "reject_overrun",
        masterMaxBytes: 0,
      }),
    ).toEqual({ configured: false, missing: ["U.6"] });
  });

  it("becomes available only when both values are explicitly configured", () => {
    expect(resolveSongVideoPolicyConfiguration(policy)).toEqual({ configured: true, policy });
  });
});

describe("acceptance revalidates its own prerequisites", () => {
  it("refuses malformed digests rather than accepting any nonempty string", () => {
    expect(
      checkAcceptedMaster({
        plan,
        attempt,
        policy,
        master: { ...master, claimedSourceSha256: "x", masterSha256: "y" },
      }),
    ).toEqual({ accepted: false, reason: "malformed_source_digest" });
    expect(
      checkAcceptedMaster({ plan, attempt, policy, master: { ...master, masterSha256: "y" } }),
    ).toEqual({ accepted: false, reason: "malformed_master_digest" });
  });

  it("refuses an unconfigured ceiling instead of comparing against it", () => {
    for (const masterMaxBytes of [Number.NaN, 0, -1, 1.5]) {
      expect(
        checkAcceptedMaster({ plan, attempt, master, policy: { ...policy, masterMaxBytes } }),
      ).toEqual({ accepted: false, reason: "policy_not_configured" });
    }
  });

  it("refuses a plan whose interval is not contained, without relying on a prior check", () => {
    const uncontained = {
      ...plan,
      clipStartSamples: song.songDurationSamples,
      clipDurationSamples: 5 * SONG_VIDEO_SAMPLE_RATE_HZ,
    };
    expect(
      checkAcceptedMaster({
        plan: uncontained,
        attempt,
        policy,
        master: {
          ...master,
          decision: {
            ...master.decision,
            clipStartSamples: uncontained.clipStartSamples,
            clipDurationSamples: uncontained.clipDurationSamples,
          },
        },
      }),
    ).toEqual({ accepted: false, reason: "plan_not_containable" });
  });

  it("treats a well-formed source digest as a claim, not as proof of verification", () => {
    // Structural acceptance says the record is well formed. Establishing that
    // this digest is the sealed source's digest belongs to the persistence
    // adapter, and nothing in this result asserts it happened.
    const accepted = checkAcceptedMaster({ plan, attempt, master, policy });
    expect(accepted).toEqual({ accepted: true, masterRevisionId: "master-1" });
    expect(Object.keys(accepted)).not.toContain("sourceVerified");
  });
});
