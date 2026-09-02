import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";

const audioSampleRate = 48_000;
const aacFrameSamples = 1_024;
const sourceStartSeconds = 0.4;
const songClipStartSeconds = 1.25;
const targetDurationSeconds = 1.8;

const StreamProbe = Schema.Struct({
  streams: Schema.Array(
    Schema.Struct({
      codec_name: Schema.String,
      codec_type: Schema.String,
      duration: Schema.optional(Schema.String),
      duration_ts: Schema.optional(Schema.Number),
      nb_read_frames: Schema.optional(Schema.String),
      width: Schema.optional(Schema.Number),
      height: Schema.optional(Schema.Number),
      sample_aspect_ratio: Schema.optional(Schema.String),
      channels: Schema.optional(Schema.Number),
      channel_layout: Schema.optional(Schema.String),
    }),
  ),
});

type CommandResult = {
  readonly stdout: Uint8Array;
  readonly stderr: string;
};

async function run(command: string, arguments_: readonly string[]): Promise<CommandResult> {
  const child = Bun.spawn([command, ...arguments_], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command} failed with exit ${exitCode}: ${stderr.trim()}`);
  }
  return { stdout: new Uint8Array(stdout), stderr };
}

async function probeStreams(path: string) {
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-count_frames",
    "-show_entries",
    "stream=codec_name,codec_type,duration,duration_ts,nb_read_frames,width,height,sample_aspect_ratio,channels,channel_layout",
    "-of",
    "json",
    path,
  ]);
  return Schema.decodeUnknownSync(StreamProbe)(JSON.parse(new TextDecoder().decode(stdout)))
    .streams;
}

async function measureFfmpeg(arguments_: readonly string[]) {
  const format = [
    "renderer_user_seconds=%U",
    "renderer_system_seconds=%S",
    "renderer_max_rss_kib=%M",
  ].join("\\n");
  const started = performance.now();
  const { stderr } = await run("/usr/bin/time", ["-f", format, "ffmpeg", ...arguments_]);
  const wallMs = performance.now() - started;
  const facts = Object.fromEntries(
    stderr
      .split("\n")
      .filter((line) => line.startsWith("renderer_"))
      .map((line) => line.split("=", 2)),
  );
  const userSeconds = Number(facts.renderer_user_seconds);
  const systemSeconds = Number(facts.renderer_system_seconds);
  const maximumResidentSetKiB = Number(facts.renderer_max_rss_kib);
  if (![userSeconds, systemSeconds, maximumResidentSetKiB].every(Number.isFinite)) {
    throw new Error("GNU time did not report complete renderer resource facts");
  }
  return { wallMs, userSeconds, systemSeconds, maximumResidentSetKiB } as const;
}

export async function runWebmFallbackEvidence(workingDirectory: string) {
  const sourcePath = join(workingDirectory, "source-vp9-opus.webm");
  const songPath = join(workingDirectory, "canonical-song-stereo.wav");
  const masterPath = join(workingDirectory, "master-h264-aac.mp4");
  const posterPath = join(workingDirectory, "poster-final-timeline.png");

  await run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=360x640:rate=30:duration=4",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=4",
    "-filter_complex",
    "[0:v:0]setsar=4/3[v]",
    "-map",
    "[v]",
    "-map",
    "1:a:0",
    "-c:v",
    "libvpx-vp9",
    "-deadline",
    "good",
    "-cpu-used",
    "4",
    "-g",
    "60",
    "-c:a",
    "libopus",
    "-ac",
    "1",
    sourcePath,
  ]);
  await run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=880:sample_rate=48000:duration=8",
    "-c:a",
    "pcm_s16le",
    "-ac",
    "2",
    "-channel_layout",
    "stereo",
    songPath,
  ]);

  const targetPcmSamplesPerChannel = Math.round(targetDurationSeconds * audioSampleRate);
  const paddedPcmSamplesPerChannel =
    Math.ceil(targetPcmSamplesPerChannel / aacFrameSamples) * aacFrameSamples;
  const audioFilter =
    `[1:a:0]atrim=start=${songClipStartSeconds.toFixed(6)}:duration=${targetDurationSeconds.toFixed(9)},` +
    `asetpts=PTS-STARTPTS,apad=whole_len=${paddedPcmSamplesPerChannel}[a]`;
  const renderArguments = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    sourcePath,
    "-i",
    songPath,
    "-filter_complex",
    `[0:v:0]trim=start=${sourceStartSeconds.toFixed(9)}:duration=${targetDurationSeconds.toFixed(9)},` +
      `setpts=PTS-STARTPTS,scale=320:568:flags=bicubic,setsar=1,format=yuv420p[v];${audioFilter}`,
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-t",
    targetDurationSeconds.toFixed(9),
    "-shortest",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-pix_fmt",
    "yuv420p",
    "-r",
    "30",
    "-g",
    "30",
    "-keyint_min",
    "30",
    "-sc_threshold",
    "0",
    "-bf",
    "0",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ar",
    String(audioSampleRate),
    "-ac",
    "2",
    "-channel_layout",
    "stereo",
    "-movflags",
    "+faststart",
    "-use_editlist",
    "1",
    "-movie_timescale",
    String(audioSampleRate),
    masterPath,
  ] as const;
  const resources = await measureFfmpeg(renderArguments);
  await run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-ss",
    "0.900000000",
    "-i",
    masterPath,
    "-frames:v",
    "1",
    posterPath,
  ]);

  const sourceStreams = await probeStreams(sourcePath);
  const masterStreams = await probeStreams(masterPath);
  const posterStreams = await probeStreams(posterPath);
  const sourceVideo = sourceStreams.find((stream) => stream.codec_type === "video");
  const sourceAudio = sourceStreams.find((stream) => stream.codec_type === "audio");
  const masterVideo = masterStreams.find((stream) => stream.codec_type === "video");
  const masterAudio = masterStreams.find((stream) => stream.codec_type === "audio");
  const posterVideo = posterStreams.find((stream) => stream.codec_type === "video");
  if (
    !sourceVideo?.sample_aspect_ratio ||
    !sourceAudio ||
    !masterVideo?.duration ||
    !masterVideo.sample_aspect_ratio ||
    !masterAudio?.duration ||
    masterAudio.duration_ts === undefined ||
    masterAudio.channels === undefined ||
    !masterAudio.channel_layout ||
    posterVideo?.codec_name !== "png"
  ) {
    throw new Error("fallback stream probe facts are incomplete");
  }

  const decodedAudio = await run("ffmpeg", [
    "-v",
    "error",
    "-i",
    masterPath,
    "-map",
    "0:a:0",
    "-f",
    "s16le",
    "-acodec",
    "pcm_s16le",
    "-ar",
    String(audioSampleRate),
    "-ac",
    "2",
    "pipe:1",
  ]);

  const masterVideoDurationMs = Number(masterVideo.duration) * 1_000;
  const masterAudioDurationMs = Number(masterAudio.duration) * 1_000;
  const posterBytes = new Uint8Array(await Bun.file(posterPath).arrayBuffer());
  return {
    sourceVideoCodec: sourceVideo.codec_name,
    sourceAudioCodec: sourceAudio.codec_name,
    sourceSampleAspectRatio: sourceVideo.sample_aspect_ratio,
    outputVideoCodec: masterVideo.codec_name,
    outputAudioCodec: masterAudio.codec_name,
    outputWidth: masterVideo.width,
    outputHeight: masterVideo.height,
    outputSampleAspectRatio: masterVideo.sample_aspect_ratio,
    outputVideoFrames: Number(masterVideo.nb_read_frames),
    outputChannels: masterAudio.channels,
    outputChannelLayout: masterAudio.channel_layout,
    masterVideoDurationMs,
    masterAudioDurationMs,
    audioVideoDeltaMs: Math.abs(masterVideoDurationMs - masterAudioDurationMs),
    audioPresentationSamplesPerChannel: masterAudio.duration_ts,
    decodedAudioSamplesPerChannel: decodedAudio.stdout.byteLength / 2 / masterAudio.channels,
    targetPcmSamplesPerChannel,
    paddedPcmSamplesPerChannel,
    posterTimelineMs: 900,
    posterWidth: posterVideo.width,
    posterHeight: posterVideo.height,
    posterSha256: createHash("sha256").update(posterBytes).digest("hex"),
    resources,
    renderArguments,
  } as const;
}

if (import.meta.main) {
  const workingDirectory = await mkdtemp(join(tmpdir(), "api-video-fallback-evidence-"));
  try {
    console.log(JSON.stringify(await runWebmFallbackEvidence(workingDirectory), null, 2));
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
}
