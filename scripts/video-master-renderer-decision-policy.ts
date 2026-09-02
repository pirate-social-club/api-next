export type SongCoverageDecision =
  | {
      readonly accepted: true;
      readonly clipEndSamples: number;
    }
  | {
      readonly accepted: false;
      readonly reason: "canonical_song_interval_uncovered" | "invalid_timeline";
    };

export function validateCanonicalSongCoverage(input: {
  readonly songDurationSamples: number;
  readonly clipStartSamples: number;
  readonly masterDurationSamples: number;
}): SongCoverageDecision {
  const values = [input.songDurationSamples, input.clipStartSamples, input.masterDurationSamples];
  if (
    values.some((value) => !Number.isSafeInteger(value)) ||
    input.songDurationSamples < 1 ||
    input.clipStartSamples < 0 ||
    input.masterDurationSamples < 1
  ) {
    return { accepted: false, reason: "invalid_timeline" };
  }
  const clipEndSamples = input.clipStartSamples + input.masterDurationSamples;
  if (!Number.isSafeInteger(clipEndSamples) || clipEndSamples > input.songDurationSamples) {
    return { accepted: false, reason: "canonical_song_interval_uncovered" };
  }
  return { accepted: true, clipEndSamples };
}
