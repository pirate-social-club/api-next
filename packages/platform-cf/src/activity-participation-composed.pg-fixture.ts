export const COMMUNITY_ID = "composed-community";
export const POST_ID = "composed-post";
export const AUTHOR_ID = "composed-author";
export const AUTHOR_PERSONA_ID = "composed-author-persona";
export const SUBMISSION_ID = "composed-submission";
export const OPERATION_ID = "composed-operation";
export const AUDIO_REVISION = 1;
export const LYRICS_REVISION = 1;
export const CANONICAL_AUDIO_SHA256 = "a".repeat(64);
export const LYRIC_LINES = [
  "Hold the line",
  "Sing it back",
  "Keep the rhythm",
  "Move with me",
  "Shine tonight",
] as const;

export const digest = async (value: string): Promise<string> =>
  Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString(
    "hex",
  );

export const addressFor = async (value: string): Promise<string> =>
  `0x${(await digest(value)).slice(0, 40)}`;

export type StudyActivityTimes = Readonly<{
  acceptedAt: string;
  createdAt: string;
}>;

export type KaraokeActivityTimes = Readonly<{
  completedAt: string;
  createdAt: string;
  expiresAt: string;
}>;

export type ComposedActivityTimes = Readonly<{
  cutoffAt: string;
  karaoke: KaraokeActivityTimes;
  study: StudyActivityTimes;
}>;

/**
 * Keeps activity evidence before a future Megapot cutoff while allowing the
 * cutoff coordinator's clock to advance deterministically without sleeping.
 */
export function makeComposedActivityTimes(nowMilliseconds: number): ComposedActivityTimes {
  if (!Number.isFinite(nowMilliseconds)) throw new Error("invalid fixture time");
  const instant = (offsetMilliseconds: number) =>
    new Date(nowMilliseconds + offsetMilliseconds).toISOString();
  return {
    cutoffAt: instant(5 * 60_000),
    study: { createdAt: instant(1_000), acceptedAt: instant(2_000) },
    karaoke: {
      createdAt: instant(3_000),
      completedAt: instant(4_000),
      expiresAt: instant(10 * 60_000),
    },
  };
}
