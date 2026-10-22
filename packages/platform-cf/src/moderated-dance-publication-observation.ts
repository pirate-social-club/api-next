import { Schema } from "effect";
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
const decode = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
): S["Type"] => Schema.decodeUnknownSync(schema, { onExcessProperty: "ignore" })(value);

/** Decode only this private five-task purpose. The existing public master,
 * replay analysis and allocated-upload probe decoders remain independent. */
export function decodeModeratedDancePublicationBodyObservation(value: unknown) {
  const job = decode(Job, value);
  const expected = [
    ["import-recording", "import/url", null],
    ["trim-recording", "command", "import-recording"],
    ["finish-body", "command", "trim-recording"],
    ["probe-body", "metadata", "finish-body"],
    ["export-body", "export/url", "finish-body"],
  ] as const;
  if (
    job.tasks.length !== expected.length ||
    new Set(job.tasks.map((t) => t.id)).size !== expected.length
  )
    throw new Error("Dance publication task closure changed");
  for (const [name, operation, parent] of expected) {
    const matches = job.tasks.filter((t) => t.name === name),
      task = matches[0],
      parentId = parent === null ? "" : job.tasks.find((t) => t.name === parent)?.id;
    if (
      matches.length !== 1 ||
      task === undefined ||
      task.operation !== operation ||
      Object.keys(task.depends_on_tasks ?? {})
        .sort()
        .join(",") !== parentId ||
      ((operation === "command" || operation === "metadata") &&
        ((task.engine != null && task.engine !== "ffmpeg") ||
          (task.engine_version != null && task.engine_version !== ENGINE))) ||
      (job.status === "finished" &&
        (task.status !== "finished" ||
          ((operation === "command" || operation === "metadata") &&
            (task.engine !== "ffmpeg" || task.engine_version !== ENGINE))))
    )
      throw new Error("Dance publication task identity changed");
  }
  if (job.status !== "finished")
    return { id: job.id, tag: job.tag, status: job.status, exportUrl: null, metadata: null };
  const probe = job.tasks.find((t) => t.name === "probe-body"),
    exports = job.tasks.find((t) => t.name === "export-body"),
    result = decode(
      Schema.Struct({
        files: Schema.Array(
          Schema.Struct({ filename: Schema.Literal("body.mp4"), url: Schema.String }),
        ),
      }),
      exports?.result,
    );
  if (result.files.length !== 1) throw new Error("Dance publication export closure changed");
  const exportUrl = result.files[0]?.url;
  if (exportUrl === undefined) throw new Error("Dance publication export missing");
  const url = new URL(exportUrl);
  if (
    url.protocol !== "https:" ||
    !["storage.cloudconvert.com", "us-east.storage.cloudconvert.com"].includes(url.hostname) ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.hash !== ""
  )
    throw new Error("Dance publication export target refused");
  return {
    id: job.id,
    tag: job.tag,
    status: job.status,
    exportUrl,
    metadata: decode(Schema.Struct({ metadata: Schema.Unknown }), probe?.result).metadata,
  };
}
