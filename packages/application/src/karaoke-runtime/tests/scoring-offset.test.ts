import { describe, expect, test } from "bun:test";
import {
  aggregateKaraokeSession,
  applyTimingOffsetCompensation,
  type KaraokeLineScore,
} from "../scoring";

function line(opts: {
  index: number;
  textScore: number;
  signedMeanDeltaMs: number;
  meanAbsDeltaMs: number;
  matchedWordCount?: number;
  recognizedWordCount?: number;
}): KaraokeLineScore {
  const recognizedWordCount = opts.recognizedWordCount ?? 1;
  return {
    confidenceScore: 0.9,
    finalizedReason: "asr_final",
    lineId: `line-${opts.index}`,
    lineIndex: opts.index,
    recognizedWords: Array.from({ length: recognizedWordCount }, () => ({
      confidence: 0.9,
      endMs: 100,
      final: true,
      startMs: 0,
      text: "x",
    })),
    score: 0,
    scoredLineIndex: opts.index,
    textScore: {
      confidenceMean: 0.9,
      keywordCoverage: opts.textScore,
      missedWords: [],
      phoneticAvailable: true,
      phoneticCoverage: opts.textScore,
      phoneticQuality: opts.textScore,
      score: opts.textScore,
      wer: 1 - opts.textScore,
    },
    timingScore: {
      matchedWordCount: opts.matchedWordCount ?? 5,
      meanAbsDeltaMs: opts.meanAbsDeltaMs,
      medianAbsDeltaMs: opts.meanAbsDeltaMs,
      medianSignedDeltaMs: opts.signedMeanDeltaMs,
      score: 0,
      signedMeanDeltaMs: opts.signedMeanDeltaMs,
      timingTrend: "on_time",
    },
    transcript: "x",
    uncertain: false,
  };
}

describe("timing offset compensation", () => {
  test("a consistent lead/lag is removed — timing scores rise toward 1", () => {
    // Every line is a steady 180ms late with no within-line spread: clean singing.
    const lines = [0, 1, 2, 3].map((i) =>
      line({ index: i, meanAbsDeltaMs: 180, signedMeanDeltaMs: 180, textScore: 0.95 }),
    );
    const { calibration, offsetMs, lineScores } = applyTimingOffsetCompensation(lines);
    expect(offsetMs).toBe(180);
    expect(calibration.state).toBe("calibrated");
    for (const ls of lineScores) {
      expect(ls.timingScore!.score).toBeGreaterThan(0.98);
    }
  });

  test("REGRESSION (the v3 timing-zero incident): a 700ms systematic lag is calibrated away", () => {
    // The v3 ceiling was 250ms, so a take with real capture+STT lag kept ~450ms of
    // residual, cleared the 575ms linear window on every line, and reported 0%
    // timing for a near-complete performance. It must now read as clean singing.
    const lines = [0, 1, 2, 3, 4, 5].map((i) =>
      line({ index: i, meanAbsDeltaMs: 700, signedMeanDeltaMs: 700, textScore: 0.92 }),
    );
    const summary = aggregateKaraokeSession({ lineScores: lines });

    expect(summary.timingCalibration.state).toBe("calibrated");
    expect(summary.timingCalibration.offsetMs).toBe(700);
    expect(summary.timingScore).toBeGreaterThan(0.95);
    expect(summary.finalScore).toBeGreaterThan(0.9);
    // The shared lag is capture/STT latency, not actionable singer feedback.
    expect(summary.timingTrend).toBe("on_time");
  });

  test("REGRESSION: perfect singing through 400ms capture latency is reported on time", () => {
    const lines = [0, 1, 2, 3].map((i) =>
      line({ index: i, meanAbsDeltaMs: 400, signedMeanDeltaMs: 400, textScore: 1 }),
    );
    const summary = aggregateKaraokeSession({ lineScores: lines });

    expect(summary.timingCalibration.state).toBe("calibrated");
    expect(summary.timingCalibration.offsetMs).toBe(400);
    expect(summary.timingCalibration.residualSpreadMs).toBe(0);
    expect(summary.timingScore).toBeCloseTo(1);
    expect(summary.timingTrend).toBe("on_time");
  });

  test("erratic timing is NOT excused (median offset ~0, residual spread remains)", () => {
    const lines = [
      line({ index: 0, meanAbsDeltaMs: 520, signedMeanDeltaMs: -520, textScore: 0.95 }),
      line({ index: 1, meanAbsDeltaMs: 10, signedMeanDeltaMs: 0, textScore: 0.95 }),
      line({ index: 2, meanAbsDeltaMs: 520, signedMeanDeltaMs: 520, textScore: 0.95 }),
    ];
    const { offsetMs, lineScores } = applyTimingOffsetCompensation(lines);
    expect(Math.abs(offsetMs)).toBeLessThanOrEqual(10);
    // The two wildly off lines still carry a real timing penalty.
    expect(lineScores[0]!.timingScore!.score).toBeLessThan(0.7);
    expect(lineScores[2]!.timingScore!.score).toBeLessThan(0.7);
    // …but neither is zeroed: they were measured, and a measured line keeps a floor.
    expect(lineScores[0]!.timingScore!.score).toBeGreaterThan(0.1);
  });

  test("a clean, consistently-offset performance summarizes well above the raw score", () => {
    const lines = [0, 1, 2, 3, 4].map((i) =>
      line({ index: i, meanAbsDeltaMs: 175, signedMeanDeltaMs: 175, textScore: 0.95 }),
    );
    const summary = aggregateKaraokeSession({ lineScores: lines });
    expect(summary.finalScore).toBeGreaterThan(0.9);
    expect(summary.lyricsScore).toBeCloseTo(0.95, 1);
    expect(summary.timingScore).toBeGreaterThan(0.95);
  });

  test("mis-recognized lines do not skew the offset estimate", () => {
    // 3 well-sung lines at +180, plus 3 garbage-text lines whose deltas would
    // drag the raw median to -250. The garbage lines must be excluded so the
    // estimate stays at the true +180.
    const good = [0, 1, 2].map((i) =>
      line({ index: i, meanAbsDeltaMs: 180, signedMeanDeltaMs: 180, textScore: 0.95 }),
    );
    const garbage = [3, 4, 5].map((i) =>
      line({ index: i, meanAbsDeltaMs: 250, signedMeanDeltaMs: -250, textScore: 0.2 }),
    );
    const { offsetMs } = applyTimingOffsetCompensation([...good, ...garbage]);
    expect(offsetMs).toBe(180);
  });
});

describe("timing calibration verdicts", () => {
  test("an implausible offset is reported as a measurement fault, not a bad singer", () => {
    // A 4s lead cannot be capture latency — the word clock is mis-mapped.
    const lines = [0, 1, 2, 3].map((i) =>
      line({ index: i, meanAbsDeltaMs: 4000, signedMeanDeltaMs: -4000, textScore: 0.9 }),
    );
    const summary = aggregateKaraokeSession({ lineScores: lines });

    expect(summary.timingCalibration.state).toBe("uncalibrated");
    expect(summary.timingCalibration.reason).toBe("offset_out_of_range");
    expect(summary.timingCalibration.rawOffsetMs).toBe(-4000);
    expect(summary.timingScore).toBeNull();
    // Lyrics were good, so the take still scores well.
    expect(summary.finalScore).toBeGreaterThan(0.85);
  });

  test("incoherent residuals are reported rather than scored", () => {
    const lines = [
      line({ index: 0, meanAbsDeltaMs: 1500, signedMeanDeltaMs: -1500, textScore: 0.9 }),
      line({ index: 1, meanAbsDeltaMs: 1500, signedMeanDeltaMs: 1500, textScore: 0.9 }),
      line({ index: 2, meanAbsDeltaMs: 1400, signedMeanDeltaMs: -1400, textScore: 0.9 }),
      line({ index: 3, meanAbsDeltaMs: 1450, signedMeanDeltaMs: 1450, textScore: 0.9 }),
      line({ index: 4, meanAbsDeltaMs: 30, signedMeanDeltaMs: 30, textScore: 0.9 }),
    ];
    const summary = aggregateKaraokeSession({ lineScores: lines });

    expect(summary.timingCalibration.state).toBe("uncalibrated");
    expect(summary.timingCalibration.reason).toBe("incoherent_residuals");
    expect(summary.timingScore).toBeNull();
  });

  test("a short take has too little evidence to calibrate", () => {
    const lines = [0, 1].map((i) =>
      line({
        index: i,
        matchedWordCount: 2,
        meanAbsDeltaMs: 100,
        signedMeanDeltaMs: 100,
        textScore: 0.9,
      }),
    );
    const summary = aggregateKaraokeSession({ lineScores: lines });

    expect(summary.timingCalibration.state).toBe("uncalibrated");
    expect(summary.timingCalibration.reason).toBe("insufficient_evidence");
    expect(summary.timingScore).toBeNull();
  });
});

describe("timing cannot be gamed by sabotaging it", () => {
  test("a deliberately-uncalibratable take never beats an honest one", () => {
    // Sing the lyrics perfectly but wildly off-beat so timing has to be dropped.
    // Under v3 the weights renormalized and text rose to ~93% of the line score,
    // so this out-scored a singer with identical lyrics and honest timing.
    const sabotaged = [0, 1, 2, 3].map((i) =>
      line({ index: i, meanAbsDeltaMs: 5000, signedMeanDeltaMs: -5000, textScore: 1 }),
    );
    const honest = [0, 1, 2, 3].map((i) =>
      line({ index: i, meanAbsDeltaMs: 60, signedMeanDeltaMs: 60, textScore: 1 }),
    );

    const sabotagedSummary = aggregateKaraokeSession({ lineScores: sabotaged });
    const honestSummary = aggregateKaraokeSession({ lineScores: honest });

    expect(sabotagedSummary.timingScore).toBeNull();
    expect(honestSummary.finalScore).toBeGreaterThan(sabotagedSummary.finalScore);
    // …and the sabotaged take is still not punished below the neutral value.
    expect(sabotagedSummary.finalScore).toBeGreaterThan(0.9);
  });

  test("silence still scores near zero — neutral timing is not a free pass", () => {
    const silent = [0, 1, 2, 3].map((i) => ({
      ...line({ index: i, meanAbsDeltaMs: 0, signedMeanDeltaMs: 0, textScore: 0 }),
      confidenceScore: null,
      recognizedWords: [],
      timingScore: null,
    }));
    const summary = aggregateKaraokeSession({ lineScores: silent });

    expect(summary.finalScore).toBe(0);
  });
});
