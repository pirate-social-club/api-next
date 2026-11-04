import { describe, expect, test } from "bun:test";
import { verifyCloudConvertExport } from "./song-video-cloudconvert-verified-master.ts";

const exportUrl = "https://storage.cloudconvert.com/job-1/master.mp4?token=redacted";
const pcmSha256 = "1598c2e0f50412cf9a5a304452dc5e2f3216c7fbadc8012d2245970e3d764a22";

const fixture = async () =>
  new Uint8Array(
    await Bun.file(
      new URL("./song-video-master-verifier/fixtures/master.mp4", import.meta.url),
    ).arrayBuffer(),
  );

describe("CloudConvert master verification boundary", () => {
  test("returns only a bounded, structurally valid master with exact PCM", async () => {
    const bytes = await fixture();
    const result = await verifyCloudConvertExport({
      exportUrl,
      expectedSamples: 150_000,
      expectedPcmSha256: pcmSha256,
      fetch: async (url, init) => {
        expect(url).toBe(exportUrl);
        expect(init.redirect).toBe("manual");
        return new Response(bytes.slice(), {
          headers: { "content-length": String(bytes.byteLength) },
        });
      },
    });
    expect(result.byteLength).toBe(bytes.byteLength);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.soundtrackSha256).toBe(pcmSha256);
    expect(result.bytes).toEqual(bytes);
  });

  test("rejects a substituted soundtrack before returning a master", async () => {
    const bytes = await fixture();
    await expect(
      verifyCloudConvertExport({
        exportUrl,
        expectedSamples: 150_000,
        expectedPcmSha256: "0".repeat(64),
        fetch: async () => new Response(bytes.slice()),
      }),
    ).rejects.toThrow("soundtrack_digest_mismatch");
  });

  test("rejects a non-export host without fetching it", async () => {
    let calls = 0;
    await expect(
      verifyCloudConvertExport({
        exportUrl: "https://unexpected.example/master.mp4",
        expectedSamples: 150_000,
        expectedPcmSha256: pcmSha256,
        fetch: async () => {
          calls += 1;
          return new Response(await fixture());
        },
      }),
    ).rejects.toThrow("invalid CloudConvert export URL");
    expect(calls).toBe(0);
  });
});
