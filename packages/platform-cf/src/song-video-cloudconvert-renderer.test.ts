import { describe, expect, test } from "bun:test";
import type { SongVideoExecutionRecord } from "@pirate/application/video/song-render";
import { makeCloudConvertSongVideoRenderer } from "./song-video-cloudconvert-renderer.ts";
import type {
  CloudConvertAttempt,
  CloudConvertRenderRepository,
} from "./song-video-cloudconvert-repository.ts";

function harness(input: {
  deadlineMs: number;
  jobId?: string | null;
  jobs: string[];
  failDeleteOnce?: boolean;
}) {
  let attempt: CloudConvertAttempt = {
    attemptId: "attempt-1",
    outputObjectKey: "media://immutable/output",
    jobId: input.jobId ?? null,
    createStarted: true,
    deadlineMs: input.deadlineMs,
    reconciliationRequired: false,
    cleanupComplete: false,
    pcmSha256: "a".repeat(64),
    clipDurationSamples: 144_000,
  };
  const events: string[] = [];
  let deleteFailed = false;
  const repository: CloudConvertRenderRepository = {
    read: async () => attempt,
    reference: async () => {
      throw new Error("unexpected reference");
    },
    sourceMediaType: async () => {
      throw new Error("unexpected source lookup");
    },
    bindPcm: async () => {
      throw new Error("unexpected PCM bind");
    },
    beginCreate: async () => {
      throw new Error("unexpected create intent");
    },
    attachJob: async (_attemptId, jobId) => {
      if (attempt.jobId !== null && attempt.jobId !== jobId)
        throw new Error("CloudConvert job identity conflict");
      attempt = { ...attempt, jobId };
    },
    grant: async () => {
      throw new Error("unexpected grant");
    },
    requireReconciliation: async () => {
      events.push("reconciliation");
      attempt = { ...attempt, reconciliationRequired: true };
    },
    revoke: async () => {
      events.push("revoke");
    },
    excerptKeys: async () => ["song-video-excerpts/excerpt.wav"],
    cleaned: async () => {
      events.push("cleaned");
      attempt = { ...attempt, cleanupComplete: true };
    },
  };
  const services = makeCloudConvertSongVideoRenderer({
    repository,
    store: {
      executionEvidence: async () => null,
      recordExecution: async () => {
        throw new Error("unexpected execution record");
      },
    },
    bucket: {
      delete: async (key: string) => {
        events.push(`r2-delete:${key}`);
      },
    } as R2Bucket,
    sourceGrants: {
      issue: async () => {
        throw new Error("unexpected source grant");
      },
    },
    gatewayOrigin: "https://source.example.com",
    apiKey: "test-key",
    now: () => 2_000,
    fetch: (async (url: string, init: RequestInit) => {
      if (init.method === "GET") {
        events.push("lookup");
        expect(new URL(url).searchParams.get("filter[tag]")).toBe("attempt-1");
        return Response.json({
          data: input.jobs.map((id) => ({ id, tag: "attempt-1", status: "processing" })),
        });
      }
      expect(init.method).toBe("DELETE");
      events.push(`provider-delete:${url.split("/").at(-1)}`);
      if (input.failDeleteOnce && !deleteFailed) {
        deleteFailed = true;
        throw new Error("lost delete response");
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch,
  });
  return { ...services, repository, events, attempt: () => attempt };
}

describe("CloudConvert renderer lifecycle", () => {
  test("a crash after output write resumes from R2 evidence before sealing without another provider call", async () => {
    const bytes = new Uint8Array(
      await Bun.file(
        new URL("./song-video-master-verifier/fixtures/master.mp4", import.meta.url),
      ).arrayBuffer(),
    );
    const h = harness({ deadlineMs: 3_000, jobs: [] });
    let evidence: SongVideoExecutionRecord | null = null;
    let stored: Uint8Array | null = null;
    let calls = 0;
    let writes = 0;
    const request = { attemptId: "attempt-1", outputObjectKey: "media://immutable/output" };
    const { renderer } = makeCloudConvertSongVideoRenderer({
      repository: {
        ...h.repository,
        read: async () => ({
          ...h.attempt(),
          clipDurationSamples: 150_000,
          pcmSha256: "1598c2e0f50412cf9a5a304452dc5e2f3216c7fbadc8012d2245970e3d764a22",
        }),
        attachJob: async () => {},
      },
      store: {
        executionEvidence: async () => evidence,
        recordExecution: async (_key, record) => {
          evidence = record;
        },
      },
      bucket: {
        get: async () =>
          stored === null
            ? null
            : {
                size: stored.byteLength,
                etag: "output-etag",
                arrayBuffer: async () => stored?.slice().buffer,
                body: new ReadableStream(),
              },
        put: async (_key: string, value: Uint8Array) => {
          stored = value.slice();
          writes += 1;
          throw new Error("lost output acknowledgement");
        },
      } as unknown as R2Bucket,
      sourceGrants: {
        issue: async () => {
          throw new Error("unexpected source grant");
        },
      },
      gatewayOrigin: "https://source.example.com",
      apiKey: "test-key",
      now: () => 2_000,
      fetch: (async (url: string, init: RequestInit) => {
        calls += 1;
        expect(init.method ?? "GET").toBe("GET");
        const job = { id: "job-1", tag: "attempt-1", status: "finished" };
        if (url.includes("/v2/jobs?")) return Response.json({ data: [job] });
        if (url.includes("/v2/jobs/job-1"))
          return Response.json({
            data: {
              ...job,
              tasks: [
                {
                  name: "export-master",
                  operation: "export/url",
                  status: "finished",
                  result: {
                    files: [
                      {
                        filename: "master.mp4",
                        url: "https://storage.cloudconvert.com/job-1/master.mp4",
                      },
                    ],
                  },
                },
              ],
            },
          });
        return new Response(bytes.slice());
      }) as typeof fetch,
    });
    await expect(renderer.observe(request)).rejects.toThrow("lost output acknowledgement");
    expect(writes).toBe(1);
    expect(calls).toBe(3);
    expect(await renderer.observe(request)).toEqual({ status: "completed" });
    expect(writes).toBe(1);
    expect(calls).toBe(3);
  });

  test("a lost delete response retries cleanup and accepts already deleted jobs", async () => {
    const h = harness({ deadlineMs: 2_000, jobId: "known-job", jobs: [], failDeleteOnce: true });
    await expect(h.expire("attempt-1")).rejects.toThrow("CloudConvert request uncertain");
    expect(h.attempt().cleanupComplete).toBe(false);
    await h.cleanup("attempt-1");
    expect(h.attempt().cleanupComplete).toBe(true);
    expect(h.events.filter((event) => event === "provider-delete:known-job")).toHaveLength(2);
  });

  test("expiry searches the exact tag and deletes every leftover job and excerpt", async () => {
    const h = harness({
      deadlineMs: 2_000,
      jobId: "known-job",
      jobs: ["lost-job", "duplicate-job"],
    });
    expect(
      await h.renderer.observe({
        attemptId: "attempt-1",
        outputObjectKey: "media://immutable/output",
      }),
    ).toEqual({ status: "pending" });
    expect(h.events).toEqual([
      "reconciliation",
      "revoke",
      "lookup",
      "provider-delete:lost-job",
      "provider-delete:duplicate-job",
      "provider-delete:known-job",
      "r2-delete:song-video-excerpts/excerpt.wav",
      "r2-delete:song-video-excerpts/attempt-1.wav",
      "cleaned",
    ]);
    expect(h.attempt().cleanupComplete).toBe(true);
    await h.cleanup("attempt-1");
    expect(h.events.filter((event) => event === "lookup")).toHaveLength(1);
  });

  test("an empty lookup after a lost response remains unresolved and never resends", async () => {
    const h = harness({ deadlineMs: 2_000, jobs: [] });
    await h.expire("attempt-1");
    expect(h.attempt().reconciliationRequired).toBe(true);
    expect(h.attempt().cleanupComplete).toBe(false);
    expect(h.events).toEqual([
      "reconciliation",
      "revoke",
      "lookup",
      "r2-delete:song-video-excerpts/excerpt.wav",
      "r2-delete:song-video-excerpts/attempt-1.wav",
    ]);
  });

  test("a processing job before the deadline remains pending without cleanup", async () => {
    const h = harness({ deadlineMs: 3_000, jobs: ["processing-job"] });
    expect(
      await h.renderer.observe({
        attemptId: "attempt-1",
        outputObjectKey: "media://immutable/output",
      }),
    ).toEqual({ status: "pending" });
    expect(h.events).toEqual(["lookup"]);
    expect(h.attempt().reconciliationRequired).toBe(false);
    expect(h.attempt().jobId).toBe("processing-job");
  });
});
