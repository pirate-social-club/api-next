import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mediaSha256Bytes } from "@pirate/application/media/submission-service";
import type {
  MediaTransformVideoAttemptContext,
  MediaTransformVideoAudioInput,
  MediaTransformVideoCapabilities,
  MediaTransformVideoFrame,
  MediaTransformVideoFramesInput,
  MediaTransformVideoProbe,
  MediaTransformVideoProbeInput,
  MediaTransformVideoSource,
} from "@pirate/application/media/transform";
import {
  MEDIA_TRANSFORM_VIDEO_AUDIO_POLICY_V1,
  MediaTransformRequestInvalid,
} from "@pirate/application/media/transform";
import type {
  VideoAnalysisProviders,
  VideoAnalysisSource,
} from "@pirate/application/video/analysis";
import { VIDEO_POSTER_POLICY_V1 } from "@pirate/domain";
import { Effect } from "effect";

export const LOCAL_VIDEO_FFMPEG_REVISION = "ffmpeg-6.1.1-video-analysis-v1";
export const LOCAL_VIDEO_PROBE_REVISION = "ffprobe-6.1.1-video-analysis-v1";
export const LOCAL_VIDEO_FRAME_EXTRACTION_POLICY = "video-jpeg-three-frame-v1";

const EXPECTED_VERSION_PREFIX = "ffmpeg version 6.1.1";
const EXPECTED_PROBE_VERSION_PREFIX = "ffprobe version 6.1.1";
const MAXIMUM_SOURCE_BYTES = 500 * 1024 * 1024;
const MAXIMUM_DIAGNOSTIC_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

export interface LocalVideoSourceReader {
  readonly read: (source: MediaTransformVideoSource) => Promise<Uint8Array>;
}

export interface LocalVideoArtifactWriter {
  readonly write: (
    input: Readonly<{
      artifactKey: string;
      bytes: Uint8Array;
      mediaType: "audio/mp4" | "image/jpeg";
      canonicalSha256: string;
    }>,
  ) => Promise<Readonly<{ artifactRef: string }>>;
}

export type LocalPinnedFfmpegOptions = Readonly<{
  readonly sourceReader: LocalVideoSourceReader;
  readonly artifactWriter: LocalVideoArtifactWriter;
  readonly ffmpegBinary?: string;
  readonly ffprobeBinary?: string;
  readonly timeoutMs?: number;
  readonly maximumSourceBytes?: number;
}>;

type ProbeDocument = Readonly<{
  readonly streams?: readonly Readonly<Record<string, unknown>>[];
  readonly format?: Readonly<Record<string, unknown>>;
}>;

function validSource(source: MediaTransformVideoSource): boolean {
  return (
    source.objectKey.startsWith("media://immutable/") &&
    !source.objectKey.includes("\\") &&
    !source.objectKey.split("/").includes("..") &&
    /^[0-9a-f]{64}$/u.test(source.sha256) &&
    Number.isSafeInteger(source.byteLength) &&
    source.byteLength > 0
  );
}

async function readBoundedText(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (stream === null) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > MAXIMUM_DIAGNOSTIC_BYTES) throw new Error("video tool diagnostics exceeded limit");
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function runTool(
  command: readonly string[],
  timeoutMs: number,
): Promise<Readonly<{ stdout: string; stderr: string }>> {
  const child = Bun.spawn([...command], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      child.kill();
      reject(new Error("video tool timed out"));
    }, timeoutMs);
  });
  try {
    const [exitCode, stdout, stderr] = await Promise.race([
      Promise.all([child.exited, readBoundedText(child.stdout), readBoundedText(child.stderr)]),
      timeout,
    ]);
    if (exitCode !== 0) throw new Error("video tool failed");
    return { stdout, stderr };
  } catch (error) {
    child.kill();
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function parsePositiveNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("invalid video probe number");
  return parsed;
}

function frameRateMillihertz(value: unknown): number {
  if (typeof value !== "string" || !/^[0-9]+\/[1-9][0-9]*$/u.test(value)) {
    throw new Error("invalid video frame rate");
  }
  const [numeratorText, denominatorText] = value.split("/") as [string, string];
  const rate = (Number(numeratorText) / Number(denominatorText)) * 1_000;
  if (!Number.isFinite(rate) || rate <= 0 || !Number.isSafeInteger(Math.round(rate))) {
    throw new Error("invalid video frame rate");
  }
  return Math.round(rate);
}

function parseProbe(document: ProbeDocument, evidenceRef: string): MediaTransformVideoProbe {
  const streams = document.streams;
  const format = document.format;
  if (!Array.isArray(streams) || format === undefined)
    throw new Error("invalid video probe result");
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  if (video === undefined || audio === undefined || audio.codec_name !== "aac") {
    throw new Error("video probe did not find the required streams");
  }
  if (video.codec_name !== "h264" && video.codec_name !== "hevc") {
    throw new Error("video probe returned an unsupported codec");
  }
  const width = parsePositiveNumber(video.width);
  const height = parsePositiveNumber(video.height);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
    throw new Error("video probe returned invalid dimensions");
  }
  return {
    evidenceRef,
    durationMs: Math.round(parsePositiveNumber(format.duration) * 1_000),
    width,
    height,
    frameRateMillihertz: frameRateMillihertz(video.avg_frame_rate),
    videoCodec: video.codec_name,
    audioCodec: "aac",
    hasAudio: true,
  };
}

function context(
  input:
    | MediaTransformVideoProbeInput
    | MediaTransformVideoAudioInput
    | MediaTransformVideoFramesInput,
): MediaTransformVideoAttemptContext {
  return {
    version: "media-transform-video-attempt-context-v1",
    ...input.binding,
    adapterRevision: LOCAL_VIDEO_FFMPEG_REVISION,
  };
}

function transformSource(source: VideoAnalysisSource): MediaTransformVideoSource {
  return {
    objectKey: source.immutableRef,
    sha256: source.canonicalSha256,
    byteLength: source.byteLength,
    mediaType: source.mediaType,
  };
}

function acceptedPosterPolicy(input: MediaTransformVideoFramesInput["posterPolicy"]): boolean {
  return (
    input.version === VIDEO_POSTER_POLICY_V1.version &&
    input.policyRevision === VIDEO_POSTER_POLICY_V1.policyRevision &&
    input.roles.join(",") === VIDEO_POSTER_POLICY_V1.roles.join(",") &&
    input.maxEdgePx === VIDEO_POSTER_POLICY_V1.maxEdgePx &&
    input.maxBytesPerFrame === VIDEO_POSTER_POLICY_V1.maxBytesPerFrame &&
    input.imageType === VIDEO_POSTER_POLICY_V1.imageType
  );
}

function seconds(milliseconds: number): string {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new TypeError("video extraction timestamp must be a non-negative integer");
  }
  return (milliseconds / 1_000).toFixed(3);
}

/**
 * Credential-free local adapter for the accepted FFmpeg 6.1.1 engine. Source
 * bytes and artifact storage are typed ports; all executable arguments below
 * are fixed server templates.
 */
export function makeLocalPinnedFfmpegVideoAnalysisEngine(
  options: LocalPinnedFfmpegOptions,
): MediaTransformVideoCapabilities & Pick<VideoAnalysisProviders, "hash"> {
  const ffmpeg = options.ffmpegBinary ?? "ffmpeg";
  const ffprobe = options.ffprobeBinary ?? "ffprobe";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maximumSourceBytes = options.maximumSourceBytes ?? MAXIMUM_SOURCE_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10 * 60 * 1_000) {
    throw new TypeError("local video tool timeout must be bounded");
  }
  if (
    !Number.isSafeInteger(maximumSourceBytes) ||
    maximumSourceBytes < 1 ||
    maximumSourceBytes > MAXIMUM_SOURCE_BYTES
  ) {
    throw new TypeError("local video source limit must be bounded");
  }

  let versionCheck: Promise<void> | undefined;
  const assertPinnedVersion = (): Promise<void> => {
    versionCheck ??= Promise.all([
      runTool([ffmpeg, "-version"], timeoutMs),
      runTool([ffprobe, "-version"], timeoutMs),
    ]).then(([ffmpegResult, ffprobeResult]) => {
      if (
        !ffmpegResult.stdout.startsWith(EXPECTED_VERSION_PREFIX) ||
        !ffprobeResult.stdout.startsWith(EXPECTED_PROBE_VERSION_PREFIX)
      ) {
        throw new Error("local video engine is not pinned FFmpeg 6.1.1");
      }
    });
    return versionCheck;
  };

  const withSource = async <T>(
    source: MediaTransformVideoSource,
    use: (inputPath: string, bytes: Uint8Array, directory: string) => Promise<T>,
  ): Promise<T> => {
    if (!validSource(source) || source.byteLength > maximumSourceBytes) {
      throw new TypeError("invalid local video analysis source");
    }
    await assertPinnedVersion();
    const bytes = await options.sourceReader.read(source);
    if (bytes.byteLength !== source.byteLength || bytes.byteLength > maximumSourceBytes) {
      throw new Error("local video source length mismatch");
    }
    if ((await mediaSha256Bytes(bytes)) !== source.sha256) {
      throw new Error("local video source hash mismatch");
    }
    const directory = await mkdtemp(join(tmpdir(), "pirate-video-analysis-"));
    const inputPath = join(directory, "source.mp4");
    try {
      await writeFile(inputPath, bytes, { flag: "wx" });
      return await use(inputPath, bytes, directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };

  return {
    hash: (source) =>
      withSource(transformSource(source), async (_inputPath, bytes) => ({
        canonicalSha256: await mediaSha256Bytes(bytes),
        byteLength: bytes.byteLength,
        evidenceRef: `video-hash:${source.canonicalSha256}`,
      })),

    probe: (input) =>
      Effect.promise(() =>
        withSource(input.source, async (inputPath) => {
          const result = await runTool(
            [
              ffprobe,
              "-v",
              "error",
              "-show_entries",
              "format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate",
              "-of",
              "json",
              inputPath,
            ],
            timeoutMs,
          );
          return parseProbe(
            JSON.parse(result.stdout) as ProbeDocument,
            `video-probe:${input.source.sha256}:${LOCAL_VIDEO_PROBE_REVISION}`,
          );
        }).then((probe) => ({
          status: "completed" as const,
          attempt: input.attempt,
          context: context(input),
          probe,
        })),
      ),

    extractVideoAudio: (input) =>
      input.extractionPolicyVersion !== MEDIA_TRANSFORM_VIDEO_AUDIO_POLICY_V1
        ? Effect.fail(new MediaTransformRequestInvalid({ reason: "invalid_video_policy" }))
        : Effect.promise(() =>
            withSource(input.source, async (inputPath, _bytes, directory) => {
              const outputPath = join(directory, "soundtrack.m4a");
              await runTool(
                [
                  ffmpeg,
                  "-nostdin",
                  "-hide_banner",
                  "-loglevel",
                  "error",
                  "-i",
                  inputPath,
                  "-map",
                  "0:a:0",
                  "-vn",
                  "-c:a",
                  "aac",
                  "-b:a",
                  "192k",
                  "-ar",
                  "44100",
                  "-ac",
                  "2",
                  "-f",
                  "ipod",
                  outputPath,
                ],
                timeoutMs,
              );
              const bytes = new Uint8Array(await readFile(outputPath));
              const canonicalSha256 = await mediaSha256Bytes(bytes);
              const stored = await options.artifactWriter.write({
                artifactKey: `video/${input.source.sha256}/v${input.binding.videoRevision}/soundtrack.m4a`,
                bytes,
                mediaType: "audio/mp4",
                canonicalSha256,
              });
              if (!validIdentifier(stored.artifactRef))
                throw new Error("invalid video artifact ref");
              return {
                artifactRef: stored.artifactRef,
                canonicalSha256,
                sourceSha256: input.source.sha256,
                videoRevision: input.binding.videoRevision,
                mediaType: "audio/mp4" as const,
                policyRevision: input.extractionPolicyVersion,
                adapterRevision: LOCAL_VIDEO_FFMPEG_REVISION,
              };
            }).then((artifact) => ({
              status: "completed" as const,
              attempt: input.attempt,
              context: context(input),
              artifact,
            })),
          ),

    extractVideoFrames: (input) =>
      !acceptedPosterPolicy(input.posterPolicy)
        ? Effect.fail(new MediaTransformRequestInvalid({ reason: "invalid_video_policy" }))
        : Effect.promise(() =>
            withSource(input.source, async (inputPath, _bytes, directory) => {
              const durationMs = input.sourceDurationMs;
              const posterTimestampMs = input.posterTimestampMs;
              if (
                !Number.isSafeInteger(durationMs) ||
                durationMs < 1 ||
                !Number.isSafeInteger(posterTimestampMs) ||
                posterTimestampMs < 0 ||
                posterTimestampMs >= durationMs
              ) {
                throw new TypeError("poster timestamp is outside the source duration");
              }
              const requests = [
                {
                  role: "poster" as const,
                  requestedTimestampMs: posterTimestampMs,
                  timestampMs: posterTimestampMs,
                },
                { role: "first" as const, requestedTimestampMs: null, timestampMs: 0 },
                {
                  role: "midpoint" as const,
                  requestedTimestampMs: null,
                  timestampMs: Math.floor(durationMs / 2),
                },
              ] as const;
              const extracted: MediaTransformVideoFrame[] = [];
              for (const request of requests) {
                const outputPath = join(directory, `${request.role}.jpg`);
                await runTool(
                  [
                    ffmpeg,
                    "-nostdin",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-i",
                    inputPath,
                    "-ss",
                    seconds(request.timestampMs),
                    "-frames:v",
                    "1",
                    "-an",
                    "-vf",
                    `scale=w='if(gt(iw,ih),min(${input.posterPolicy.maxEdgePx},iw),-2)':h='if(gt(iw,ih),-2,min(${input.posterPolicy.maxEdgePx},ih))'`,
                    "-q:v",
                    "2",
                    "-f",
                    "image2",
                    outputPath,
                  ],
                  timeoutMs,
                );
                const bytes = new Uint8Array(await readFile(outputPath));
                if (
                  bytes.byteLength === 0 ||
                  bytes.byteLength > input.posterPolicy.maxBytesPerFrame
                ) {
                  throw new Error("video frame exceeded the extraction policy");
                }
                const canonicalSha256 = await mediaSha256Bytes(bytes);
                const stored = await options.artifactWriter.write({
                  artifactKey: `video/${input.source.sha256}/v${input.binding.videoRevision}/${request.role}.jpg`,
                  bytes,
                  mediaType: "image/jpeg",
                  canonicalSha256,
                });
                if (!validIdentifier(stored.artifactRef))
                  throw new Error("invalid video artifact ref");
                extracted.push({
                  role: request.role,
                  requestedTimestampMs: request.requestedTimestampMs,
                  timestampMs: request.timestampMs,
                  sha256: canonicalSha256,
                  artifactRef: stored.artifactRef,
                });
              }
              return {
                evidenceRef: `video-frames:${input.source.sha256}:${LOCAL_VIDEO_FRAME_EXTRACTION_POLICY}`,
                adapterRevision: LOCAL_VIDEO_FFMPEG_REVISION,
                sourceSha256: input.source.sha256,
                videoRevision: input.binding.videoRevision,
                posterPolicyRevision: input.posterPolicy.policyRevision,
                frames: extracted as [
                  (typeof extracted)[number],
                  (typeof extracted)[number],
                  (typeof extracted)[number],
                ],
              };
            }).then((extraction) => ({
              status: "completed" as const,
              attempt: input.attempt,
              context: context(input),
              extraction,
            })),
          ),
  };
}

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1_024 &&
    value.trim() === value &&
    !value.includes("\u0000")
  );
}
