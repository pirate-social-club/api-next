import { describe, expect, test } from "bun:test";
import {
  type KaraokeRecognizedWord,
  type ScorableKaraokeLine,
  scoreKaraokeLineTiming,
} from "../scoring";

function expectedLine(words: [text: string, startMs: number][]): ScorableKaraokeLine {
  return {
    endMs: (words.at(-1)?.[1] ?? 0) + 400,
    lineId: "l1",
    lineIndex: 0,
    scoredLineIndex: 0,
    startMs: words[0]?.[1] ?? 0,
    text: words.map(([text]) => text).join(" "),
    words: words.map(([text, startMs]) => ({ endMs: startMs + 400, startMs, text })),
  };
}

function recognized(words: [text: string, startMs: number][]): KaraokeRecognizedWord[] {
  return words.map(([text, startMs]) => ({
    confidence: 0.9,
    endMs: startMs + 400,
    final: true,
    source: "stt" as const,
    startMs,
    text,
  }));
}

describe("timing word alignment", () => {
  test("a repeated word pairs with its own occurrence, not a distant one", () => {
    // "oh" appears three times, each sung a steady 120ms late. Independent
    // best-match (v3) let every expected "oh" pair with whichever "oh" looked
    // best, producing deltas of -2280…+2280 with random signs — the incoherence
    // that made timing untrustworthy. Order-preserving alignment cannot cross
    // pairs, so the deltas must all read +120.
    const line = expectedLine([
      ["oh", 0],
      ["oh", 1200],
      ["oh", 2400],
    ]);
    const words = recognized([
      ["oh", 120],
      ["oh", 1320],
      ["oh", 2520],
    ]);

    const timing = scoreKaraokeLineTiming({ expectedLine: line, recognizedWords: words })!;

    expect(timing.matchedWordCount).toBe(3);
    expect(timing.medianSignedDeltaMs).toBe(120);
    expect(timing.medianAbsDeltaMs).toBe(120);
    // A steady 120ms lag reads as "late" (feedback), and is calibrated away
    // at session level (score), which is the point of separating the two.
    expect(timing.timingTrend).toBe("late");
    expect(timing.score).toBeGreaterThan(0.98);
  });

  test("a dropped word opens a gap instead of forcing a bad pairing", () => {
    const line = expectedLine([
      ["hold", 0],
      ["on", 500],
      ["tight", 1000],
      ["now", 1500],
    ]);
    // The singer skipped "tight".
    const words = recognized([
      ["hold", 90],
      ["on", 590],
      ["now", 1590],
    ]);

    const timing = scoreKaraokeLineTiming({ expectedLine: line, recognizedWords: words })!;

    expect(timing.matchedWordCount).toBe(3);
    expect(timing.medianSignedDeltaMs).toBe(90);
    expect(timing.score).toBeGreaterThan(0.98);
  });

  test("an ad-libbed extra word does not shift the pairing of the real ones", () => {
    const line = expectedLine([
      ["catch", 0],
      ["fire", 600],
    ]);
    const words = recognized([
      ["yeah", -200],
      ["catch", 100],
      ["fire", 700],
    ]);

    const timing = scoreKaraokeLineTiming({ expectedLine: line, recognizedWords: words })!;

    expect(timing.matchedWordCount).toBe(2);
    expect(timing.medianSignedDeltaMs).toBe(100);
  });

  test("one wildly mis-timed word cannot sink a line (median, not mean)", () => {
    // Four words on the beat, one word stamped 3s out by a reconnect artefact.
    const line = expectedLine([
      ["a", 0],
      ["b", 400],
      ["c", 800],
      ["d", 1200],
      ["e", 1600],
    ]);
    const words = recognized([
      ["a", 60],
      ["b", 460],
      ["c", 860],
      ["d", 1260],
      ["e", 4600],
    ]);

    const timing = scoreKaraokeLineTiming({ expectedLine: line, recognizedWords: words })!;

    expect(timing.medianSignedDeltaMs).toBe(60);
    // The mean is wrecked by the outlier; the median (what scores) is not.
    expect(timing.meanAbsDeltaMs).toBeGreaterThan(600);
    expect(timing.score).toBeGreaterThan(0.98);
  });

  test("a line with no sound-alike words yields no timing observation", () => {
    const line = expectedLine([
      ["hold", 0],
      ["on", 500],
    ]);
    const words = recognized([
      ["zebra", 0],
      ["quantum", 500],
    ]);

    expect(scoreKaraokeLineTiming({ expectedLine: line, recognizedWords: words })).toBeNull();
  });
});
