import { describe, expect, test } from "bun:test";
import {
  makeModeratedDancePublicationBodyCommands,
  makeModeratedDancePublicationBodyJob,
  readModeratedDancePublicationBody,
} from "./moderated-dance-publication-body.ts";
import { decodeModeratedDancePublicationBodyObservation } from "./moderated-dance-publication-observation.ts";
import { makeSongVideoCloudConvertTransport } from "./song-video-cloudconvert-transport.ts";

const binding = {
  tag: "dance-publication:review:1",
  reviewId: "review",
  sourceSha256: "a".repeat(64),
  bodyStartMs: 3017,
  bodyEndMs: 15017,
};
const source = `https://gateway.example/.well-known/pirate/video-source/v1/${"x".repeat(43)}`;
const exportUrl =
  "https://eu-central.storage.cloudconvert.com/private/body.mp4?ephemeral=fictional";
function observation() {
  const tasks = [
    {
      id: "import-id",
      name: "import-recording",
      operation: "import/url",
      status: "finished",
      depends_on_task_ids: [],
    },
    {
      id: "trim-id",
      name: "trim-recording",
      operation: "command",
      status: "finished",
      engine: "ffmpeg",
      engine_version: "6.1.4",
      depends_on_task_ids: ["import-id"],
    },
    {
      id: "finish-id",
      name: "finish-body",
      operation: "command",
      status: "finished",
      engine: "ffmpeg",
      engine_version: "6.1.4",
      depends_on_task_ids: ["trim-id"],
    },
    {
      id: "probe-id",
      name: "probe-body",
      operation: "metadata",
      status: "finished",
      engine: "ffmpeg",
      engine_version: "6.1.4",
      depends_on_task_ids: ["finish-id"],
      result: { metadata: {} },
    },
    {
      id: "export-id",
      name: "export-body",
      operation: "export/url",
      status: "finished",
      depends_on_task_ids: ["finish-id"],
      result: { files: [{ filename: "body.mp4", url: exportUrl }] },
    },
  ];
  return { id: "original-job", tag: binding.tag, status: "finished", tasks };
}

describe("private Dance body recipe and provider boundary", () => {
  test("pins five tasks, exact source capability, body interval and final partial frame", () => {
    const job = makeModeratedDancePublicationBodyJob(binding, source, 120);
    expect(Object.keys(job.tasks)).toEqual([
      "import-recording",
      "trim-recording",
      "finish-body",
      "probe-body",
      "export-body",
    ]);
    expect(job.tasks["import-recording"]).toEqual({
      operation: "import/url",
      url: source,
      filename: "source.mp4",
    });
    expect(job.tasks["trim-recording"].arguments).toContain("trim=start=3.017:end=15.017");
    expect(job.tasks["trim-recording"].arguments).toContain("-an -sn -dn");
    expect(job.tasks["probe-body"]).toMatchObject({
      input: "finish-body",
      engine: "ffmpeg",
      engine_version: "6.1.4",
      timeout: 120,
    });
    expect(makeModeratedDancePublicationBodyCommands(3000, 32999).passTwo).toContain("1552");
    expect(makeModeratedDancePublicationBodyCommands(0, 30000).frameCount).toBe(900);
  });
  test("refuses unsupported durations, executable text, unbounded waits and arbitrary source URLs", () => {
    for (const [start, end] of [
      [-1, 6000],
      [0, 5999],
      [0, 30001],
      [0, Infinity],
      [0, 6000.1],
    ])
      expect(() => makeModeratedDancePublicationBodyCommands(start ?? 0, end ?? 0)).toThrow();
    for (const url of [
      "http://gateway.example/x",
      "https://user:pass@gateway.example/x",
      `${source}?other=true`,
      `${source}#other`,
      source.replace(".well-known", "xwell-known"),
      "https://foreign.example/arbitrary.mp4",
    ])
      expect(() => makeModeratedDancePublicationBodyJob(binding, url, 120)).toThrow();
    for (const timeout of [0, 301, 1.1, Infinity])
      expect(() => makeModeratedDancePublicationBodyJob(binding, source, timeout)).toThrow();
    expect(() =>
      makeModeratedDancePublicationBodyJob({ ...binding, tag: "bad;command" }, source, 120),
    ).toThrow();
  });
  test("accepts only the original purpose task identities/dependencies, engine and export", () => {
    const complete = observation();
    expect(decodeModeratedDancePublicationBodyObservation(complete)).toEqual({
      id: "original-job",
      tag: binding.tag,
      status: "finished",
      exportUrl,
      metadata: {},
    });
    const changes = [
      { ...complete, tasks: complete.tasks.slice(1) },
      { ...complete, tasks: [...complete.tasks, complete.tasks[0]] },
      { ...complete, tasks: complete.tasks.map(({ depends_on_task_ids: _ids, ...task }) => task) },
      {
        ...complete,
        tasks: complete.tasks.map((task) =>
          task.name === "import-recording" ? { ...task, depends_on_task_ids: ["foreign"] } : task,
        ),
      },
      {
        ...complete,
        tasks: complete.tasks.map((task) =>
          task.name === "trim-recording"
            ? { ...task, depends_on_task_ids: ["import-id", "import-id"] }
            : task,
        ),
      },
      {
        ...complete,
        tasks: complete.tasks.map((t) =>
          t.name === "trim-recording" ? { ...t, depends_on_task_ids: ["foreign-source"] } : t,
        ),
      },
      {
        ...complete,
        tasks: complete.tasks.map((t) =>
          t.name === "finish-body" ? { ...t, engine_version: "6.1.1" } : t,
        ),
      },
      {
        ...complete,
        tasks: complete.tasks.map((t) =>
          t.name === "probe-body" ? { ...t, operation: "convert" } : t,
        ),
      },
      {
        ...complete,
        tasks: complete.tasks.map((t) =>
          t.name === "export-body"
            ? { ...t, result: { files: [{ filename: "master.mp4", url: exportUrl }] } }
            : t,
        ),
      },
      {
        ...complete,
        tasks: complete.tasks.map((t) =>
          t.name === "export-body"
            ? {
                ...t,
                result: {
                  files: [{ filename: "body.mp4", url: "https://foreign.example/body.mp4" }],
                },
              }
            : t,
        ),
      },
    ];
    for (const changed of changes)
      expect(() => decodeModeratedDancePublicationBodyObservation(changed)).toThrow();
    expect(
      decodeModeratedDancePublicationBodyObservation({
        ...complete,
        status: "processing",
        tasks: complete.tasks.map((t) => ({ ...t, status: "processing", result: undefined })),
      }),
    ).toMatchObject({ exportUrl: null, metadata: null });
  });
  test("the authenticated transport only GETs the retained job; reading refuses changed identity before export I/O", async () => {
    const calls: string[] = [];
    const transport = makeSongVideoCloudConvertTransport({
      apiKey: "fictional-key",
      fetch: async (url, init) => {
        expect(init.method).toBe("GET");
        calls.push(url);
        return Response.json({ data: observation() });
      },
    });
    const complete = await transport.showPrivatePublication("original-job");
    expect(calls).toEqual(["https://api.cloudconvert.com/v2/jobs/original-job"]);
    let reads = 0;
    for (const changed of [
      { ...complete, id: "foreign-job" },
      { ...complete, tag: "foreign" },
      { ...complete, status: "waiting" as const, exportUrl: null, metadata: null },
    ])
      await expect(
        readModeratedDancePublicationBody({
          binding,
          jobId: "original-job",
          observation: changed,
          signal: new AbortController().signal,
          send: async () => {
            reads++;
            return new Response("foreign");
          },
        }),
      ).rejects.toThrow("identity changed");
    expect(reads).toBe(0);
  });
});
