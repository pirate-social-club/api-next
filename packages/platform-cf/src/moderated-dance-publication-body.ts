import { Schema } from "effect";
import { readModeratedDanceExport } from "./moderated-dance-normalization.ts";
import type { decodeModeratedDancePublicationBodyObservation } from "./moderated-dance-publication-observation.ts";
import { sha256Hex } from "./r2-upload-signing.ts";
import { SONG_VIDEO_CLOUDCONVERT_FFMPEG_VERSION as ENGINE } from "./song-video-cloudconvert-recipe.ts";
import { inspectSilentSongVideoInputStructure } from "./song-video-master-verifier/master-structure.ts";

const Id = Schema.NonEmptyString.check(Schema.isMaxLength(192));
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Millis = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8.64e15 }));
const Binding = Schema.Struct({
  tag: Id,
  reviewId: Id,
  sourceSha256: Hash,
  bodyStartMs: Millis,
  bodyEndMs: Millis,
});
const decode = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
): S["Type"] => Schema.decodeUnknownSync(schema, { onExcessProperty: "ignore" })(value);
function binding(raw: unknown) {
  const b = decode(Binding, raw),
    durationMs = b.bodyEndMs - b.bodyStartMs;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u.test(b.tag) ||
    durationMs < 6000 ||
    durationMs > 30000
  )
    throw new Error("Dance publication body binding refused");
  return { ...b, durationMs };
}

/** Fixed paths/numeric arguments only. Two passes preserve the final partial
 * frame at 48kHz instead of rounding an edit list to the MP4 1kHz default.
 * Original recorded audio is excluded; normal Post rendering adds the song. */
export function makeModeratedDancePublicationBodyCommands(bodyStartMs: number, bodyEndMs: number) {
  const b = binding({
      tag: "recipe",
      reviewId: "recipe",
      sourceSha256: "0".repeat(64),
      bodyStartMs,
      bodyEndMs,
    }),
    samples = b.durationMs * 48,
    frames = Math.ceil(samples / 1600),
    last = samples - (frames - 1) * 1600,
    seconds = (ms: number) => (ms / 1000).toFixed(3);
  return {
    passOne:
      "-hide_banner -nostdin -loglevel error -i /input/import-recording/source.mp4 " +
      `-map 0:v:0 -an -sn -dn -vf 'trim=start=${seconds(bodyStartMs)}:end=${seconds(bodyEndMs)},setpts=PTS-STARTPTS,fps=fps=30:start_time=0:round=up:eof_action=pass,trim=end_frame=${frames},scale=w=min(1280\\,iw):h=min(1280\\,ih):force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p' ` +
      "-c:v libx264 -preset veryfast -crf 18 -maxrate 3000k -bufsize 6000k -bf 0 -video_track_timescale 48000 " +
      "-map_metadata -1 -map_chapters -1 -f mp4 /output/body-pass-one.mp4",
    passTwo:
      "-hide_banner -nostdin -loglevel error -i /input/trim-recording/body-pass-one.mp4 -map 0:v:0 -an -sn -dn -c:v copy " +
      `-bsf:v 'setts=duration=if(eq(N\\,${frames - 1})\\,${last}\\,DURATION)' ` +
      "-video_track_timescale 48000 -movie_timescale 48000 -map_metadata -1 -map_chapters -1 -movflags +faststart -f mp4 /output/body.mp4",
    frameCount: frames,
  };
}

/** The caller supplies only a committed, short-lived purpose-specific source
 * capability. Never persist this URL or the returned export URL. Source and
 * provider effect authorization are owned by the durable handoff protocol. */
export function makeModeratedDancePublicationBodyJob(
  raw: unknown,
  sourceUrl: string,
  timeoutSeconds: number,
) {
  const b = binding(raw),
    url = new URL(sourceUrl);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !/^\/\.well-known\/pirate\/video-source\/v1\/[A-Za-z0-9_-]{43}$/u.test(url.pathname) ||
    !Number.isSafeInteger(timeoutSeconds) ||
    timeoutSeconds < 1 ||
    timeoutSeconds > 300
  )
    throw new Error("Dance publication provider bounds refused");
  const commands = makeModeratedDancePublicationBodyCommands(b.bodyStartMs, b.bodyEndMs);
  const command = (input: string, arguments_: string) => ({
    operation: "command",
    input,
    engine: "ffmpeg",
    engine_version: ENGINE,
    command: "ffmpeg",
    arguments: arguments_,
    capture_output: false,
    timeout: timeoutSeconds,
  });
  return {
    tag: b.tag,
    tasks: {
      "import-recording": { operation: "import/url", url: sourceUrl, filename: "source.mp4" },
      "trim-recording": command("import-recording", commands.passOne),
      "finish-body": command("trim-recording", commands.passTwo),
      "probe-body": {
        operation: "metadata",
        input: "finish-body",
        engine: "ffmpeg",
        engine_version: ENGINE,
        timeout: timeoutSeconds,
      },
      "export-body": { operation: "export/url", input: "finish-body" },
    },
  } as const;
}

const NumberText = Schema.String.check(Schema.isPattern(/^\d+(?:\.\d+)?$/u));
const Metadata = Schema.Struct({
  format: Schema.Struct({ duration: NumberText, size: NumberText }),
  streams: Schema.Array(
    Schema.Struct({
      codec_type: Schema.String,
      codec_name: Schema.String,
      time_base: Schema.String,
      duration_ts: Schema.Int,
      nb_frames: NumberText,
      width: Schema.Int,
      height: Schema.Int,
    }),
  ),
  chapters: Schema.optional(Schema.Array(Schema.Unknown)),
});

export async function measureModeratedDancePublicationBody(
  raw: unknown,
  bytes: Uint8Array,
  metadata: unknown,
) {
  const b = binding(raw),
    data = decode(Metadata, metadata),
    video = data.streams[0],
    samples = b.durationMs * 48;
  const shape = inspectSilentSongVideoInputStructure(bytes, samples);
  if (
    data.streams.length !== 1 ||
    video?.codec_type !== "video" ||
    video.codec_name !== "h264" ||
    video.time_base !== "1/48000" ||
    video.duration_ts !== samples ||
    Number(video.nb_frames) !== shape.videoFrameCount ||
    Number(data.format.size) !== bytes.byteLength ||
    Math.round(Number(data.format.duration) * 1_000_000) !== b.durationMs * 1000 ||
    video.width < 2 ||
    video.width > 1280 ||
    video.height < 2 ||
    video.height > 1280 ||
    (data.chapters?.length ?? 0) !== 0
  )
    throw new Error("Dance publication measured body refused");
  return {
    key: `immutable/dance-post-operation:${b.reviewId}/video/1`,
    sha256: await sha256Hex(bytes),
    size: bytes.byteLength,
    sourceSha256: b.sourceSha256,
    bodyStartMs: b.bodyStartMs,
    bodyEndMs: b.bodyEndMs,
    durationMs: b.durationMs,
    transformRevision: "dance-publication-body-v1" as const,
  };
}

/** One bounded provider result, with an already retained original job identity.
 * No create/retry or database mutation is hidden in this output reader. */
export async function readModeratedDancePublicationBody(
  input: Readonly<{
    binding: unknown;
    jobId: string;
    observation: ReturnType<typeof decodeModeratedDancePublicationBodyObservation>;
    signal: AbortSignal;
    send?: (url: string, init: RequestInit) => Promise<Response>;
  }>,
) {
  const b = binding(input.binding),
    o = input.observation;
  if (
    o.id !== input.jobId ||
    o.tag !== b.tag ||
    o.status !== "finished" ||
    o.exportUrl === null ||
    o.metadata === null
  )
    throw new Error("Dance publication output identity changed");
  const bytes = await readModeratedDanceExport(
    o.exportUrl,
    16 * 1024 * 1024,
    input.signal,
    input.send,
  );
  return { bytes, plan: await measureModeratedDancePublicationBody(b, bytes, o.metadata) };
}
