import { describe, expect, test } from "bun:test";

const { verifyCloudConvertMasterAudio } = await import("./master-audio.ts");
const { inspectCloudConvertMasterStructure } = await import("./master-structure.ts");

const fixture = async (name: string) =>
  new Uint8Array(await Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).arrayBuffer());

describe("CloudConvert master soundtrack", () => {
  test("matches the PCM bytes of both synthetic masters", async () => {
    expect(
      await verifyCloudConvertMasterAudio(
        await fixture("master.mp4"),
        150_000,
        "1598c2e0f50412cf9a5a304452dc5e2f3216c7fbadc8012d2245970e3d764a22",
      ),
    ).toMatchObject({ sampleCount: 150_000 });
    expect(
      await verifyCloudConvertMasterAudio(
        await fixture("master-15s.mp4"),
        720_000,
        "8a3e4979c05dfc88a1ffeb5a53dfa58c76a04a73d49934175209aeadb2d171fa",
      ),
    ).toMatchObject({ sampleCount: 720_000 });
  });

  test("rejects a substituted expected soundtrack", async () => {
    await expect(
      verifyCloudConvertMasterAudio(await fixture("master.mp4"), 150_000, "0".repeat(64)),
    ).rejects.toThrow("soundtrack_digest_mismatch");
  });

  test("rejects a changed PCM sample with the original expected digest", async () => {
    const changed = (await fixture("master.mp4")).slice();
    const first = inspectCloudConvertMasterStructure(changed, 150_000).audioChunks[0];
    if (!first) throw new Error("missing PCM chunk");
    first[0] = (first[0] ?? 0) ^ 1;
    await expect(
      verifyCloudConvertMasterAudio(
        changed,
        150_000,
        "1598c2e0f50412cf9a5a304452dc5e2f3216c7fbadc8012d2245970e3d764a22",
      ),
    ).rejects.toThrow("soundtrack_digest_mismatch");
  });
});
