import { describe, expect, test } from "bun:test";
import { aggregateKaraokeSession, type KaraokeLineScore } from "../scoring";

function line(opts: { index: number; uncertain: boolean; recognized: boolean }): KaraokeLineScore {
  return {
    confidenceScore: 0.9,
    finalizedReason: opts.uncertain ? "provider_failed" : "asr_final",
    lineId: `line-${opts.index}`,
    lineIndex: opts.index,
    recognizedWords: opts.recognized
      ? [{ text: "x", startMs: 0, endMs: 100, confidence: 0.9, final: true }]
      : [],
    score: 0.8,
    scoredLineIndex: opts.index,
    textScore: {
      confidenceMean: 0.9,
      keywordCoverage: 0.8,
      missedWords: [],
      phoneticAvailable: true,
      phoneticCoverage: 0.8,
      phoneticQuality: 0.8,
      score: 0.8,
      wer: 0.2,
    },
    timingScore: {
      matchedWordCount: 3,
      meanAbsDeltaMs: 50,
      medianAbsDeltaMs: 50,
      medianSignedDeltaMs: 50,
      score: 0.9,
      signedMeanDeltaMs: 50,
      timingTrend: "on_time",
    },
    transcript: opts.recognized ? "x" : "",
    uncertain: opts.uncertain,
  };
}

describe("aggregateKaraokeSession line counts", () => {
  test("counts uncertain (measurement-failed) lines separately from scored lines", () => {
    const summary = aggregateKaraokeSession({
      lineScores: [
        line({ index: 0, uncertain: false, recognized: true }),
        line({ index: 1, uncertain: false, recognized: true }),
        // Provider/stream failure — must be counted as uncertain and excluded from scoring.
        line({ index: 2, uncertain: true, recognized: false }),
      ],
    });

    expect(summary.lineCount).toBe(3);
    expect(summary.uncertainLineCount).toBe(1);
    // Uncertain lines never enter the scored set.
    expect(summary.scoredLineCount).toBe(2);
    expect(summary.lineDiagnostics).toEqual([
      {
        confidenceScore: 0.9,
        finalizedReason: "asr_final",
        lineId: "line-0",
        medianSignedDeltaMs: 50,
        recognizedWordCount: 1,
        score: expect.any(Number),
        textScore: 0.8,
        timingScore: expect.any(Number),
      },
      {
        confidenceScore: 0.9,
        finalizedReason: "asr_final",
        lineId: "line-1",
        medianSignedDeltaMs: 50,
        recognizedWordCount: 1,
        score: expect.any(Number),
        textScore: 0.8,
        timingScore: expect.any(Number),
      },
      {
        confidenceScore: 0.9,
        finalizedReason: "provider_failed",
        lineId: "line-2",
        medianSignedDeltaMs: 50,
        recognizedWordCount: 0,
        score: expect.any(Number),
        textScore: 0.8,
        timingScore: expect.any(Number),
      },
    ]);
  });

  test("uncertainLineCount is 0 when every line was measured", () => {
    const summary = aggregateKaraokeSession({
      lineScores: [
        line({ index: 0, uncertain: false, recognized: true }),
        line({ index: 1, uncertain: false, recognized: true }),
      ],
    });

    expect(summary.uncertainLineCount).toBe(0);
  });
});
