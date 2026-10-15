import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { consumeSongPcmAdmission } from "../../packages/platform-cf/src/song-video-pcm-admission.ts";
import {
  makeSongPcmAdmissionRepository,
  type SongPcmAdmission,
} from "../../packages/platform-cf/src/song-video-pcm-admission-repository.ts";

const bucket = (env as unknown as { AVATAR_TEST_SEALED: R2Bucket }).AVATAR_TEST_SEALED;
const id = `song-pcm-${"a".repeat(64)}`;
function fixture(deadline = Date.now() + 60_000, job: string | null = "job-one", fresh = false) {
  let row: SongPcmAdmission = {
    admission_id: id,
    song_post_id: "song",
    song_community_id: "crew",
    audio_revision: "1",
    canonical_audio_sha256: "b".repeat(64),
    audio_asset_ref: "media://immutable/song.mp3",
    state: fresh ? "pending" : "processing",
    provider_job_id: job,
    provider_create_started_at: fresh ? null : new Date(Date.now() - 1000),
    provider_wait_deadline: new Date(deadline),
    cleanup_completed_at: null,
    failure_code: null,
    claim_owner: "worker",
    claim_fence: "1",
  };
  const events: string[] = [];
  const repository = {
    ...makeSongPcmAdmissionRepository({
      connect: async () => {
        throw new Error("unexpected database call");
      },
    }),
    claim: async () => row,
    release: async () => {
      events.push("release");
    },
    get: async () => row,
    beginCreate: async () => {
      row = { ...row, state: "processing", provider_create_started_at: new Date() };
      events.push("begin-create");
      return row;
    },
    grant: async () => {
      events.push("grant");
    },
    attachJob: async (_a: SongPcmAdmission, jobId: string) => {
      row = { ...row, provider_job_id: jobId };
      events.push("attach");
    },
    refuse: async (_a: SongPcmAdmission, code: string, reconciliation = false) => {
      row = { ...row, state: reconciliation ? "reconciliation" : "refused", failure_code: code };
      return true;
    },
    revoke: async () => {
      events.push("revoke");
    },
    cleaned: async () => {
      events.push("cleaned");
    },
  };
  return { repository, events, row: () => row };
}
async function freshFixture() {
  const f = fixture(Date.now() + 60_000, null, true);
  const objectKey = "source/song.mp3";
  const object = await bucket.put(objectKey, new Uint8Array([1, 2, 3, 4]));
  if (object === null) throw new Error("test source upload refused");
  f.repository.source = async () => ({
    objectKey,
    objectVersion: object.version,
    objectEtag: object.etag,
    byteLength: object.size,
    durationMs: 1000,
    identity: "upload_version",
  });
  return f;
}
const job = { id: "job-one", tag: id, status: "processing" };
function dependencies(
  f: ReturnType<typeof fixture>,
  fetch: (url: string, init: RequestInit) => Promise<Response>,
) {
  return {
    repository: f.repository,
    bucket,
    apiKey: "test-only",
    sourceGatewayOrigin: "https://source.example",
    fetch,
  };
}

describe("durable PCM admission observation", () => {
  it("records a 402 refusal without leaking provider content or recreating the job", async () => {
    const f = await freshFixture();
    const calls: string[] = [];
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const deps = dependencies(f, async (_url, init) => {
        calls.push(init.method ?? "GET");
        return init.method === "POST"
          ? new Response("private-key https://provider.example/?secret=capability", { status: 402 })
          : Response.json({ data: [] });
      });
      expect(await consumeSongPcmAdmission({ admission_id: id }, deps)).toBe("ack");
      expect(f.row().state).toBe("refused");
      expect(f.row().failure_code).toBe("provider_rejected");
      expect(await consumeSongPcmAdmission({ admission_id: id }, deps)).toBe("ack");
      expect(calls).toEqual(["POST", "GET", "GET"]);
      expect(f.events.filter((event) => event === "begin-create")).toHaveLength(1);
      expect(JSON.parse(log.mock.calls[0]?.[0] as string)).toEqual({
        event: "song_pcm_admission_provider_create_failed",
        admission_id: id,
        provider_outcome: "rejected",
        http_status: 402,
      });
      expect(log).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-key|https:|secret|test-only/u);
    } finally {
      log.mockRestore();
    }
  });

  it.each([503, null])(
    "records uncertain create status %s and reconciles without another POST",
    async (status) => {
      const f = await freshFixture();
      const calls: string[] = [];
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const deps = dependencies(f, async (_url, init) => {
          calls.push(init.method ?? "GET");
          if (init.method !== "POST") return Response.json({ data: [] });
          if (status === null) throw new TypeError("private-key https://provider.example/?secret");
          return new Response("private-key https://provider.example/?secret", { status });
        });
        expect(await consumeSongPcmAdmission({ admission_id: id }, deps)).toBe("retry");
        expect(await consumeSongPcmAdmission({ admission_id: id }, deps)).toBe("retry");
        expect(calls).toEqual(["POST", "GET", "GET"]);
        expect(f.row().state).toBe("processing");
        expect(f.row().provider_create_started_at).not.toBeNull();
        expect(f.row().provider_job_id).toBeNull();
        expect(f.row().failure_code).toBeNull();
        expect(f.events).toEqual(["begin-create", "grant", "release", "release"]);
        expect(log).toHaveBeenCalledOnce();
        expect(JSON.parse(log.mock.calls[0]?.[0] as string)).toEqual({
          event: "song_pcm_admission_provider_create_failed",
          admission_id: id,
          provider_outcome: "uncertain",
          ...(status === null ? {} : { http_status: status }),
        });
        expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-key|https:|secret|test-only/u);
      } finally {
        log.mockRestore();
      }
    },
  );

  it("waits for processing before the deadline without another create", async () => {
    const f = fixture();
    const calls: string[] = [];
    expect(
      await consumeSongPcmAdmission(
        { admission_id: id },
        dependencies(f, async (_url, init) => {
          calls.push(init.method ?? "GET");
          return Response.json({ data: job });
        }),
      ),
    ).toBe("retry");
    expect(calls).toEqual(["GET"]);
    expect(f.events).toEqual(["release"]);
  });

  it("adopts a processing job after a lost create acknowledgement", async () => {
    const f = fixture(Date.now() + 60_000, null);
    const calls: string[] = [];
    expect(
      await consumeSongPcmAdmission(
        { admission_id: id },
        dependencies(f, async (url, init) => {
          calls.push(init.method ?? "GET");
          return Response.json({ data: url.includes("?") ? [job] : job });
        }),
      ),
    ).toBe("retry");
    expect(f.row().provider_job_id).toBe("job-one");
    expect(calls).toEqual(["GET", "GET"]);
    expect(f.events).toEqual(["attach", "release"]);
  });

  it("keeps an empty lookup uncertain without repeating creation", async () => {
    const f = fixture(Date.now() + 60_000, null);
    const calls: string[] = [];
    expect(
      await consumeSongPcmAdmission(
        { admission_id: id },
        dependencies(f, async (_url, init) => {
          calls.push(init.method ?? "GET");
          return Response.json({ data: [] });
        }),
      ),
    ).toBe("retry");
    expect(calls).toEqual(["GET"]);
    expect(f.row().provider_job_id).toBeNull();
    expect(f.row().state).toBe("processing");
  });

  it("expiry revokes inputs and deletes the exact provider job", async () => {
    const f = fixture(Date.now() - 1);
    const calls: string[] = [];
    expect(
      await consumeSongPcmAdmission(
        { admission_id: id },
        dependencies(f, async (_url, init) => {
          calls.push(init.method ?? "GET");
          return init.method === "DELETE"
            ? new Response(null, { status: 204 })
            : Response.json({ data: [job] });
        }),
      ),
    ).toBe("ack");
    expect(calls).toEqual(["GET", "DELETE"]);
    expect(f.row().state).toBe("reconciliation");
    expect(f.events).toEqual(["revoke", "cleaned", "release"]);
  });

  it("a malformed provider response remains pending and cannot admit", async () => {
    const f = fixture();
    expect(
      await consumeSongPcmAdmission(
        { admission_id: id },
        dependencies(f, async () => Response.json({ data: { status: "finished" } })),
      ),
    ).toBe("retry");
    expect(f.row().state).toBe("processing");
    expect(f.events).toEqual(["release"]);
  });

  it("export fetch failure records only its phase and allowlisted class", async () => {
    const f = fixture();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const outcome = await consumeSongPcmAdmission(
        { admission_id: id },
        dependencies(f, async (url) => {
          if (url.includes("storage.cloudconvert.com"))
            throw new TypeError("signed-url-secret-and-provider-body");
          return Response.json({
            data: {
              ...job,
              status: "finished",
              tasks: [
                {
                  name: "export-pcm",
                  operation: "export/url",
                  status: "finished",
                  result: {
                    files: [
                      {
                        filename: "song.pcm",
                        url: "https://us-east.storage.cloudconvert.com/song.pcm?secret=capability",
                      },
                    ],
                  },
                },
              ],
            },
          });
        }),
      );
      expect(outcome).toBe("retry");
      expect(log).toHaveBeenCalledOnce();
      expect(JSON.parse(log.mock.calls[0]?.[0] as string)).toEqual({
        event: "song_pcm_admission_observation_failed",
        admission_id: id,
        phase: "export-fetch",
        error_class: "TypeError",
      });
      expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
    } finally {
      log.mockRestore();
    }
  });
  it("logs transfer stages and preserves retry without leaking the failed response", async () => {
    const f = fixture();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const outcome = await consumeSongPcmAdmission(
        { admission_id: id },
        dependencies(f, async (url) => {
          if (url.includes("storage.cloudconvert.com"))
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.error(new TypeError("signed-url-secret-and-provider-body"));
                },
              }),
              { headers: { "content-length": "8" } },
            );
          return Response.json({
            data: {
              ...job,
              status: "finished",
              tasks: [
                {
                  name: "export-pcm",
                  operation: "export/url",
                  status: "finished",
                  result: {
                    files: [
                      {
                        filename: "song.pcm",
                        url: "https://us-east.storage.cloudconvert.com/song.pcm?secret=capability",
                      },
                    ],
                  },
                },
              ],
            },
          });
        }),
      );
      expect(outcome).toBe("retry");
      expect(log).toHaveBeenCalledOnce();
      const diagnostic = JSON.parse(log.mock.calls[0]?.[0] as string);
      expect(diagnostic).toMatchObject({
        event: "song_pcm_admission_observation_failed",
        admission_id: id,
        phase: "pcm-transfer",
        http_status: 200,
      });
      expect(["stream", "upload", "hash-digest"]).toContain(diagnostic.transfer_phase);
      expect(diagnostic.pending_transfer_phases).toContain("hash-digest");
      expect(["Error", "TypeError"]).toContain(diagnostic.error_class);
      expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
      expect(JSON.stringify(log.mock.calls)).not.toContain("https:");
      expect(f.row().state).toBe("processing");
      expect(f.events).toEqual(["release"]);
    } finally {
      log.mockRestore();
    }
  });
});
