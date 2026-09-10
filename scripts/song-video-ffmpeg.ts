import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mediaSha256Bytes } from "@pirate/application/media/submission-service";
import type {
  CanonicalSongProbe,
  CanonicalSongProber,
  PendingSongTiming,
} from "@pirate/application/video/song-canonical-timing";
import {
  DEFAULT_TOOL_TIMEOUT_MS,
  makePinnedVersionCheck,
  runPinnedTool,
  withVerifiedTempSource,
} from "./pinned-ffmpeg.ts";

/**
 * The local song-video engine: it measures a canonical song and renders a
 * song-backed master, on one pinned decode and resample policy.
 *
 * Both jobs decode the canonical audio through exactly `SONG_VIDEO_DECODE_CHAIN`,
 * so the duration a plan was frozen against and the samples a master is cut
 * from are the same samples. The chain fixes the sample format as well as the
 * rate: without that, a lossless encoder stores a wider format and the decoded
 * master no longer matches the canonical interval bit for bit.
 *
 * Rendering trims in sample coordinates, never maps the captured audio, pads
 * nothing, and verifies the encoded output before returning it. The master's
 * audio is FLAC because it is the codec here whose MP4 track ends on an exact
 * sample: AAC and Opus both decode to their frame padding past the interval.
 */

export const SONG_VIDEO_DECODE_CHAIN =
  "aresample=48000,aformat=sample_fmts=s16:channel_layouts=stereo";
export const LOCAL_SONG_VIDEO_ENGINE_IDENTITY = "ffmpeg-6.1.1-song-video-v1";
export const LOCAL_SONG_VIDEO_POLICY_REVISION = 1;

const SAMPLE_RATE_HZ = 48_000;
const CHANNELS = 2;
const BYTES_PER_FRAME = CHANNELS * 2;
const MASTER_FRAME_RATE = 30;
const SAMPLES_PER_VIDEO_FRAME = SAMPLE_RATE_HZ / MASTER_FRAME_RATE;
const EXPECTED_VERSION_PREFIX = "ffmpeg version 6.1.1";
const EXPECTED_PROBE_VERSION_PREFIX = "ffprobe version 6.1.1";

/** Reads immutable media by reference. Bytes are verified by the engine, not the reader. */
export interface SongVideoMediaReader {
  readonly read: (reference: string) => Promise<Uint8Array>;
}

export type SongVideoRenderInput = Readonly<{
  source: Readonly<{ reference: string; sha256: string; byteLength: number }>;
  song: Readonly<{ reference: string; sha256: string; durationSamples: number }>;
  clipStartSamples: number;
  clipDurationSamples: number;
}>;

/** Measured facts about a master, in 48 kHz samples. */
export type SongVideoMasterFacts = Readonly<{
  videoDurationSamples: number;
  audioDurationSamples: number;
  audioSampleRateHz: number;
  audioChannels: number;
  hasVideoTrack: boolean;
}>;

export type SongVideoRenderResult =
  | Readonly<{
      ok: true;
      masterBytes: Uint8Array;
      masterSha256: string;
      facts: SongVideoMasterFacts;
      /** Digest of the master's decoded audio, equal to the canonical interval's. */
      soundtrackSha256: string;
    }>
  | Readonly<{ ok: false; reason: SongVideoRenderRefusal }>;

export type SongVideoRenderRefusal =
  | "invalid_interval"
  | "canonical_duration_mismatch"
  | "source_video_too_short"
  | "master_not_exact"
  | "soundtrack_not_canonical";

export type LocalSongVideoEngineOptions = Readonly<{
  mediaReader: SongVideoMediaReader;
  ffmpegBinary?: string;
  ffprobeBinary?: string;
  timeoutMs?: number;
}>;

export type LocalSongVideoEngine = Readonly<{
  identity: string;
  policyRevision: number;
  prober: CanonicalSongProber;
  render: (input: SongVideoRenderInput) => Promise<SongVideoRenderResult>;
  probeMaster: (bytes: Uint8Array) => Promise<SongVideoMasterFacts | null>;
  /**
   * Seal-time soundtrack binding, independent of anything `render` reported:
   * the canonical interval decoded from the song's exact bytes, and a master's
   * audio decoded from its verified bytes, on the same chain.
   */
  canonicalIntervalDigest: (
    input: Readonly<{
      songAssetId: string;
      canonicalAudioSha256: string;
      songDurationSamples: number;
      clipStartSamples: number;
      clipDurationSamples: number;
    }>,
  ) => Promise<string | null>;
  decodedSoundtrackDigest: (masterBytes: Uint8Array) => Promise<string | null>;
}>;

type ProbeStream = Readonly<Record<string, unknown>>;

const quiet = ["-nostdin", "-hide_banner", "-loglevel", "error"] as const;

function samplesFromTimeBase(durationTs: unknown, timeBase: unknown): number | null {
  const ticks = typeof durationTs === "string" ? Number(durationTs) : durationTs;
  if (typeof ticks !== "number" || !Number.isSafeInteger(ticks) || ticks < 0) return null;
  if (typeof timeBase !== "string") return null;
  const match = /^(\d+)\/(\d+)$/u.exec(timeBase);
  if (match === null) return null;
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  if (numerator < 1 || denominator < 1) return null;
  const samples = (ticks * numerator * SAMPLE_RATE_HZ) / denominator;
  return Number.isSafeInteger(samples) ? samples : null;
}

export function makeLocalPinnedFfmpegSongVideoEngine(
  options: LocalSongVideoEngineOptions,
): LocalSongVideoEngine {
  const ffmpeg = options.ffmpegBinary ?? "ffmpeg";
  const ffprobe = options.ffprobeBinary ?? "ffprobe";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10 * 60 * 1_000) {
    throw new TypeError("local song-video tool timeout must be bounded");
  }
  const assertPinnedVersion = makePinnedVersionCheck({
    ffmpeg,
    ffprobe,
    timeoutMs,
    ffmpegVersionPrefix: EXPECTED_VERSION_PREFIX,
    ffprobeVersionPrefix: EXPECTED_PROBE_VERSION_PREFIX,
    failureMessage: "local song-video engine is not pinned FFmpeg 6.1.1",
  });

  /** Decodes through the canonical chain into a raw file and counts its samples. */
  const decodeCount = async (
    inputPath: string,
    outputPath: string,
    trim?: Readonly<{ start: number; end: number }>,
  ): Promise<number> => {
    const filter =
      trim === undefined
        ? SONG_VIDEO_DECODE_CHAIN
        : `${SONG_VIDEO_DECODE_CHAIN},atrim=start_sample=${trim.start}:end_sample=${trim.end}`;
    await runPinnedTool(
      [
        ffmpeg,
        ...quiet,
        "-i",
        inputPath,
        "-map",
        "0:a:0",
        "-af",
        filter,
        "-c:a",
        "pcm_s16le",
        "-f",
        "s16le",
        outputPath,
      ],
      timeoutMs,
    );
    const { size } = await stat(outputPath);
    if (size % BYTES_PER_FRAME !== 0) throw new Error("song-video decode is not whole frames");
    return size / BYTES_PER_FRAME;
  };

  const probeStreams = async (path: string): Promise<readonly ProbeStream[]> => {
    const result = await runPinnedTool(
      [
        ffprobe,
        "-v",
        "error",
        "-show_entries",
        "stream=index,codec_type,codec_name,time_base,duration_ts,sample_rate,channels,nb_frames",
        "-of",
        "json",
        path,
      ],
      timeoutMs,
    );
    const document = JSON.parse(result.stdout) as { streams?: readonly ProbeStream[] };
    return document.streams ?? [];
  };

  const factsFromStreams = (streams: readonly ProbeStream[]): SongVideoMasterFacts | null => {
    const video = streams.filter((stream) => stream.codec_type === "video");
    const audio = streams.filter((stream) => stream.codec_type === "audio");
    // Exactly one of each, and only these codecs: a master with a second audio
    // track could carry the discarded capture beside the canonical soundtrack.
    if (video.length !== 1 || audio.length !== 1 || streams.length !== 2) return null;
    const [videoStream] = video;
    const [audioStream] = audio;
    if (videoStream?.codec_name !== "h264" || audioStream?.codec_name !== "flac") return null;
    const videoDurationSamples = samplesFromTimeBase(
      videoStream.duration_ts,
      videoStream.time_base,
    );
    const audioDurationSamples = samplesFromTimeBase(
      audioStream.duration_ts,
      audioStream.time_base,
    );
    const audioSampleRateHz = Number(audioStream.sample_rate);
    const audioChannels = Number(audioStream.channels);
    if (videoDurationSamples === null || audioDurationSamples === null) return null;
    return {
      videoDurationSamples,
      audioDurationSamples,
      audioSampleRateHz,
      audioChannels,
      hasVideoTrack: true,
    };
  };

  const prober: CanonicalSongProber = {
    identity: LOCAL_SONG_VIDEO_ENGINE_IDENTITY,
    policyRevision: LOCAL_SONG_VIDEO_POLICY_REVISION,
    measure: async (pending: PendingSongTiming): Promise<CanonicalSongProbe> => {
      try {
        await assertPinnedVersion();
      } catch {
        return { ok: false, permanent: false, failureCode: "probe_unavailable" };
      }
      let bytes: Uint8Array;
      try {
        bytes = await options.mediaReader.read(pending.audioAssetRef);
      } catch {
        return { ok: false, permanent: false, failureCode: "probe_unavailable" };
      }
      if ((await mediaSha256Bytes(bytes)) !== pending.canonicalAudioSha256) {
        return { ok: false, permanent: true, failureCode: "source_digest_mismatch" };
      }
      try {
        const durationSamples = await withVerifiedTempSource(
          {
            bytes,
            expectedSha256: pending.canonicalAudioSha256,
            fileName: "song.bin",
            workspacePrefix: "pirate-song-measure-",
            lengthMismatchMessage: "song length mismatch",
            digestMismatchMessage: "song digest mismatch",
          },
          (inputPath, directory) => decodeCount(inputPath, join(directory, "song.pcm")),
        );
        if (!Number.isSafeInteger(durationSamples) || durationSamples < 1) {
          return { ok: false, permanent: true, failureCode: "undecodable_audio" };
        }
        return { ok: true, durationSamples };
      } catch (error) {
        return error instanceof Error && error.message === "video tool timed out"
          ? { ok: false, permanent: false, failureCode: "probe_unavailable" }
          : { ok: false, permanent: true, failureCode: "undecodable_audio" };
      }
    },
  };

  const probeMaster = async (bytes: Uint8Array): Promise<SongVideoMasterFacts | null> => {
    await assertPinnedVersion();
    return withVerifiedTempSource(
      {
        bytes,
        expectedSha256: await mediaSha256Bytes(bytes),
        fileName: "master.mp4",
        workspacePrefix: "pirate-song-probe-",
        lengthMismatchMessage: "master length mismatch",
        digestMismatchMessage: "master digest mismatch",
      },
      async (path) => {
        try {
          return factsFromStreams(await probeStreams(path));
        } catch {
          return null;
        }
      },
    );
  };

  /** A master's single audio track, decoded exactly as rendering verified it. */
  const decodeMasterAudio = (masterPath: string, outputPath: string) =>
    runPinnedTool(
      [
        ffmpeg,
        ...quiet,
        "-i",
        masterPath,
        "-map",
        "0:a:0",
        "-c:a",
        "pcm_s16le",
        "-f",
        "s16le",
        outputPath,
      ],
      timeoutMs,
    );

  const canonicalIntervalDigest: LocalSongVideoEngine["canonicalIntervalDigest"] = async (
    input,
  ) => {
    const end = input.clipStartSamples + input.clipDurationSamples;
    if (
      !Number.isSafeInteger(input.clipStartSamples) ||
      !Number.isSafeInteger(input.clipDurationSamples) ||
      input.clipStartSamples < 0 ||
      input.clipDurationSamples < 1 ||
      !Number.isSafeInteger(end) ||
      end > input.songDurationSamples
    )
      return null;
    await assertPinnedVersion();
    const bytes = await options.mediaReader.read(input.songAssetId);
    if ((await mediaSha256Bytes(bytes)) !== input.canonicalAudioSha256) return null;
    return withVerifiedTempSource(
      {
        bytes,
        expectedSha256: input.canonicalAudioSha256,
        fileName: "song.bin",
        workspacePrefix: "pirate-song-interval-",
        lengthMismatchMessage: "song length mismatch",
        digestMismatchMessage: "song digest mismatch",
      },
      async (songPath, directory) => {
        const total = await decodeCount(songPath, join(directory, "canonical.pcm"));
        if (total !== input.songDurationSamples) return null;
        const intervalPath = join(directory, "interval.pcm");
        const samples = await decodeCount(songPath, intervalPath, {
          start: input.clipStartSamples,
          end,
        });
        if (samples !== input.clipDurationSamples) return null;
        return mediaSha256Bytes(new Uint8Array(await readFile(intervalPath)));
      },
    );
  };

  const decodedSoundtrackDigest: LocalSongVideoEngine["decodedSoundtrackDigest"] = async (
    masterBytes,
  ) => {
    await assertPinnedVersion();
    return withVerifiedTempSource(
      {
        bytes: masterBytes,
        expectedSha256: await mediaSha256Bytes(masterBytes),
        fileName: "master.mp4",
        workspacePrefix: "pirate-song-soundtrack-",
        lengthMismatchMessage: "master length mismatch",
        digestMismatchMessage: "master digest mismatch",
      },
      async (masterPath, directory) => {
        const outputPath = join(directory, "master-audio.pcm");
        try {
          await decodeMasterAudio(masterPath, outputPath);
        } catch {
          return null;
        }
        return mediaSha256Bytes(new Uint8Array(await readFile(outputPath)));
      },
    );
  };

  const render = async (input: SongVideoRenderInput): Promise<SongVideoRenderResult> => {
    const start = input.clipStartSamples;
    const duration = input.clipDurationSamples;
    const end = start + duration;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(duration) ||
      start < 0 ||
      duration < 1 ||
      !Number.isSafeInteger(end) ||
      end > input.song.durationSamples
    ) {
      return { ok: false, reason: "invalid_interval" };
    }
    await assertPinnedVersion();
    const songBytes = await options.mediaReader.read(input.song.reference);
    const sourceBytes = await options.mediaReader.read(input.source.reference);
    return withVerifiedTempSource(
      {
        bytes: songBytes,
        expectedSha256: input.song.sha256,
        fileName: "song.bin",
        workspacePrefix: "pirate-song-render-",
        lengthMismatchMessage: "song length mismatch",
        digestMismatchMessage: "song digest mismatch",
      },
      async (songPath, directory) => {
        // The source is bound to its digest in the same workspace.
        if (sourceBytes.byteLength !== input.source.byteLength) {
          throw new Error("source length mismatch");
        }
        if ((await mediaSha256Bytes(sourceBytes)) !== input.source.sha256) {
          throw new Error("source digest mismatch");
        }
        const sourcePath = join(directory, "source.mp4");
        await writeFile(sourcePath, sourceBytes, { flag: "wx" });

        // The same pinned policy that froze the plan must reproduce its length;
        // otherwise the interval was contained in a different decode.
        const canonicalSamples = await decodeCount(songPath, join(directory, "canonical.pcm"));
        if (canonicalSamples !== input.song.durationSamples) {
          return { ok: false, reason: "canonical_duration_mismatch" } as const;
        }
        const intervalPath = join(directory, "interval.pcm");
        const intervalSamples = await decodeCount(songPath, intervalPath, { start, end });
        if (intervalSamples !== duration) return { ok: false, reason: "invalid_interval" } as const;
        const intervalSha256 = await mediaSha256Bytes(new Uint8Array(await readFile(intervalPath)));

        // Pass one: canonical audio cut in samples, video normalized to a fixed
        // rate and cut to the frames that begin inside the interval. The
        // captured audio (0:a) is never mapped, so it cannot reach the master.
        const frames = Math.ceil(duration / SAMPLES_PER_VIDEO_FRAME);
        const passOne = join(directory, "pass-one.mp4");
        await runPinnedTool(
          [
            ffmpeg,
            ...quiet,
            "-i",
            sourcePath,
            "-i",
            songPath,
            "-filter_complex",
            `[1:a:0]${SONG_VIDEO_DECODE_CHAIN},atrim=start_sample=${start}:end_sample=${end},asetpts=N/SR/TB[a];` +
              `[0:v:0]fps=${MASTER_FRAME_RATE},trim=end_frame=${frames},setpts=PTS-STARTPTS[v]`,
            "-map",
            "[v]",
            "-map",
            "[a]",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            "-pix_fmt",
            "yuv420p",
            "-bf",
            "0",
            "-c:a",
            "flac",
            "-video_track_timescale",
            String(SAMPLE_RATE_HZ),
            "-f",
            "mp4",
            passOne,
          ],
          timeoutMs,
        );
        const passOneVideo = (await probeStreams(passOne)).find(
          (stream) => stream.codec_type === "video",
        );
        if (Number(passOneVideo?.nb_frames) !== frames) {
          // Fewer frames than the interval spans: the recording ends before the
          // song interval does. Nothing is padded to cover it.
          return { ok: false, reason: "source_video_too_short" } as const;
        }
        const packets = await runPinnedTool(
          [
            ffprobe,
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "packet=pts",
            "-of",
            "csv=p=0",
            passOne,
          ],
          timeoutMs,
        );
        const lastPts = Number(packets.stdout.trim().split("\n").at(-1));
        const lastDuration = duration - lastPts;
        if (
          !Number.isSafeInteger(lastPts) ||
          lastDuration < 1 ||
          lastDuration > SAMPLES_PER_VIDEO_FRAME
        ) {
          return { ok: false, reason: "master_not_exact" } as const;
        }

        // Pass two, copy only: the final frame is held to the interval's last
        // sample, so the video track ends exactly where the audio does.
        const masterPath = join(directory, "master.mp4");
        await runPinnedTool(
          [
            ffmpeg,
            ...quiet,
            "-i",
            passOne,
            "-map",
            "0",
            "-c",
            "copy",
            "-bsf:v",
            `setts=duration=if(eq(N\\,${frames - 1})\\,${lastDuration}\\,DURATION)`,
            "-video_track_timescale",
            String(SAMPLE_RATE_HZ),
            "-movflags",
            "+faststart",
            "-f",
            "mp4",
            masterPath,
          ],
          timeoutMs,
        );

        // Verification of the encoded output, not of the intent.
        const facts = factsFromStreams(await probeStreams(masterPath));
        if (
          facts === null ||
          facts.videoDurationSamples !== duration ||
          facts.audioDurationSamples !== duration ||
          facts.audioSampleRateHz !== SAMPLE_RATE_HZ ||
          facts.audioChannels !== CHANNELS
        ) {
          return { ok: false, reason: "master_not_exact" } as const;
        }
        const soundtrackPath = join(directory, "master-audio.pcm");
        await decodeMasterAudio(masterPath, soundtrackPath);
        const soundtrackSha256 = await mediaSha256Bytes(
          new Uint8Array(await readFile(soundtrackPath)),
        );
        // Lossless and on one decode chain, so the master's audio is the
        // canonical interval bit for bit — or it is not the selected soundtrack.
        if (soundtrackSha256 !== intervalSha256) {
          return { ok: false, reason: "soundtrack_not_canonical" } as const;
        }
        const masterBytes = new Uint8Array(await readFile(masterPath));
        return {
          ok: true,
          masterBytes,
          masterSha256: await mediaSha256Bytes(masterBytes),
          facts,
          soundtrackSha256,
        } as const;
      },
    );
  };

  return {
    identity: LOCAL_SONG_VIDEO_ENGINE_IDENTITY,
    policyRevision: LOCAL_SONG_VIDEO_POLICY_REVISION,
    prober,
    render,
    probeMaster,
    canonicalIntervalDigest,
    decodedSoundtrackDigest,
  };
}
