import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { consumeSongPcmAdmission } from "../../packages/platform-cf/src/song-video-pcm-admission.ts";
import {
  makeSongPcmAdmissionRepository,
  type SongPcmAdmission,
} from "../../packages/platform-cf/src/song-video-pcm-admission-repository.ts";

const bucket = (env as unknown as { AVATAR_TEST_SEALED: R2Bucket }).AVATAR_TEST_SEALED;
const id = `song-pcm-${"a".repeat(64)}`;
function fixture(deadline = Date.now() + 60_000, job: string | null = "job-one") {
  let row: SongPcmAdmission = {
    admission_id: id,
    song_post_id: "song",
    song_community_id: "crew",
    audio_revision: "1",
    canonical_audio_sha256: "b".repeat(64),
    audio_asset_ref: "media://immutable/song.mp3",
    state: "processing",
    provider_job_id: job,
    provider_create_started_at: new Date(Date.now() - 1000),
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
});
