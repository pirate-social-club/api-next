import { describe, expect, test } from "bun:test";
import {
  CloudConvertTransportError,
  makeSongVideoCloudConvertTransport,
} from "./song-video-cloudconvert-transport.ts";

const job = { id: "job-1", tag: "attempt:1", status: "waiting" } as const;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("CloudConvert transport", () => {
  test("creates once with the fixed API origin and never sends the key elsewhere", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const transport = makeSongVideoCloudConvertTransport({
      apiKey: "private-key",
      fetch: async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return json({ data: job });
      },
    });
    expect(await transport.create({ tag: job.tag, tasks: {} })).toEqual(job);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.cloudconvert.com/v2/jobs");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.redirect).toBe("manual");
    expect((calls[0]?.init.headers as Record<string, string> | undefined)?.Authorization).toBe(
      "Bearer private-key",
    );
  });

  test("a lost create response is uncertain, not a reason to retry POST", async () => {
    let calls = 0;
    const transport = makeSongVideoCloudConvertTransport({
      apiKey: "private-key",
      fetch: async () => {
        calls++;
        throw new Error("provider may have accepted the job");
      },
    });
    await expect(transport.create({ tag: job.tag, tasks: {} })).rejects.toMatchObject({
      outcome: "uncertain",
    });
    expect(calls).toBe(1);
  });

  test("malformed or oversized create acknowledgement is uncertain", async () => {
    for (const response of [
      json({ data: { id: "not a job", tag: job.tag, status: "processing" } }),
      new Response("{}", { status: 201, headers: { "content-length": "262145" } }),
    ]) {
      const transport = makeSongVideoCloudConvertTransport({
        apiKey: "private-key",
        fetch: async () => response,
      });
      await expect(transport.create({ tag: job.tag, tasks: {} })).rejects.toMatchObject({
        outcome: "uncertain",
      });
    }
  });

  test("reconciles one exact tag and refuses duplicate jobs", async () => {
    const responses = [json({ data: [job] }), json({ data: [job, { ...job, id: "job-2" }] })];
    const transport = makeSongVideoCloudConvertTransport({
      apiKey: "private-key",
      fetch: async () => responses.shift() as Response,
    });
    expect(await transport.findByTag(job.tag)).toEqual(job);
    await expect(transport.findByTag(job.tag)).rejects.toBeInstanceOf(CloudConvertTransportError);
  });

  test("an empty tag read returns null without creating a job", async () => {
    const transport = makeSongVideoCloudConvertTransport({
      apiKey: "private-key",
      fetch: async (_url: string, init: RequestInit) => {
        expect(init.method).toBe("GET");
        return json({ data: [] });
      },
    });
    expect(await transport.findByTag(job.tag)).toBeNull();
  });

  test.each(["storage.cloudconvert.com", "us-east.storage.cloudconvert.com"])(
    "accepts exactly a finished master from %s",
    async (host) => {
      const transport = makeSongVideoCloudConvertTransport({
        apiKey: "private-key",
        fetch: async () =>
          json({
            data: {
              ...job,
              status: "finished",
              tasks: [
                {
                  name: "export-master",
                  operation: "export/url",
                  status: "finished",
                  result: {
                    files: [
                      {
                        filename: "master.mp4",
                        url: `https://${host}/job-1/master.mp4?token=x`,
                      },
                    ],
                  },
                },
              ],
            },
          }),
      });
      expect((await transport.show(job.id)).exportUrl).toBe(
        `https://${host}/job-1/master.mp4?token=x`,
      );
    },
  );

  test("refuses a finished job with a missing, extra or foreign export", async () => {
    for (const tasks of [
      [],
      [
        {
          name: "export-master",
          operation: "export/url",
          status: "finished",
          result: { files: [] },
        },
      ],
      [
        {
          name: "export-master",
          operation: "export/url",
          status: "finished",
          result: {
            files: [{ filename: "master.mp4", url: "https://elsewhere.example/master.mp4" }],
          },
        },
      ],
    ]) {
      const transport = makeSongVideoCloudConvertTransport({
        apiKey: "private-key",
        fetch: async () => json({ data: { ...job, status: "finished", tasks } }),
      });
      await expect(transport.show(job.id)).rejects.toMatchObject({ outcome: "uncertain" });
    }
  });

  test("rejects HTTP rejection but treats server errors as uncertain", async () => {
    for (const [status, outcome] of [
      [403, "rejected"],
      [502, "uncertain"],
    ] as const) {
      const transport = makeSongVideoCloudConvertTransport({
        apiKey: "private-key",
        fetch: async () => json({ message: "signed URL must not leak" }, status),
      });
      await expect(transport.create({ tag: job.tag, tasks: {} })).rejects.toMatchObject({
        outcome,
        status,
        message: `CloudConvert request ${outcome}`,
      });
    }
  });

  test("deletes only an identified job and treats a lost delete response as uncertain", async () => {
    let calls = 0;
    const transport = makeSongVideoCloudConvertTransport({
      apiKey: "private-key",
      fetch: async (url, init) => {
        expect(url).toBe("https://api.cloudconvert.com/v2/jobs/job-1");
        expect(init.method).toBe("DELETE");
        calls++;
        if (calls === 1) return new Response(null, { status: 204 });
        throw new Error("response lost");
      },
    });
    await transport.remove("job-1");
    await expect(transport.remove("job-1")).rejects.toMatchObject({ outcome: "uncertain" });
    expect(calls).toBe(2);
    await expect(transport.remove("../other")).rejects.toThrow(TypeError);
  });
});
