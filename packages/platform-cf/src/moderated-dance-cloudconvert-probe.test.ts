import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { MediaTransformVideoProbeInput } from "../../application/src/media/transform.ts";
import { makeModeratedDanceCloudConvertProbe } from "./moderated-dance-cloudconvert-probe.ts";
import {
  decodeModeratedDanceProbeMetadata,
  decodeModeratedDanceProbeObservation,
} from "./moderated-dance-probe-observation.ts";

const hash = "a".repeat(64);
const original: MediaTransformVideoProbeInput = {
  version: "media-transform-video-probe-input-v1",
  binding: {
    operationId: "attempt",
    videoRevision: 1,
    creationRevision: 1,
    analysisRevision: 1,
    canonicalVideoSha256: hash,
    requestId: "private-probe-upload",
  },
  source: {
    objectKey: "moderated-dance/originals/upload/source",
    sha256: hash,
    byteLength: 5,
    mediaType: "video/mp4",
  },
  attempt: {
    version: "media-transform-attempt-v1",
    runtimeFence: { submittedAtMs: 1000, runtimeDeadlineMs: 61000 },
  },
};
const started = (
  phase: "submitting" | "started" = "submitting",
): MediaTransformVideoProbeInput => ({
  ...original,
  attempt: { ...original.attempt, providerJobId: "original-job", providerJobPhase: phase },
});
const metadata = () => ({
  format: { duration: "12.000", size: "5" },
  streams: [
    {
      codec_type: "video",
      codec_name: "h264",
      width: 1920,
      height: 1080,
      avg_frame_rate: "30000/1001",
    },
    { codec_type: "audio", codec_name: "aac" },
  ],
});
function observation(status = "waiting") {
  const source = {
    id: "original-import",
    name: "import-recording",
    operation: "import/upload",
    depends_on_task_ids: [] as string[],
    status,
    result: {
      form: {
        url: "https://eu-central.storage.cloudconvert.com/upload-bucket",
        parameters: {
          expires: 61,
          signature: "fictional-form-signature",
          dynamic_field: "opaque-provider-value",
        },
      },
    },
  };
  const dependencies = ["original-import"];
  const probe = {
    id: "original-metadata",
    name: "source-probe",
    operation: "metadata",
    status,
    engine: "ffmpeg",
    engine_version: "6.1.4",
    depends_on_task_ids: dependencies,
    result: { metadata: metadata() },
  };
  return {
    id: "original-job",
    tag: original.binding.requestId,
    status,
    tasks: [source, probe] satisfies [typeof source, typeof probe],
  };
}
function fixture() {
  const calls: Array<{ url: string; init: RequestInit }> = [],
    uploads: string[] = [];
  let readCount = 0,
    value = observation(),
    loseCreate = false,
    loseUpload = false,
    time = 1000;
  const provider = makeModeratedDanceCloudConvertProbe({
    apiKey: "fictional-provider-key",
    timeoutSeconds: 30,
    now: () => time,
    readSource: async (source) => {
      expect(source).toEqual(original.source);
      readCount++;
      return new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array([1, 2]));
          c.enqueue(new Uint8Array([3, 4, 5]));
          c.close();
        },
      });
    },
    send: async (url, init) => {
      calls.push({ url, init });
      if (url.startsWith("https://eu-central.storage.cloudconvert.com/")) {
        if (!(init.body instanceof ReadableStream)) throw new Error("Expected a streamed body");
        uploads.push(await new Response(init.body).text());
        if (loseUpload) throw new Error("Upload reply lost after provider received the file");
        return new Response(null, { status: 201 });
      }
      if (init.method === "POST") {
        if (loseCreate) throw new Error("Create reply lost");
        return Response.json({ data: { id: value.id, tag: value.tag, status: value.status } });
      }
      return Response.json({ data: value });
    },
  });
  return {
    provider,
    calls,
    uploads,
    reads: () => readCount,
    set: (v: ReturnType<typeof observation>) => {
      value = v;
    },
    loseCreate: () => {
      loseCreate = true;
    },
    loseUpload: () => {
      loseUpload = true;
    },
    expire: () => {
      time = 61000;
    },
  };
}
describe("private CloudConvert probe allocation and one START", () => {
  test("allocation waits without source bytes, URL, upload, or R2 access", async () => {
    const f = fixture(),
      result = await Effect.runPromise(f.provider.allocate(original));
    expect(result).toMatchObject({
      status: "submitted",
      attempt: { providerJobId: "original-job", providerJobPhase: "allocated" },
    });
    expect(f.reads()).toBe(0);
    expect(f.calls).toHaveLength(1);
    const body = JSON.parse(String(f.calls[0]?.init.body));
    expect(body.tasks).toEqual({
      "import-recording": { operation: "import/upload" },
      "source-probe": {
        operation: "metadata",
        input: "import-recording",
        engine: "ffmpeg",
        engine_version: "6.1.4",
        timeout: 30,
      },
    });
    expect(JSON.stringify(result)).not.toContain("signature");
  });
  test("START uploads the exact stream once with all dynamic parameters and file last", async () => {
    const f = fixture();
    expect(await Effect.runPromise(f.provider.submit(started()))).toMatchObject({
      status: "processing",
      attempt: { providerJobPhase: "started" },
    });
    expect(f.calls.map((c) => c.init.method)).toEqual(["GET", "POST"]);
    expect(f.reads()).toBe(1);
    const form = f.uploads[0] ?? "";
    expect(form).toContain('name="dynamic_field"\r\n\r\nopaque-provider-value');
    expect(form.indexOf('name="file"')).toBeGreaterThan(form.indexOf('name="signature"'));
    expect(form).toContain(String.fromCharCode(1, 2, 3, 4, 5));
    expect(f.calls[1]?.init.redirect).toBe("manual");
    const headers = f.calls[1]?.init.headers;
    if (!(headers instanceof Headers)) throw new Error("Expected upload headers");
    expect(headers.has("Authorization")).toBe(false);
  });
  test("a lost upload reply recovers by observing the same job without another upload", async () => {
    const f = fixture();
    f.loseUpload();
    const lost = await Effect.runPromise(f.provider.submit(started()));
    expect(lost).toEqual({
      status: "retryable_failure",
      reason: "transport",
      attempt: started().attempt,
    });
    f.set(observation("finished"));
    const result = await Effect.runPromise(
      f.provider.observe({ ...started(), attempt: lost.attempt }),
    );
    expect(result).toMatchObject({
      status: "completed",
      probe: { durationMs: 12000, frameRateMillihertz: 29970, hasAudio: true },
    });
    expect(f.calls.map((c) => c.init.method)).toEqual(["GET", "POST", "GET"]);
    expect(f.reads()).toBe(1);
    expect(f.uploads).toHaveLength(1);
    expect(JSON.stringify(result)).not.toMatch(/signature|cloudconvert\.com|dynamic_field/u);
  });
  test("lost allocation retains uncertainty and observation cannot create or upload without an ID", async () => {
    const f = fixture();
    f.loseCreate();
    expect(await Effect.runPromise(f.provider.allocate(original))).toMatchObject({
      status: "retryable_failure",
      attempt: original.attempt,
    });
    await expect(Effect.runPromise(f.provider.observe(original))).rejects.toThrow();
    expect(f.calls).toHaveLength(1);
    expect(f.reads()).toBe(0);
  });
  test("an observed waiting job after uncertain START does not restore the upload grant", async () => {
    const f = fixture();
    expect(await Effect.runPromise(f.provider.observe(started()))).toEqual({
      status: "not_found",
      attempt: started().attempt,
    });
    expect(f.calls.map((c) => c.init.method)).toEqual(["GET"]);
    expect(f.reads()).toBe(0);
  });
  test("wrong job/tag, foreign upload origin and changed engine stop before source access", async () => {
    for (const mutate of [
      (v: ReturnType<typeof observation>) => {
        v.id = "foreign-job";
      },
      (v: ReturnType<typeof observation>) => {
        v.tag = "foreign-tag";
      },
      (v: ReturnType<typeof observation>) => {
        if (v.tasks[0]) v.tasks[0].result.form.url = "https://foreign.invalid/upload/";
      },
      (v: ReturnType<typeof observation>) => {
        if (v.tasks[1]) v.tasks[1].engine_version = "new-engine";
      },
    ]) {
      const f = fixture(),
        v = observation();
      mutate(v);
      f.set(v);
      expect(await Effect.runPromise(f.provider.submit(started()))).toMatchObject({
        status: "retryable_failure",
      });
      expect(f.calls).toHaveLength(1);
      expect(f.reads()).toBe(0);
    }
  });
  test("START requires persisted submitting phase, and expiry allows no I/O", async () => {
    const f = fixture();
    await expect(Effect.runPromise(f.provider.submit(started("started")))).rejects.toThrow();
    f.expire();
    expect(await Effect.runPromise(f.provider.submit(started()))).toMatchObject({
      status: "rejected",
      reason: "runtime_exceeded",
    });
    expect(f.calls).toHaveLength(0);
  });
});
describe("strict private probe provider facts", () => {
  test("metadata proves exact size and single H264/HEVC plus AAC streams", () => {
    expect(decodeModeratedDanceProbeMetadata(metadata(), 5, "bound-proof")).toMatchObject({
      width: 1920,
      height: 1080,
      evidenceRef: "bound-proof",
    });
    const hevc = metadata();
    if (hevc.streams[0]) hevc.streams[0].codec_name = "hevc";
    expect(decodeModeratedDanceProbeMetadata(hevc, 5, "bound-proof").videoCodec).toBe("hevc");
    for (const value of [
      { ...metadata(), format: { duration: "Infinity", size: "5" } },
      { ...metadata(), format: { duration: "12", size: "6" } },
      { ...metadata(), streams: [...metadata().streams, metadata().streams[0]] },
      {
        ...metadata(),
        streams: [{ ...metadata().streams[0], avg_frame_rate: "30/0" }, metadata().streams[1]],
      },
      {
        ...metadata(),
        streams: [
          { ...metadata().streams[0], disposition: { attached_pic: 1 } },
          metadata().streams[1],
        ],
      },
      {
        ...metadata(),
        streams: [{ ...metadata().streams[0], codec_name: "vp9" }, metadata().streams[1]],
      },
    ])
      expect(() => decodeModeratedDanceProbeMetadata(value, 5, "bound-proof")).toThrow();
  });
  test("observed regional upload form keeps exact host, path and dependency boundaries", () => {
    for (const url of [
      "https://eu-central.storage.cloudconvert.com/upload-bucket",
      "https://eu-central.storage.cloudconvert.com/upload-bucket/",
      "https://upload.cloudconvert.com/original-import/",
    ]) {
      const value = observation();
      value.tasks[0].result.form.url = url;
      expect(decodeModeratedDanceProbeObservation(value).form?.url).toBe(url);
    }
    for (const url of [
      "https://eu-central.storage.cloudconvert.com.attacker.example/bucket",
      "https://attacker.eu-central.storage.cloudconvert.com/bucket",
      "https://eu-central.storage.cloudconvert.com:444/bucket",
      "https://user:password@eu-central.storage.cloudconvert.com/bucket",
      "http://eu-central.storage.cloudconvert.com/bucket",
      "https://eu-central.storage.cloudconvert.com/bucket?redirect=1",
      "https://eu-central.storage.cloudconvert.com/bucket/file",
    ]) {
      const value = observation();
      value.tasks[0].result.form.url = url;
      expect(() => decodeModeratedDanceProbeObservation(value)).toThrow();
    }
    for (const dependencies of [[], ["foreign"], ["original-import", "original-import"]]) {
      const value = observation();
      value.tasks[1].depends_on_task_ids = dependencies;
      expect(() => decodeModeratedDanceProbeObservation(value)).toThrow();
    }
    const missing = observation();
    expect(() =>
      decodeModeratedDanceProbeObservation({
        ...missing,
        tasks: missing.tasks.map(({ depends_on_task_ids: _ids, ...task }) => task),
      }),
    ).toThrow();
    missing.tasks[0].depends_on_task_ids = ["unexpected-source"];
    expect(() => decodeModeratedDanceProbeObservation(missing)).toThrow();
  });
  test("finished tasks require exact dependency, version, task closure and consistent status", () => {
    expect(decodeModeratedDanceProbeObservation(observation("finished")).metadata).toEqual(
      metadata(),
    );
    for (const mutate of [
      (v: ReturnType<typeof observation>) => {
        if (v.tasks[0]) v.tasks.push(v.tasks[0]);
      },
      (v: ReturnType<typeof observation>) => {
        if (v.tasks[1]) v.tasks[1].depends_on_task_ids = [];
      },
      (v: ReturnType<typeof observation>) => {
        if (v.tasks[0]) v.tasks[0].status = "waiting";
      },
    ]) {
      const v = observation("finished");
      mutate(v);
      expect(() => decodeModeratedDanceProbeObservation(v)).toThrow();
    }
  });
});
