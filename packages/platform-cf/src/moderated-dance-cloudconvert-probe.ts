import { Effect, Schema } from "effect";
import {
  MediaTransformRequestInvalid,
  type MediaTransformVideoJobInput,
  type MediaTransformVideoProbeInput,
  type MediaTransformVideoProbeOutcome,
  type MediaTransformVideoProgress,
} from "../../application/src/media/transform.ts";
import {
  decodeModeratedDanceProbeMetadata,
  makeModeratedDanceProbeJob,
} from "./moderated-dance-probe-observation.ts";
import { makeSongVideoCloudConvertTransport } from "./song-video-cloudconvert-transport.ts";

export const MODERATED_DANCE_CLOUDCONVERT_REVISION = "dance-moderated-media-v2";
export type ModeratedDanceProbeJobs = Readonly<{
  allocate: (
    r: MediaTransformVideoProbeInput,
  ) => Effect.Effect<MediaTransformVideoProgress, MediaTransformRequestInvalid>;
  submit: (
    r: MediaTransformVideoProbeInput,
  ) => Effect.Effect<MediaTransformVideoProgress, MediaTransformRequestInvalid>;
  observe: (
    r: MediaTransformVideoProbeInput,
  ) => Effect.Effect<MediaTransformVideoProbeOutcome, MediaTransformRequestInvalid>;
}>;
export function makeR2ModeratedDanceProbeSource(
  bucket: Pick<R2Bucket, "get">,
  sealed: Readonly<{
    destination_ref: string;
    canonical_sha256: string;
    size_bytes: number;
    version: string;
    etag: string;
  }>,
) {
  return async (
    source: MediaTransformVideoProbeInput["source"],
  ): Promise<ReadableStream<Uint8Array>> => {
    if (
      source.objectKey !== sealed.destination_ref ||
      source.sha256 !== sealed.canonical_sha256 ||
      source.byteLength !== sealed.size_bytes
    )
      throw new Error("Private probe source binding changed");
    const object = await bucket.get(source.objectKey, { onlyIf: { etagMatches: sealed.etag } });
    if (object === null || !("body" in object)) throw new Error("Private probe source unavailable");
    if (
      object.version !== sealed.version ||
      object.etag !== sealed.etag ||
      object.size !== sealed.size_bytes ||
      object.httpMetadata?.contentType !== source.mediaType
    ) {
      await object.body.cancel();
      throw new Error("Private probe immutable source changed");
    }
    return object.body;
  };
}
const Id = Schema.NonEmptyString.check(Schema.isMaxLength(192));
const Natural = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8.64e15 }));
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Request = Schema.Struct({
  version: Schema.Literal("media-transform-video-probe-input-v1"),
  binding: Schema.Struct({
    operationId: Id,
    videoRevision: Natural,
    creationRevision: Natural,
    analysisRevision: Natural,
    canonicalVideoSha256: Hash,
    requestId: Id,
  }),
  source: Schema.Struct({
    objectKey: Id,
    sha256: Hash,
    byteLength: Natural,
    mediaType: Schema.Literals(["video/mp4", "video/quicktime"]),
  }),
  attempt: Schema.Struct({
    version: Schema.Literal("media-transform-attempt-v1"),
    runtimeFence: Schema.Struct({ submittedAtMs: Natural, runtimeDeadlineMs: Natural }),
    providerJobId: Schema.optional(Id),
    providerJobPhase: Schema.optional(Schema.Literals(["allocated", "submitting", "started"])),
  }),
  signal: Schema.optional(Schema.Unknown),
});

/** Stream the original once, with the provider's dynamic fields and file last.
 * No arrayBuffer/Blob of the recording and no redirect or bearer forwarding. */
function multipart(
  source: ReadableStream<Uint8Array>,
  size: number,
  parameters: Readonly<Record<string, string | number>>,
  mediaType: string,
) {
  const boundary = `pirate-${crypto.randomUUID()}`,
    encoder = new TextEncoder();
  const prefix = encoder.encode(
    Object.entries(parameters)
      .map(
        ([key, v]) =>
          `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${v}\r\n`,
      )
      .join("") +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="source.mp4"\r\nContent-Type: ${mediaType}\r\n\r\n`,
  );
  const suffix = encoder.encode(`\r\n--${boundary}--\r\n`),
    reader = source.getReader();
  let first = true,
    received = 0,
    closed = false;
  const release = async () => {
    if (!closed) {
      closed = true;
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  };
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    release,
    body: new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (first) {
            first = false;
            controller.enqueue(prefix);
            return;
          }
          const next = await reader.read();
          if (next.done) {
            if (received !== size) throw new Error("Private source truncated");
            controller.enqueue(suffix);
            controller.close();
            await release();
            return;
          }
          received += next.value.byteLength;
          if (received > size) throw new Error("Private source exceeds sealed size");
          controller.enqueue(next.value);
        } catch (error) {
          controller.error(error);
          await release();
        }
      },
      cancel: release,
    }),
  };
}

/** This adapter is for new private Dance probes only. Durable SQL owns each
 * ALLOCATE/START grant. Observation never allocates, uploads or retries START. */
export function makeModeratedDanceCloudConvertProbe(
  input: Readonly<{
    apiKey: string;
    timeoutSeconds: number;
    readSource: (
      source: MediaTransformVideoProbeInput["source"],
    ) => Promise<ReadableStream<Uint8Array>>;
    send?: (url: string, init: RequestInit) => Promise<Response>;
    now?: () => number;
  }>,
): ModeratedDanceProbeJobs {
  const now = input.now ?? Date.now,
    send = input.send ?? fetch;
  const run = (action: "allocate" | "submit" | "observe", raw: MediaTransformVideoJobInput) =>
    Effect.try({
      try: () => {
        const r = Schema.decodeUnknownSync(Request, { onExcessProperty: "error" })(raw);
        if (
          r.source.sha256 !== r.binding.canonicalVideoSha256 ||
          r.source.byteLength < 1 ||
          !r.source.objectKey.startsWith("moderated-dance/originals/") ||
          r.binding.videoRevision !== 1 ||
          r.binding.creationRevision !== 1 ||
          r.binding.analysisRevision !== 1 ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u.test(r.binding.requestId) ||
          r.attempt.runtimeFence.submittedAtMs >= r.attempt.runtimeFence.runtimeDeadlineMs ||
          (action === "allocate" &&
            (r.attempt.providerJobId !== undefined || r.attempt.providerJobPhase !== undefined)) ||
          (action !== "allocate" &&
            (r.attempt.providerJobId === undefined ||
              !["submitting", "started"].includes(r.attempt.providerJobPhase ?? ""))) ||
          (action === "submit" && r.attempt.providerJobPhase !== "submitting")
        )
          throw new Error("Private probe binding refused");
        const { signal } = r;
        if (signal !== undefined && !(signal instanceof AbortSignal))
          throw new Error("Private probe signal refused");
        return {
          version: r.version,
          binding: r.binding,
          source: r.source,
          attempt: {
            version: r.attempt.version,
            runtimeFence: r.attempt.runtimeFence,
            ...(r.attempt.providerJobId === undefined
              ? {}
              : { providerJobId: r.attempt.providerJobId }),
            ...(r.attempt.providerJobPhase === undefined
              ? {}
              : { providerJobPhase: r.attempt.providerJobPhase }),
          },
          ...(signal === undefined ? {} : { signal }),
        };
      },
      catch: () => new MediaTransformRequestInvalid({ reason: "invalid_video_binding" }),
    }).pipe(
      Effect.flatMap((request) =>
        Effect.promise(async (): Promise<MediaTransformVideoProbeOutcome> => {
          const { attempt } = request,
            deadline = attempt.runtimeFence.runtimeDeadlineMs;
          if (now() >= deadline || request.signal?.aborted)
            return { status: "rejected", reason: "runtime_exceeded", attempt };
          const transport = makeSongVideoCloudConvertTransport({
            apiKey: input.apiKey,
            deadlineMs: deadline,
            now,
            fetch: send,
          });
          const tag = request.binding.requestId;
          try {
            if (action === "allocate") {
              const job = await transport.create(
                makeModeratedDanceProbeJob(
                  tag,
                  Math.min(
                    input.timeoutSeconds,
                    Math.max(1, Math.floor((deadline - now()) / 1000)),
                  ),
                ),
              );
              if (job.status !== "waiting") throw new Error("Private probe did not wait for input");
              return {
                status: "submitted",
                attempt: { ...attempt, providerJobId: job.id, providerJobPhase: "allocated" },
              };
            }
            const id = attempt.providerJobId;
            if (id === undefined) throw new Error("Missing original probe identity");
            const job = await transport.showPrivateProbe(id);
            if (job.id !== id || job.tag !== tag) throw new Error("Private probe identity changed");
            if (action === "submit") {
              if (job.status !== "waiting" || job.form === null)
                throw new Error("Private probe is no longer waiting");
              const source = await input.readSource(request.source);
              if (now() >= deadline || request.signal?.aborted) {
                await source.cancel();
                return { status: "rejected", reason: "runtime_exceeded", attempt };
              }
              const data = multipart(
                source,
                request.source.byteLength,
                job.form.parameters,
                request.source.mediaType,
              );
              const timeout = AbortSignal.timeout(Math.max(1, Math.min(30_000, deadline - now())));
              const signal =
                request.signal === undefined ? timeout : AbortSignal.any([timeout, request.signal]);
              try {
                const response = await send(job.form.url, {
                  method: "POST",
                  body: data.body,
                  headers: new Headers({ "Content-Type": data.contentType }),
                  redirect: "manual",
                  signal,
                });
                await response.body?.cancel();
                if (response.status !== 201 && response.status !== 200 && response.status !== 204)
                  throw new Error("Private probe upload unacknowledged");
              } finally {
                await data.body.cancel().catch(() => {});
                await data.release();
              }
              return {
                status: "processing",
                attempt: { ...attempt, providerJobId: id, providerJobPhase: "started" },
              };
            }
            if (job.status === "error")
              return { status: "rejected", reason: "provider_rejected", attempt };
            if (job.status === "waiting") return { status: "not_found", attempt };
            const started = { ...attempt, providerJobId: id, providerJobPhase: "started" as const };
            if (job.status !== "finished") return { status: "processing", attempt: started };
            return {
              status: "completed",
              attempt: started,
              context: {
                version: "media-transform-video-attempt-context-v1",
                operationId: request.binding.operationId,
                videoRevision: request.binding.videoRevision,
                analysisRevision: request.binding.analysisRevision,
                canonicalVideoSha256: request.binding.canonicalVideoSha256,
                requestId: request.binding.requestId,
                adapterRevision: MODERATED_DANCE_CLOUDCONVERT_REVISION,
              },
              probe: decodeModeratedDanceProbeMetadata(
                job.metadata,
                request.source.byteLength,
                `cloudconvert:private-probe:${id}:${request.source.sha256}`,
              ),
            };
          } catch {
            return { status: "retryable_failure", reason: "transport", attempt };
          }
        }),
      ),
    );
  // The existing broad port includes audio/frames. The schema rejects those
  // inputs before I/O; no new feature gains a different transform route.
  const progress = (action: "allocate" | "submit", r: MediaTransformVideoProbeInput) =>
    run(action, r).pipe(
      Effect.map((result) => {
        if (result.status === "completed")
          throw new Error("Probe progress cannot complete without observation");
        return result;
      }),
    );
  return {
    allocate: (r) => progress("allocate", r),
    submit: (r) => progress("submit", r),
    observe: (r) => run("observe", r),
  };
}
