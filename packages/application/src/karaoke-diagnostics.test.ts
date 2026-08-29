import { describe, expect, test } from "bun:test";
import { buildKaraokeScoringDiagnostics } from "./karaoke-diagnostics.ts";
import type { KaraokeLineScore } from "./karaoke-runtime/scoring.ts";
import type { KaraokeSessionAuthority } from "./karaoke-service.ts";

const authority = {
  lines: [
    {
      id: "line-1",
      words: ["hello", "hello", "world"].map((text, index) => ({
        end_ms: index * 100 + 100,
        start_ms: index * 100,
        text,
      })),
    },
  ],
  scoringVersion: 5,
} as unknown as KaraokeSessionAuthority;

const score = {
  lineId: "line-1",
  recognizedWords: [
    { confidence: 0.9, endMs: 100, final: true, startMs: 0, text: "Hello!" },
    { confidence: 0.9, endMs: 300, final: true, startMs: 200, text: "world" },
  ],
} as KaraokeLineScore;

describe("Karaoke scoring diagnostics", () => {
  test("persists expected-word positions without recognized transcript text", () => {
    const diagnostics = buildKaraokeScoringDiagnostics(
      authority,
      {
        lineDiagnostics: [
          {
            confidenceScore: 0.9,
            finalizedReason: "asr_final",
            lineId: "line-1",
            medianSignedDeltaMs: 12,
            recognizedWordCount: 2,
            score: 0.8,
            textScore: 0.75,
            timingScore: 0.9,
          },
        ],
        timingCalibration: {
          matchedWordCount: 2,
          measuredLineCount: 1,
          offsetMs: 0,
          rawOffsetMs: 0,
          reason: null,
          residualSpreadMs: 12,
          state: "calibrated",
        },
      } as never,
      [score],
    );

    expect(diagnostics.line_diagnostics[0]).toMatchObject({
      expected_word_count: 3,
      recognized_expected_word_positions: [0, 2],
      missed_expected_word_positions: [1],
    });
    expect(JSON.stringify(diagnostics)).not.toContain("Hello!");
  });
});
