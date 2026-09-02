import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";

import {
  isH264IdrAccessUnit,
  parseFfprobeHexdump,
  readAvccNalUnitTypes,
} from "./video-master-renderer-h264.ts";
import {
  copiedPayloadsMatch,
  evaluateCopyEligibility,
  type ProbedVideoPacket,
  selectBriefPacketWindow,
} from "./video-master-renderer-packet-policy.ts";

const aacFrameSamples = 1_024;
const audioSampleRate = 48_000;
const requestedDurationMs = 1_887;
const songClipStartSeconds = 0.75;

const PacketProbe = Schema.Struct({
  packets: Schema.Array(
    Schema.Struct({
      pts_time: Schema.String,
      dts_time: Schema.String,
      duration_time: Schema.String,
      flags: Schema.String,
      data_hash: Schema.String,
    }),
  ),
});

const StreamProbe = Schema.Struct({
  streams: Schema.Array(
    Schema.Struct({
      codec_name: Schema.String,
      codec_type: Schema.String,
      has_b_frames: Schema.optional(Schema.Number),
      duration: Schema.optional(Schema.String),
      duration_ts: Schema.optional(Schema.Number),
      nb_frames: Schema.optional(Schema.String),
      channels: Schema.optional(Schema.Number),
      channel_layout: Schema.optional(Schema.String),
    }),
  ),
});

const PacketDataProbe = Schema.Struct({
  packets: Schema.Array(
    Schema.Struct({
      pts_time: Schema.String,
      flags: Schema.String,
      data: Schema.String,
    }),
  ),
});

const AudioPacketProbe = Schema.Struct({
  packets: Schema.Array(
    Schema.Struct({
      pts: Schema.Number,
      duration: Schema.Number,
      side_data_list: Schema.optional(
        Schema.Array(
          Schema.Struct({
            side_data_type: Schema.String,
            skip_samples: Schema.optional(Schema.Number),
            discard_padding: Schema.optional(Schema.Number),
          }),
        ),
      ),
    }),
  ),
});

async function run(command: string, arguments_: readonly string[]): Promise<Uint8Array> {
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
  return new Uint8Array(stdout);
}

async function probeVideoPackets(path: string): Promise<readonly ProbedVideoPacket[]> {
  const bytes = await run("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "packet=pts_time,dts_time,duration_time,flags,data_hash",
    "-show_data_hash",
    "sha256",
    "-of",
    "json",
    path,
  ]);
  const document = Schema.decodeUnknownSync(PacketProbe)(
    JSON.parse(new TextDecoder().decode(bytes)),
  );
  return document.packets.map((packet, decodeOrder) => ({
    decodeOrder,
    ptsMs: Number(packet.pts_time) * 1_000,
    dtsMs: Number(packet.dts_time) * 1_000,
    durationMs: Number(packet.duration_time) * 1_000,
    keyframe: packet.flags.includes("K"),
    payloadSha256: packet.data_hash,
  }));
}

async function probeStreams(path: string) {
  const bytes = await run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "stream=codec_name,codec_type,has_b_frames,duration,duration_ts,nb_frames,channels,channel_layout",
    "-of",
    "json",
    path,
  ]);
  return Schema.decodeUnknownSync(StreamProbe)(JSON.parse(new TextDecoder().decode(bytes))).streams;
}

async function probeAudioPackets(path: string) {
  const bytes = await run("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "a:0",
    "-show_packets",
    "-of",
    "json",
    path,
  ]);
  return Schema.decodeUnknownSync(AudioPacketProbe)(JSON.parse(new TextDecoder().decode(bytes)))
    .packets;
}

async function probeH264AccessUnit(path: string, startMs: number) {
  const bytes = await run("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-read_intervals",
    `${seconds(startMs)}%+0.040000000`,
    "-show_packets",
    "-show_entries",
    "packet=pts_time,flags,data",
    "-show_data",
    "-of",
    "json",
    path,
  ]);
  const document = Schema.decodeUnknownSync(PacketDataProbe)(
    JSON.parse(new TextDecoder().decode(bytes)),
  );
  const packet = document.packets.find(
    (candidate) => Math.abs(Number(candidate.pts_time) * 1_000 - startMs) <= 0.002,
  );
  if (!packet?.flags.includes("K")) {
    throw new Error("copy start packet data is unavailable or not keyframe-flagged");
  }
  const accessUnit = parseFfprobeHexdump(packet.data);
  return {
    nalUnitTypes: readAvccNalUnitTypes(accessUnit),
    isIdr: isH264IdrAccessUnit(accessUnit),
  } as const;
}

function seconds(milliseconds: number): string {
  return (milliseconds / 1_000).toFixed(9);
}

export async function runNoReorderCopyEvidence(workingDirectory: string) {
  const sourcePath = join(workingDirectory, "source-h264-no-reorder.mp4");
  const songPath = join(workingDirectory, "canonical-song.wav");
  const masterPath = join(workingDirectory, "master.mp4");

  await run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=30:duration=4",
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-pix_fmt",
    "yuv420p",
    "-g",
    "30",
    "-keyint_min",
    "30",
    "-sc_threshold",
    "0",
    "-bf",
    "0",
    "-movflags",
    "+frag_keyframe+empty_moov+default_base_moof",
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

  const sourceStreams = await probeStreams(sourcePath);
  const sourceVideo = sourceStreams.find((stream) => stream.codec_type === "video");
  if (!sourceVideo || sourceVideo.has_b_frames === undefined) {
    throw new Error("source video probe facts are incomplete");
  }
  const sourcePackets = await probeVideoPackets(sourcePath);
  const sourceStart = sourcePackets.filter((packet) => packet.keyframe)[1]?.ptsMs;
  if (sourceStart === undefined) throw new Error("source has no second keyframe");
  const startAccessUnit = await probeH264AccessUnit(sourcePath, sourceStart);
  const eligibility = evaluateCopyEligibility({
    codecName: sourceVideo.codec_name,
    hasBFrames: sourceVideo.has_b_frames,
    copyStartIsIdr: startAccessUnit.isIdr,
    packets: sourcePackets,
    startMs: sourceStart,
    requestedDurationMs,
  });
  if (!eligibility.eligible)
    throw new Error(`fixture was not copy eligible: ${eligibility.reason}`);

  const targetPcmSamples = Math.round(
    (eligibility.window.effectiveDurationMs * audioSampleRate) / 1_000,
  );
  const paddedPcmSamples = Math.ceil(targetPcmSamples / aacFrameSamples) * aacFrameSamples;
  const masterDurationSeconds = seconds(eligibility.window.effectiveDurationMs);
  const audioFilter =
    `[1:a:0]atrim=start=${songClipStartSeconds.toFixed(6)}:duration=${masterDurationSeconds},` +
    `asetpts=PTS-STARTPTS,apad=whole_len=${paddedPcmSamples}[a]`;
  const renderArguments = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-ss",
    seconds(sourceStart),
    "-i",
    sourcePath,
    "-i",
    songPath,
    "-filter_complex",
    audioFilter,
    "-map",
    "0:v:0",
    "-map",
    "[a]",
    "-t",
    masterDurationSeconds,
    "-shortest",
    "-c:v",
    "copy",
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
  const renderStarted = performance.now();
  await run("ffmpeg", renderArguments);
  const renderWallMs = performance.now() - renderStarted;

  const masterStreams = await probeStreams(masterPath);
  const masterVideo = masterStreams.find((stream) => stream.codec_type === "video");
  const masterAudio = masterStreams.find((stream) => stream.codec_type === "audio");
  if (
    !masterVideo?.duration ||
    !masterAudio?.duration ||
    masterAudio.duration_ts === undefined ||
    masterAudio.channels === undefined ||
    !masterAudio.channel_layout
  ) {
    throw new Error("master stream probe facts are incomplete");
  }
  const masterVideoPackets = await probeVideoPackets(masterPath);
  const masterDurationMs = Number(masterVideo.duration) * 1_000;
  const masterWindow = selectBriefPacketWindow(masterVideoPackets, 0, masterDurationMs);
  const audioPackets = await probeAudioPackets(masterPath);
  const priming = audioPackets[0]?.side_data_list?.find(
    (item) => item.side_data_type === "Skip Samples",
  );
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
  const masterBytes = new Uint8Array(await Bun.file(masterPath).arrayBuffer());

  return {
    ffmpegVersion: new TextDecoder().decode(await run("ffmpeg", ["-version"])).split("\n")[0],
    sourceHasBFrames: sourceVideo.has_b_frames,
    sourceStartNalUnitTypes: startAccessUnit.nalUnitTypes,
    sourceStartIsIdr: startAccessUnit.isIdr,
    sourceStartMs: sourceStart,
    requestedDurationMs,
    effectiveDurationMs: eligibility.window.effectiveDurationMs,
    selectedVideoPackets: eligibility.window.packets.length,
    sourcePacketManifestSha256: eligibility.window.packetManifestSha256,
    masterPacketManifestSha256: masterWindow.packetManifestSha256,
    copiedPacketPayloadsMatch: copiedPayloadsMatch(eligibility.window.packets, masterVideoPackets),
    masterVideoDurationMs: masterDurationMs,
    masterAudioPresentationDurationMs: Number(masterAudio.duration) * 1_000,
    audioChannels: masterAudio.channels,
    audioChannelLayout: masterAudio.channel_layout,
    decodedAudioSampleValues: decodedAudio.byteLength / 2,
    decodedAudioSamplesPerChannel: decodedAudio.byteLength / 2 / masterAudio.channels,
    audioPresentationSamplesPerChannel: masterAudio.duration_ts,
    audioPresentationSampleValues: masterAudio.duration_ts * masterAudio.channels,
    audioPrimingSamplesPerChannel: priming?.skip_samples ?? 0,
    audioPrimingSampleValues: (priming?.skip_samples ?? 0) * masterAudio.channels,
    audioPaddingSamplesPerChannel: paddedPcmSamples - targetPcmSamples,
    audioPaddingSampleValues: (paddedPcmSamples - targetPcmSamples) * masterAudio.channels,
    encodedAacPackets: audioPackets.length,
    paddedAacFrames: paddedPcmSamples / aacFrameSamples,
    masterMovieTimescale: audioSampleRate,
    targetPcmSamples,
    paddedPcmSamples,
    zeroPaddingSamples: paddedPcmSamples - targetPcmSamples,
    masterSha256: createHash("sha256").update(masterBytes).digest("hex"),
    renderWallMs,
    renderArguments,
  } as const;
}

if (import.meta.main) {
  const workingDirectory = await mkdtemp(join(tmpdir(), "api-video-renderer-evidence-"));
  try {
    console.log(JSON.stringify(await runNoReorderCopyEvidence(workingDirectory), null, 2));
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
}
