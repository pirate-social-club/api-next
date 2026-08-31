import { describe, expect, test } from "bun:test";
import type { KaraokeRecognizedWord, ScorableKaraokeLine } from "../scoring";
import {
  deserializeKaraokeSessionSnapshot,
  KaraokeSnapshotValidationError,
  type StoredKaraokeSessionSnapshot,
  serializeKaraokeSessionSnapshot,
} from "../serialization";
import {
  createKaraokeSessionState,
  type KaraokeScoringPolicy,
  type KaraokeSessionEvent,
  type KaraokeSessionState,
  reduceKaraokeSession,
} from "../session";
import type { KaraokeSessionHostSnapshot } from "../session-host";

function line(
  lineId: string,
  scoredLineIndex: number,
  startMs: number,
  endMs: number,
  text: string,
): ScorableKaraokeLine {
  return {
    endMs,
    lineId,
    lineIndex: scoredLineIndex,
    scoredLineIndex,
    startMs,
    text,
    words: [{ endMs: startMs + 400, startMs, text: text.split(" ")[0] ?? "word" }],
  };
}

function word(
  text: string,
  startMs: number,
  endMs: number,
  confidence = 0.9,
): KaraokeRecognizedWord {
  return { confidence, endMs, final: true, startMs, text };
}

const LINES: ScorableKaraokeLine[] = [
  line("first", 0, 0, 1600, "old guitar"),
  line("second", 1, 2000, 3800, "catch fire"),
  line("third", 2, 4200, 5600, "hold on"),
];

const ENABLED_POLICY: KaraokeScoringPolicy = {
  kind: "enabled",
  model: "test-model",
  provider: "elevenlabs",
  retention: "not_stored",
};

const BASE_STATE: KaraokeSessionState = createKaraokeSessionState({
  attemptId: "attempt-1",
  lines: LINES,
  scoringPolicy: ENABLED_POLICY,
  sessionId: "session-1",
});

function snapshotWith(
  state: KaraokeSessionState,
  lastClientSequence = 0,
  lastSttSequence = 0,
  serverSequence = 0,
): KaraokeSessionHostSnapshot & { serverSequence: number } {
  return { lastClientSequence, lastSttSequence, serverSequence, state };
}

describe("karaoke-runtime serialization", () => {
  test("round-trips a disabled policy", () => {
    const state: KaraokeSessionState = { ...BASE_STATE, scoringPolicy: { kind: "disabled" } };
    const snap = snapshotWith(state);
    const stored = serializeKaraokeSessionSnapshot(snap);
    const json = JSON.stringify(stored);
    const restored = deserializeKaraokeSessionSnapshot(JSON.parse(json));
    expect(restored.state.scoringPolicy).toEqual({ kind: "disabled" });
  });

  test("round-trips an enabled policy with and without voiceCoachEnabled", () => {
    const withCoach: KaraokeSessionState = {
      ...BASE_STATE,
      scoringPolicy: { ...ENABLED_POLICY, voiceCoachEnabled: true },
    };
    const restored = deserializeKaraokeSessionSnapshot(
      JSON.parse(JSON.stringify(serializeKaraokeSessionSnapshot(snapshotWith(withCoach)))),
    );
    expect(restored.state.scoringPolicy).toEqual({ ...ENABLED_POLICY, voiceCoachEnabled: true });

    const withoutCoach = deserializeKaraokeSessionSnapshot(
      JSON.parse(JSON.stringify(serializeKaraokeSessionSnapshot(snapshotWith(BASE_STATE)))),
    );
    expect(withoutCoach.state.scoringPolicy).toEqual(ENABLED_POLICY);
  });

  test("round-trips an honest stored provider-retention fact", () => {
    const storedPolicy: KaraokeScoringPolicy = { ...ENABLED_POLICY, retention: "stored" };
    const state: KaraokeSessionState = { ...BASE_STATE, scoringPolicy: storedPolicy };
    const restored = deserializeKaraokeSessionSnapshot(
      JSON.parse(JSON.stringify(serializeKaraokeSessionSnapshot(snapshotWith(state)))),
    );
    expect(restored.state.scoringPolicy).toEqual(storedPolicy);
  });

  test("round-trips every session status", () => {
    const statuses: KaraokeSessionState["status"][] = [
      "idle",
      "recording",
      "paused",
      "finalizing",
      "finalized",
      "aborted",
    ];
    for (const status of statuses) {
      const state: KaraokeSessionState = { ...BASE_STATE, status };
      const restored = deserializeKaraokeSessionSnapshot(
        JSON.parse(JSON.stringify(serializeKaraokeSessionSnapshot(snapshotWith(state)))),
      );
      expect(restored.state.status).toBe(status);
    }
  });

  test("normalizes duplicate locks into a Set", () => {
    const state: KaraokeSessionState = {
      ...BASE_STATE,
      assignmentLocks: new Set(["a", "b", "a", "c", "b"]),
    };
    const stored = serializeKaraokeSessionSnapshot(snapshotWith(state));
    expect(stored.state.assignmentLocks).toEqual(["a", "b", "c"]);
    const restored = deserializeKaraokeSessionSnapshot(JSON.parse(JSON.stringify(stored)));
    expect([...restored.state.assignmentLocks].sort()).toEqual(["a", "b", "c"]);
  });

  test("round-trips recognized words and finalized line scores", () => {
    const state: KaraokeSessionState = {
      ...BASE_STATE,
      currentTimeMs: 1800,
      recognizedWords: [word("old", 0, 450), word("guitar", 620, 1300)],
      // STT coverage past the first line (endMs 1600) so the watermark gate
      // permits finalization on the stt_final below.
      sttWatermarkMs: 2000,
    };
    const event: KaraokeSessionEvent = {
      type: "stt_final",
      words: [...state.recognizedWords],
    };
    const reduced = reduceKaraokeSession(state, event);
    const snap = snapshotWith(reduced.state, 2, 1);
    const restored = deserializeKaraokeSessionSnapshot(
      JSON.parse(JSON.stringify(serializeKaraokeSessionSnapshot(snap))),
    );
    expect(restored.state.recognizedWords).toHaveLength(2);
    expect(restored.state.finalizedLineScores).toHaveLength(1);
    expect(restored.state.finalizedLineScores[0]?.lineId).toBe("first");
  });

  test("rejects malformed policy discriminator", () => {
    const broken: StoredKaraokeSessionSnapshot = {
      lastClientSequence: 0,
      lastSttSequence: 0,
      serverSequence: 0,
      state: {
        ...BASE_STATE,
        assignmentLocks: [],
        scoringPolicy: { kind: "weird" as unknown as "disabled" },
      },
    };
    expect(() => deserializeKaraokeSessionSnapshot(broken)).toThrow(KaraokeSnapshotValidationError);
  });

  test("rejects unknown status", () => {
    const broken = {
      lastClientSequence: 0,
      lastSttSequence: 0,
      serverSequence: 0,
      state: { ...BASE_STATE, assignmentLocks: [], status: "napping" },
    };
    expect(() => deserializeKaraokeSessionSnapshot(broken)).toThrow(KaraokeSnapshotValidationError);
  });

  test("rejects negative sequence values", () => {
    const broken = {
      lastClientSequence: -1,
      lastSttSequence: 0,
      serverSequence: 0,
      state: { ...BASE_STATE, assignmentLocks: [] },
    };
    expect(() => deserializeKaraokeSessionSnapshot(broken)).toThrow(KaraokeSnapshotValidationError);
  });

  test("rejects locks that are not a string array", () => {
    const broken = {
      lastClientSequence: 0,
      lastSttSequence: 0,
      serverSequence: 0,
      state: { ...BASE_STATE, assignmentLocks: "first" },
    };
    expect(() => deserializeKaraokeSessionSnapshot(broken)).toThrow(KaraokeSnapshotValidationError);
  });

  test("rejects finalized line scores that reference unknown lineIds", () => {
    const broken = {
      lastClientSequence: 0,
      lastSttSequence: 0,
      serverSequence: 0,
      state: {
        ...BASE_STATE,
        assignmentLocks: [],
        finalizedLineScores: [
          {
            confidenceScore: null,
            finalizedReason: "line_end",
            lineId: "nonexistent",
            lineIndex: 0,
            recognizedWords: [],
            score: 1,
            scoredLineIndex: 0,
            textScore: {
              confidenceMean: null,
              keywordCoverage: 1,
              missedWords: [],
              phoneticAvailable: true,
              phoneticCoverage: 1,
              phoneticQuality: 1,
              score: 1,
              wer: 0,
            },
            timingScore: null,
            transcript: "",
          },
        ],
      },
    };
    expect(() => deserializeKaraokeSessionSnapshot(broken)).toThrow(KaraokeSnapshotValidationError);
  });

  const PENDING_COMMIT = {
    commitId: "commit-1",
    frontierMs: 1600,
    lineIds: ["first"],
    requestedAtEpochMs: 1_800_000_000_000,
    streamGeneration: "gen-abc",
  };

  test("round-trips pendingCommit and sttWatermarkMs", () => {
    const state: KaraokeSessionState = {
      ...BASE_STATE,
      pendingCommit: { ...PENDING_COMMIT },
      sttWatermarkMs: 1600,
    };
    const restored = deserializeKaraokeSessionSnapshot(
      JSON.parse(JSON.stringify(serializeKaraokeSessionSnapshot(snapshotWith(state)))),
    );
    expect(restored.state.pendingCommit).toEqual(PENDING_COMMIT);
    expect(restored.state.sttWatermarkMs).toBe(1600);
  });

  test("defaults missing pendingCommit and sttWatermarkMs (legacy snapshot)", () => {
    const json = JSON.parse(
      JSON.stringify(serializeKaraokeSessionSnapshot(snapshotWith(BASE_STATE))),
    );
    delete json.state.pendingCommit;
    delete json.state.sttWatermarkMs;
    const restored = deserializeKaraokeSessionSnapshot(json);
    expect(restored.state.pendingCommit).toBeNull();
    expect(restored.state.sttWatermarkMs).toBe(0);
  });

  test("rejects present-but-malformed pendingCommit instead of silently dropping it", () => {
    const cases: unknown[] = [
      { ...PENDING_COMMIT, commitId: "" },
      { ...PENDING_COMMIT, streamGeneration: 1 },
      { ...PENDING_COMMIT, frontierMs: -1 },
      { ...PENDING_COMMIT, frontierMs: 1.5 },
      { ...PENDING_COMMIT, requestedAtEpochMs: "soon" },
      { ...PENDING_COMMIT, lineIds: [] },
      { ...PENDING_COMMIT, lineIds: ["unknown-line"] },
      { ...PENDING_COMMIT, lineIds: ["first", "first"] },
    ];
    for (const pendingCommit of cases) {
      const json = JSON.parse(
        JSON.stringify(serializeKaraokeSessionSnapshot(snapshotWith(BASE_STATE))),
      );
      json.state.pendingCommit = pendingCommit;
      expect(() => deserializeKaraokeSessionSnapshot(json)).toThrow(KaraokeSnapshotValidationError);
    }
  });

  test("rejects present-but-invalid sttWatermarkMs", () => {
    for (const value of [-5, 2.5, "100", Number.NaN]) {
      const json = JSON.parse(
        JSON.stringify(serializeKaraokeSessionSnapshot(snapshotWith(BASE_STATE))),
      );
      json.state.sttWatermarkMs = value;
      expect(() => deserializeKaraokeSessionSnapshot(json)).toThrow(KaraokeSnapshotValidationError);
    }
  });

  test("rehydrated reducer behavior matches a fresh run (keystone test)", () => {
    const initial = BASE_STATE;

    const firstHalfScript = [
      { type: "start" as const, audioTimeMs: 0 },
      {
        type: "stt_final" as const,
        audioTimeMs: 1800,
        words: [word("old", 0, 450), word("guitar", 620, 1300)],
      },
    ];

    const secondHalfScript = [
      { type: "playback_sync" as const, audioTimeMs: 2500, playing: true },
      {
        type: "stt_final" as const,
        audioTimeMs: 3200,
        words: [word("catch", 2000, 2500), word("fire", 2600, 3100)],
      },
      { type: "finish" as const, audioTimeMs: 6000 },
    ];

    let direct = initial;
    for (const event of [...firstHalfScript, ...secondHalfScript]) {
      direct = reduceKaraokeSession(direct, event).state;
    }

    let rehydrated: KaraokeSessionState = initial;
    for (const event of firstHalfScript) {
      rehydrated = reduceKaraokeSession(rehydrated, event).state;
    }
    const snap = snapshotWith(rehydrated, 2, 1, 7);
    const json = JSON.stringify(serializeKaraokeSessionSnapshot(snap));
    const restored = deserializeKaraokeSessionSnapshot(JSON.parse(json));
    rehydrated = restored.state;
    for (const event of secondHalfScript) {
      rehydrated = reduceKaraokeSession(rehydrated, event).state;
    }

    expect(rehydrated.status).toBe(direct.status);
    expect(rehydrated.summary?.lineCount).toBe(direct.summary?.lineCount);
    expect(rehydrated.summary?.scoredLineCount).toBe(direct.summary?.scoredLineCount);
    expect(rehydrated.summary?.finalScore).toBe(direct.summary?.finalScore);
    expect(rehydrated.summary?.missedWords).toEqual(direct.summary?.missedWords);
    expect(restored.lastClientSequence).toBe(2);
    expect(restored.lastSttSequence).toBe(1);
    expect(restored.serverSequence).toBe(7);
  });

  test("defaults a legacy snapshot with no uncertainLineCount to 0", () => {
    let state: KaraokeSessionState = BASE_STATE;
    for (const event of [
      { type: "start" as const, audioTimeMs: 0 },
      {
        type: "stt_final" as const,
        audioTimeMs: 1800,
        words: [word("old", 0, 450), word("guitar", 620, 1300)],
      },
      { type: "finish" as const, audioTimeMs: 6000 },
    ]) {
      state = reduceKaraokeSession(state, event).state;
    }
    expect(state.summary).not.toBeNull();

    const json = JSON.parse(JSON.stringify(serializeKaraokeSessionSnapshot(snapshotWith(state))));
    // Snapshots written before the field existed simply won't carry it.
    expect(json.state.summary.uncertainLineCount).toBeDefined();
    delete json.state.summary.uncertainLineCount;

    const restored = deserializeKaraokeSessionSnapshot(json);
    expect(restored.state.summary?.uncertainLineCount).toBe(0);
  });
});
