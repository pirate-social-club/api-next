import { describe, expect, test } from "bun:test";
import type { KaraokeRecognizedWord, ScorableKaraokeLine } from "../scoring";
import {
  createKaraokeSessionState,
  type KaraokePendingCommit,
  type KaraokeScoringPolicy,
  type KaraokeSessionEvent,
  type KaraokeSessionState,
  reduceKaraokeSession,
} from "../session";

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

function word(text: string, startMs: number, endMs: number): KaraokeRecognizedWord {
  return { confidence: 0.95, endMs, final: true, startMs, text };
}

const LINES: ScorableKaraokeLine[] = [
  line("l1", 0, 0, 1000, "hold on"),
  line("l2", 1, 1200, 2200, "almost home"),
];
const ENABLED: KaraokeScoringPolicy = {
  kind: "enabled",
  model: "m",
  provider: "elevenlabs",
  retention: "not_stored",
};
const L1_WORDS = [word("hold", 0, 400), word("on", 500, 900)];

function baseState(overrides: Partial<KaraokeSessionState> = {}): KaraokeSessionState {
  return {
    ...createKaraokeSessionState({
      attemptId: "a",
      lines: LINES,
      scoringPolicy: ENABLED,
      sessionId: "s",
    }),
    status: "recording",
    ...overrides,
  };
}

function pending(overrides: Partial<KaraokePendingCommit> = {}): KaraokePendingCommit {
  return {
    commitId: "c1",
    frontierMs: 1000,
    lineIds: ["l1"],
    requestedAtEpochMs: 1_800_000_000_000,
    streamGeneration: "g1",
    ...overrides,
  };
}

const reduce = reduceKaraokeSession;
const sttFinal = (
  extra: Partial<Extract<KaraokeSessionEvent, { type: "stt_final" }>>,
): KaraokeSessionEvent => ({
  type: "stt_final",
  words: [],
  ...extra,
});

describe("karaoke reducer watermark second gate", () => {
  test("playback alone cannot finalize before watermark coverage", () => {
    const r = reduce(
      baseState({ currentTimeMs: 0, recognizedWords: L1_WORDS, sttWatermarkMs: 0 }),
      {
        audioTimeMs: 1100, // past l1.endMs (1000) but watermark=0 and grace not elapsed
        playing: true,
        type: "playback_sync",
      },
    );
    expect(r.state.finalizedLineScores).toHaveLength(0);
    expect(r.effects.some((e) => e.type === "request_stt_commit")).toBe(true);
  });

  test("matching commitId and streamGeneration advances watermark and clears pending", () => {
    const r = reduce(
      baseState({
        currentTimeMs: 1100,
        pendingCommit: pending(),
        recognizedWords: L1_WORDS,
        sttWatermarkMs: 0,
      }),
      sttFinal({ commitId: "c1", coverageMs: 1000, streamGeneration: "g1", words: L1_WORDS }),
    );
    expect(r.state.sttWatermarkMs).toBe(1000);
    expect(r.state.pendingCommit).toBeNull();
    expect(r.state.finalizedLineScores).toHaveLength(1);
    expect(r.state.finalizedLineScores[0]?.finalizedReason).toBe("asr_final");
  });

  test("stale acknowledgements neither mutate the watermark nor merge stale words", () => {
    const r = reduce(
      baseState({
        pendingCommit: pending({ streamGeneration: "g2" }),
        recognizedWords: [],
        sttWatermarkMs: 0,
      }),
      sttFinal({ commitId: "cX", streamGeneration: "g1", words: [word("ghost", 0, 400)] }), // g1 != pending g2
    );
    expect(r.state.sttWatermarkMs).toBe(0);
    expect(r.state.recognizedWords).toHaveLength(0);
    expect(r.state.pendingCommit).not.toBeNull();
  });

  test("a commit-tagged final not matching the pending pair is dropped entirely", () => {
    // Same generation, wrong commitId.
    const wrongId = reduce(
      baseState({
        pendingCommit: pending({ commitId: "c1", streamGeneration: "g1" }),
        recognizedWords: [],
        sttWatermarkMs: 0,
      }),
      sttFinal({ commitId: "c-old", streamGeneration: "g1", words: [word("ghost", 0, 400)] }),
    );
    expect(wrongId.state.recognizedWords).toHaveLength(0); // not merged
    expect(wrongId.state.sttWatermarkMs).toBe(0);
    expect(wrongId.state.pendingCommit).not.toBeNull();

    // Commit metadata present but no pending commit at all (e.g. duplicate ack).
    const noPending = reduce(
      baseState({ pendingCommit: null, sttWatermarkMs: 0 }),
      sttFinal({
        commitId: "cX",
        coverageMs: 5000,
        streamGeneration: "gX",
        words: [word("ghost", 0, 400)],
      }),
    );
    expect(noPending.state.recognizedWords).toHaveLength(0);
    expect(noPending.state.sttWatermarkMs).toBe(0);
  });

  test("playback_sync does not revert the finalizing state", () => {
    const finishing = reduce(baseState({ pendingCommit: pending() }), {
      audioTimeMs: 3000,
      type: "finish",
    }).state;
    expect(finishing.status).toBe("finalizing");
    const r = reduce(finishing, { audioTimeMs: 3100, playing: true, type: "playback_sync" });
    expect(r.state.status).toBe("finalizing");
  });

  test("uncorrelated finals (no commit metadata) merge current-stream words but never advance the watermark", () => {
    const noMeta = reduce(
      baseState({ sttWatermarkMs: 0 }),
      sttFinal({ words: [word("hold", 0, 400)] }),
    );
    expect(noMeta.state.recognizedWords).toHaveLength(1);
    expect(noMeta.state.sttWatermarkMs).toBe(0);
  });

  test("grace finalization uses song-time; a paused clock does not finalize", () => {
    const grace = reduce(baseState({ recognizedWords: L1_WORDS, sttWatermarkMs: 0 }), {
      audioTimeMs: 3100, // 2100ms past l1.endMs >= 2000ms grace
      playing: true,
      type: "playback_sync",
    });
    expect(grace.state.finalizedLineScores).toHaveLength(1);
    expect(grace.state.finalizedLineScores[0]?.finalizedReason).toBe("timeout");

    // Paused: not playing → finalization (and the grace clock) is frozen.
    const paused = reduce(baseState({ recognizedWords: L1_WORDS, sttWatermarkMs: 0 }), {
      audioTimeMs: 5000,
      playing: false,
      type: "playback_sync",
    });
    expect(paused.state.finalizedLineScores).toHaveLength(0);
  });

  test("commit_failed preserves distinct timeout and provider_failed reasons", () => {
    const fail = (reason: "timeout" | "provider_failed") =>
      reduce(baseState({ pendingCommit: pending(), recognizedWords: L1_WORDS }), {
        commitId: "c1",
        reason,
        streamGeneration: "g1",
        type: "commit_failed",
      });

    const timeout = fail("timeout").state.finalizedLineScores[0];
    expect(timeout?.finalizedReason).toBe("timeout");
    expect(timeout?.uncertain).toBe(false);

    const providerFailed = fail("provider_failed").state.finalizedLineScores[0];
    expect(providerFailed?.finalizedReason).toBe("provider_failed");
    expect(providerFailed?.uncertain).toBe(true);
  });

  test("uncertain means measurement uncertainty, not poor performance (excluded from score)", () => {
    // l1 finalized normally (sung); l2 provider_failed (uncertain). The summary
    // score must reflect only the measured line, not the infrastructure failure.
    let state = baseState({
      currentTimeMs: 1100,
      pendingCommit: pending(),
      recognizedWords: L1_WORDS,
      sttWatermarkMs: 0,
    });
    state = reduce(
      state,
      sttFinal({ commitId: "c1", coverageMs: 1000, streamGeneration: "g1", words: L1_WORDS }),
    ).state;
    state = {
      ...state,
      pendingCommit: pending({ commitId: "c2", frontierMs: 2200, lineIds: ["l2"] }),
    };
    state = reduce(state, {
      commitId: "c2",
      reason: "provider_failed",
      streamGeneration: "g1",
      type: "commit_failed",
    }).state;

    const l1Score = state.finalizedLineScores.find((s) => s.lineId === "l1")!;
    const l2Score = state.finalizedLineScores.find((s) => s.lineId === "l2")!;
    expect(l2Score.uncertain).toBe(true);
    expect(l1Score.uncertain).toBe(false);

    const finished = reduce(
      { ...state, pendingCommit: null },
      { audioTimeMs: 3000, type: "finish" },
    );
    expect(finished.state.summary?.lineCount).toBe(2);
    // finalScore averages only the measured (non-uncertain) line. Its exact value
    // is the summary's own recomputation: a one-line take carries too little
    // evidence to calibrate timing, so timing contributes its neutral value
    // rather than the live per-line read.
    expect(finished.state.summary?.timingCalibration.state).toBe("uncalibrated");
    const summaryL1 = finished.state.summary?.strongestLines.find((s) => s.lineId === "l1");
    expect(finished.state.summary?.finalScore).toBeCloseTo(summaryL1!.score, 5);
    expect(l1Score.uncertain).toBe(false);
  });

  test("seek rewinds watermark, clears incompatible pending commits, and releases affected scores", () => {
    // Finalize l1 via a covered playback so there is a score + lock to release.
    let state = reduce(
      baseState({ currentTimeMs: 1100, recognizedWords: L1_WORDS, sttWatermarkMs: 1500 }),
      {
        audioTimeMs: 1100,
        playing: true,
        type: "playback_sync",
      },
    ).state;
    expect(state.finalizedLineScores.some((s) => s.lineId === "l1")).toBe(true);
    state = {
      ...state,
      pendingCommit: pending({ commitId: "c2", frontierMs: 1800, lineIds: ["l2"] }),
      sttWatermarkMs: 1800,
    };

    const r = reduce(state, { audioTimeMs: 500, type: "seek" });
    expect(r.state.sttWatermarkMs).toBe(500); // rewound to the seek point
    expect(r.state.pendingCommit).toBeNull(); // frontier 1800 > 500 → incompatible, cleared
    expect(r.state.assignmentLocks.has("l1")).toBe(false); // l1 (endMs 1000 > 500) released
    expect(r.state.finalizedLineScores.some((s) => s.lineId === "l1")).toBe(false);
  });

  test("finish does not summarize while a valid commit remains pending", () => {
    const pendingFinish = reduce(baseState({ pendingCommit: pending() }), {
      audioTimeMs: 3000,
      type: "finish",
    });
    expect(pendingFinish.state.status).toBe("finalizing");
    expect(pendingFinish.state.summary).toBeNull();
    expect(pendingFinish.effects.some((e) => e.type === "emit_summary")).toBe(false);

    const cleanFinish = reduce(baseState({ pendingCommit: null }), {
      audioTimeMs: 3000,
      type: "finish",
    });
    expect(cleanFinish.state.status).toBe("finalized");
    expect(cleanFinish.state.summary).not.toBeNull();
  });

  test("repeated acknowledgements and failures are idempotent", () => {
    const ack = sttFinal({
      commitId: "c1",
      coverageMs: 1000,
      streamGeneration: "g1",
      words: L1_WORDS,
    });
    const first = reduce(
      baseState({
        currentTimeMs: 1100,
        pendingCommit: pending(),
        recognizedWords: L1_WORDS,
        sttWatermarkMs: 0,
      }),
      ack,
    ).state;
    const second = reduce(first, ack).state;
    expect(second.sttWatermarkMs).toBe(1000);
    expect(second.pendingCommit).toBeNull();
    expect(second.finalizedLineScores).toHaveLength(1); // not duplicated

    const failEvent: KaraokeSessionEvent = {
      commitId: "c1",
      reason: "timeout",
      streamGeneration: "g1",
      type: "commit_failed",
    };
    const f1 = reduce(
      baseState({ pendingCommit: pending(), recognizedWords: L1_WORDS }),
      failEvent,
    ).state;
    const f2 = reduce(f1, failEvent).state; // pending already cleared → no-op
    expect(f2.finalizedLineScores).toHaveLength(1);
  });
});
