/** Bounded PCM Worker recipe. The general song-video interval policy is wider;
 * this route must cover the full six-to-thirty-second Dance interval without
 * raising its independent 24 MiB master or 1,000-chunk parsing ceilings. */
export const SONG_VIDEO_PCM_RENDER_MAX_SAMPLES = 30 * 48_000;
