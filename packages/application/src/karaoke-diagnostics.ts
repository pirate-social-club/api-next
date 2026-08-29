import type { KaraokeLineScore } from "./karaoke-runtime/scoring.ts";
import type { KaraokeSessionState } from "./karaoke-runtime/session.ts";
import type { KaraokeSessionAuthority } from "./karaoke-service.ts";

const normalized = (value: string): string =>
  value
    .normalize("NFKD")
    .toLocaleLowerCase("und")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const expectedPositions = (
  expected: readonly Readonly<{ text: string }>[],
  score: KaraokeLineScore,
): Readonly<{ recognized: number[]; missed: number[] }> => {
  const recognizedTokens = score.recognizedWords.map((word) => normalized(word.text));
  const recognized: number[] = [];
  let cursor = 0;
  for (const [position, word] of expected.entries()) {
    const target = normalized(word.text);
    const match = recognizedTokens.findIndex(
      (candidate, index) => index >= cursor && candidate === target,
    );
    if (match >= 0) {
      recognized.push(position);
      cursor = match + 1;
    }
  }
  const recognizedSet = new Set(recognized);
  return {
    recognized,
    missed: expected.flatMap((_, position) => (recognizedSet.has(position) ? [] : [position])),
  };
};

/** Builds bounded, transcript-free evidence by indexing only the expected lyric words. */
export const buildKaraokeScoringDiagnostics = (
  authority: KaraokeSessionAuthority,
  summary: NonNullable<KaraokeSessionState["summary"]>,
  scores: readonly KaraokeLineScore[] = [],
) => ({
  schema_version: 1 as const,
  scoring_version: authority.scoringVersion,
  timing_calibration: {
    state: summary.timingCalibration.state,
    reason: summary.timingCalibration.reason,
    offset_ms: summary.timingCalibration.offsetMs,
    raw_offset_ms: summary.timingCalibration.rawOffsetMs,
    residual_spread_ms: summary.timingCalibration.residualSpreadMs,
    measured_line_count: summary.timingCalibration.measuredLineCount,
    matched_word_count: summary.timingCalibration.matchedWordCount,
  },
  line_diagnostics:
    summary.lineDiagnostics?.map((line) => {
      const expected =
        authority.lines.find((candidate) => candidate.id === line.lineId)?.words ?? [];
      const score = scores.find((candidate) => candidate.lineId === line.lineId);
      const positions =
        score === undefined
          ? { recognized: [] as number[], missed: expected.map((_, index) => index) }
          : expectedPositions(expected, score);
      return {
        line_id: line.lineId,
        finalized_reason: line.finalizedReason,
        recognized_word_count: line.recognizedWordCount,
        score: line.score,
        text_score: line.textScore,
        timing_score: line.timingScore,
        confidence_score: line.confidenceScore,
        median_signed_delta_ms: line.medianSignedDeltaMs,
        expected_word_count: expected.length,
        recognized_expected_word_positions: positions.recognized,
        missed_expected_word_positions: positions.missed,
      };
    }) ?? [],
});
