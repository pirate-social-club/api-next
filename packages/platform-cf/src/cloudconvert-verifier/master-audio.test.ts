import { describe, expect, mock, test } from "bun:test";

const wasm = await WebAssembly.compile(
  await Bun.file(new URL("./vendor/flac-decoder.wasm", import.meta.url)).arrayBuffer(),
);
mock.module("./vendor/flac-decoder.wasm", () => ({ default: wasm }));
const { verifyCloudConvertMasterAudio } = await import("./master-audio.ts");

const fixture = async (name: string) =>
  new Uint8Array(await Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).arrayBuffer());

describe("CloudConvert master soundtrack", () => {
  test("pins the decoder WASM bytes", async () => {
    const bytes = await Bun.file(
      new URL("./vendor/flac-decoder.wasm", import.meta.url),
    ).arrayBuffer();
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    expect(Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("")).toBe(
      "79af31833dba4adae91c7b445b2eaad7d0ba51518356966e2cf37f92610488ed",
    );
  });

  test("matches the decoded PCM of both synthetic masters", async () => {
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
});
