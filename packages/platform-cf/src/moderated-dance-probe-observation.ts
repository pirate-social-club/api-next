import { Schema } from "effect";
import type { MediaTransformVideoProbe } from "../../application/src/media/transform.ts";
import { SONG_VIDEO_CLOUDCONVERT_FFMPEG_VERSION as ENGINE } from "./song-video-cloudconvert-recipe.ts";

const Id = Schema.NonEmptyString.check(Schema.isMaxLength(192));
const Status = Schema.Literals(["waiting", "processing", "finished", "error"]);
const Task = Schema.Struct({
  id: Id,
  name: Id,
  operation: Id,
  status: Status,
  engine: Schema.optional(Schema.NullOr(Schema.String)),
  engine_version: Schema.optional(Schema.NullOr(Schema.String)),
  depends_on_tasks: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  result: Schema.optional(Schema.Unknown),
});
const Job = Schema.Struct({ id: Id, tag: Id, status: Status, tasks: Schema.Array(Task) });
const Form = Schema.Struct({
  url: Schema.String,
  parameters: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number])),
});
const decode = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
): S["Type"] => Schema.decodeUnknownSync(schema, { onExcessProperty: "ignore" })(value);

/** No source URL or bytes appear in this allocation. CloudConvert documents
 * import/upload as waiting until a multipart upload starts the job:
 * https://cloudconvert.com/docs/import-export/import-files#upload */
export function makeModeratedDanceProbeJob(tag: string, timeoutSeconds: number) {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u.test(tag) ||
    !Number.isSafeInteger(timeoutSeconds) ||
    timeoutSeconds < 1 ||
    timeoutSeconds > 86400
  )
    throw new TypeError("Invalid private probe bounds");
  return {
    tag,
    tasks: {
      "import-recording": { operation: "import/upload" },
      "source-probe": {
        operation: "metadata",
        input: "import-recording",
        engine: "ffmpeg",
        engine_version: ENGINE,
        timeout: timeoutSeconds,
      },
    },
  } as const;
}

/** This response is private and ephemeral. Neither the upload form nor its
 * signature may be persisted in the probe attempt or cleanup receipt. */
export function decodeModeratedDanceProbeObservation(value: unknown) {
  const job = decode(Job, value);
  if (job.tasks.length !== 2) throw new TypeError("Private probe task closure changed");
  const imports = job.tasks.filter((t) => t.name === "import-recording"),
    probes = job.tasks.filter((t) => t.name === "source-probe");
  const source = imports[0],
    probe = probes[0];
  if (
    imports.length !== 1 ||
    probes.length !== 1 ||
    source === undefined ||
    probe === undefined ||
    source.id === probe.id ||
    source.operation !== "import/upload" ||
    probe.operation !== "metadata" ||
    (probe.engine != null && probe.engine !== "ffmpeg") ||
    (probe.engine_version != null && probe.engine_version !== ENGINE) ||
    probe.depends_on_tasks === undefined ||
    Object.keys(probe.depends_on_tasks).length !== 1 ||
    !Object.hasOwn(probe.depends_on_tasks, source.id)
  )
    throw new TypeError("Private probe provenance changed");
  const waiting = job.status === "waiting" && source.status === "waiting";
  const form = waiting ? decode(Schema.Struct({ form: Form }), source.result).form : null;
  if (form !== null) {
    const url = new URL(form.url),
      pairs = Object.entries(form.parameters);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "upload.cloudconvert.com" ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== "" ||
      url.search !== "" ||
      !/^\/[A-Za-z0-9_-]+\/$/u.test(url.pathname) ||
      pairs.length < 1 ||
      pairs.length > 64 ||
      pairs.some(
        ([key, v]) =>
          !/^[A-Za-z0-9_.-]{1,128}$/u.test(key) ||
          key === "file" ||
          String(v).length > 8192 ||
          /[\r\n\0]/u.test(String(v)) ||
          (typeof v === "number" && !Number.isFinite(v)),
      ) ||
      JSON.stringify(form.parameters).length > 16384
    )
      throw new TypeError("Private probe upload form refused");
  }
  const finished = job.status === "finished";
  if (
    finished &&
    (source.status !== "finished" ||
      probe.status !== "finished" ||
      probe.engine !== "ffmpeg" ||
      probe.engine_version !== ENGINE)
  )
    throw new TypeError("Private probe completion disagrees");
  return {
    id: job.id,
    tag: job.tag,
    status: job.status,
    form,
    metadata: finished
      ? decode(Schema.Struct({ metadata: Schema.Unknown }), probe.result).metadata
      : null,
  };
}

const Positive = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const Metadata = Schema.Struct({
  format: Schema.Struct({
    duration: Schema.String.check(Schema.isPattern(/^\d+(?:\.\d+)?$/u)),
    size: Schema.String.check(Schema.isPattern(/^\d+$/u)),
  }),
  streams: Schema.Array(
    Schema.Struct({
      codec_type: Schema.String,
      codec_name: Schema.String,
      width: Schema.optional(Positive),
      height: Schema.optional(Positive),
      avg_frame_rate: Schema.optional(Schema.String),
      disposition: Schema.optional(Schema.Struct({ attached_pic: Schema.optional(Schema.Int) })),
    }),
  ),
});

/** Require exactly one real video and one AAC track. Metadata from another
 * size, extra streams, zero denominators and nonfinite facts never qualify. */
export function decodeModeratedDanceProbeMetadata(
  value: unknown,
  sizeBytes: number,
  evidenceRef: string,
): MediaTransformVideoProbe {
  const data = decode(Metadata, value),
    videos = data.streams.filter((s) => s.codec_type === "video"),
    audios = data.streams.filter((s) => s.codec_type === "audio"),
    video = videos[0],
    audio = audios[0];
  const durationMs = Math.round(Number(data.format.duration) * 1000);
  if (
    data.streams.length !== 2 ||
    videos.length !== 1 ||
    audios.length !== 1 ||
    video === undefined ||
    audio?.codec_name !== "aac" ||
    (video.codec_name !== "h264" && video.codec_name !== "hevc") ||
    video.width === undefined ||
    video.height === undefined ||
    video.disposition?.attached_pic === 1 ||
    Number(data.format.size) !== sizeBytes ||
    !Number.isSafeInteger(durationMs) ||
    durationMs < 1 ||
    !/^\d+\/\d+$/u.test(video.avg_frame_rate ?? "")
  )
    throw new TypeError("Private ffprobe facts refused");
  const [n, d] = (video.avg_frame_rate ?? "").split("/").map(Number),
    frameRateMillihertz = Math.round((Number(n) * 1000) / Number(d));
  if (
    !Number.isSafeInteger(n) ||
    !Number.isSafeInteger(d) ||
    Number(d) <= 0 ||
    !Number.isSafeInteger(frameRateMillihertz) ||
    frameRateMillihertz < 1
  )
    throw new TypeError("Private ffprobe frame rate refused");
  return {
    evidenceRef,
    durationMs,
    width: video.width,
    height: video.height,
    frameRateMillihertz,
    videoCodec: video.codec_name,
    audioCodec: "aac" as const,
    hasAudio: true as const,
  };
}
