import { describe, expect, test } from "bun:test";
import { reconcileCloudConvertRender } from "./song-video-cloudconvert-reconcile.ts";

const tag = "attempt:g1";
const exportUrl = "https://storage.cloudconvert.com/job-1/master.mp4?token=redacted";
const expectedPcmSha256 = "1598c2e0f50412cf9a5a304452dc5e2f3216c7fbadc8012d2245970e3d764a22";
const fixture = async () =>
  new Uint8Array(
    await Bun.file(
      new URL("./song-video-master-verifier/fixtures/master.mp4", import.meta.url),
    ).arrayBuffer(),
  );

describe("CloudConvert render reconciliation", () => {
  test("an absent tag remains pending and never creates a job", async () => {
    let shows = 0;
    const result = await reconcileCloudConvertRender({
      tag,
      expectedSamples: 150_000,
      expectedPcmSha256,
      jobs: {
        findByTag: async (candidate) => {
          expect(candidate).toBe(tag);
          return null;
        },
        show: async () => {
          shows += 1;
          throw new Error("unexpected show");
        },
      },
      fetch: async () => {
        throw new Error("unexpected download");
      },
    });
    expect(result).toEqual({ status: "pending" });
    expect(shows).toBe(0);
  });

  test("the exact finished job yields only a strictly verified master", async () => {
    const bytes = await fixture();
    const result = await reconcileCloudConvertRender({
      tag,
      expectedSamples: 150_000,
      expectedPcmSha256,
      jobs: {
        findByTag: async () => ({ id: "job-1", tag, status: "finished" }),
        show: async () => ({ id: "job-1", tag, status: "finished", exportUrl }),
      },
      fetch: async () => new Response(bytes.slice()),
    });
    expect(result.status).toBe("verified");
    if (result.status === "verified") {
      expect(result.jobId).toBe("job-1");
      expect(result.master.soundtrackSha256).toBe(expectedPcmSha256);
    }
  });

  test("a provider failure is explicit, not a missing-job retry", async () => {
    expect(
      await reconcileCloudConvertRender({
        tag,
        expectedSamples: 150_000,
        expectedPcmSha256,
        jobs: {
          findByTag: async () => ({ id: "job-1", tag, status: "error" }),
          show: async () => {
            throw new Error("unexpected show");
          },
        },
        fetch: async () => {
          throw new Error("unexpected download");
        },
      }),
    ).toEqual({ status: "refused", reason: "provider_failed" });
  });

  test("a crossed job identity never yields bytes", async () => {
    await expect(
      reconcileCloudConvertRender({
        tag,
        expectedSamples: 150_000,
        expectedPcmSha256,
        jobs: {
          findByTag: async () => ({ id: "job-1", tag, status: "finished" }),
          show: async () => ({ id: "job-2", tag, status: "finished", exportUrl }),
        },
        fetch: async () => {
          throw new Error("unexpected download");
        },
      }),
    ).rejects.toThrow("CloudConvert job identity changed");
  });
});
