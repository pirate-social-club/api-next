/** Qualification policy, frozen before evaluating any provider master. */
export const SONG_VIDEO_FRAME_POLICY = {
  revision: 1,
  ffmpegVersion: "6.1.1",
  framesPerSecond: 30,
  sampleRate: 48_000,
  maxBytes: 24 * 1024 * 1024,
  minSsimAll: 0.95,
  minSsimPlane: 0.9,
  minPsnrAllDb: 30,
  minPsnrPlaneDb: 28,
} as const;

export type FrameMetrics = Readonly<{
  frame: number;
  ssim: Readonly<{ all: number; y: number; u: number; v: number }>;
  psnr: Readonly<{ all: number; y: number; u: number; v: number }>;
}>;

export function matchesQualificationVersion(tool: "ffmpeg" | "ffprobe", output: string): boolean {
  const prefix = `${tool} version ${SONG_VIDEO_FRAME_POLICY.ffmpegVersion}`;
  return output.startsWith(`${prefix} `) || output.startsWith(`${prefix}-`);
}

export function frameCount(durationSamples: number): number {
  if (
    !Number.isSafeInteger(durationSamples) ||
    durationSamples < 144_000 ||
    durationSamples > 720_000
  ) {
    throw new Error("frame qualification requires a bounded frozen sample interval");
  }
  return Math.ceil(durationSamples / 1600);
}

export function frameVerdict(metrics: readonly FrameMetrics[], expectedFrames: number) {
  if (metrics.length !== expectedFrames || expectedFrames < 1) {
    return { passed: false, reason: "incomplete_frame_coverage", failedFrames: [] } as const;
  }
  const failedFrames: number[] = [];
  for (const [index, metric] of metrics.entries()) {
    if (metric.frame !== index + 1) {
      return { passed: false, reason: "noncontiguous_frame_coverage", failedFrames: [] } as const;
    }
    if (
      [metric.ssim.all, metric.ssim.y, metric.ssim.u, metric.ssim.v].some(
        (value) => !Number.isFinite(value) || value < 0 || value > 1,
      ) ||
      [metric.psnr.all, metric.psnr.y, metric.psnr.u, metric.psnr.v].some(
        (value) =>
          typeof value !== "number" || (value !== Infinity && !Number.isFinite(value)) || value < 0,
      )
    ) {
      return { passed: false, reason: "invalid_metrics", failedFrames: [] } as const;
    }
    if (
      metric.ssim.all < SONG_VIDEO_FRAME_POLICY.minSsimAll ||
      metric.psnr.all < SONG_VIDEO_FRAME_POLICY.minPsnrAllDb ||
      [metric.ssim.y, metric.ssim.u, metric.ssim.v].some(
        (value) => value < SONG_VIDEO_FRAME_POLICY.minSsimPlane,
      ) ||
      [metric.psnr.y, metric.psnr.u, metric.psnr.v].some(
        (value) => value < SONG_VIDEO_FRAME_POLICY.minPsnrPlaneDb,
      )
    )
      failedFrames.push(metric.frame);
  }
  return {
    passed: failedFrames.length === 0,
    reason: failedFrames.length === 0 ? "all_frames_within_tolerance" : "frame_content_differs",
    failedFrames,
  } as const;
}
