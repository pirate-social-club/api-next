import { describe, expect, test } from "bun:test";
import {
  moderatedDanceIntakeFacts,
  noPoseModeratedDanceIntakeFacts,
} from "../../testing/src/moderated-dance-intake-fixture.ts";
import {
  decodeModeratedDanceFramehash,
  makeModeratedDanceNormalizationJob,
  moderatedDanceReplayDigests,
  moderatedDanceSafetySampleOffsets,
  readModeratedDanceExport,
} from "./moderated-dance-normalization.ts";
import { makeSongVideoCloudConvertTransport } from "./song-video-cloudconvert-transport.ts";

const encoder = new TextEncoder(),
  profile = moderatedDanceIntakeFacts().profile;
const framehash = () =>
  `#format: frame checksums\n#version: 2\n#hash: SHA256\n#tb 0: 1/10\n#dimensions 0: 64x64\n${Array.from({ length: 60 }, (_, i) => `0, ${i}, ${i}, 1, 4096, ${String(i % 10).repeat(64)}`).join("\n")}\n`;
describe("private moderated media normalization", () => {
  test("body-only fixed recipe never places a URL or caller text in executable arguments", () => {
    const job = makeModeratedDanceNormalizationJob({
      tag: "private-attempt-1",
      sourceUrl: "https://private.example/source?cap=opaque",
      bodyStartMs: 2000,
      bodyEndMs: 8000,
      profile,
    });
    expect(job.tasks["body-identity"].engine_version).toBe("6.1.4");
    expect(job.tasks["body-identity"].arguments).toContain("trim=start=2.000:end=8.000");
    expect(job.tasks["body-identity"].arguments).toContain(
      "eof_action=pass,trim=end_frame=60,scale=",
    );
    expect(job.tasks["body-identity"].arguments).not.toContain("opaque");
    expect(job.tasks["body-identity"].arguments).not.toContain("cue");
    expect(job.tasks["body-identity"].timeout).toBe(profile.normalizationTimeoutSeconds);
    expect(job.tasks["export-dance"].input).toHaveLength(4);
    expect(() =>
      makeModeratedDanceNormalizationJob({
        tag: "x;rm",
        sourceUrl: "https://example.test",
        bodyStartMs: 2000,
        bodyEndMs: 8000,
        profile,
      }),
    ).toThrow();
  });
  test("real provider output preserves fractional body boundaries without admitting an overrun", async () => {
    const bytes = new Uint8Array(
      await Bun.file(
        new URL("./moderated-dance-normalization-fixtures/body-6001ms.framehash", import.meta.url),
      ).arrayBuffer(),
    );
    expect(decodeModeratedDanceFramehash(bytes, profile, 6001)).toHaveLength(61);
    expect(() => decodeModeratedDanceFramehash(bytes, profile, 6000)).toThrow(
      "Incomplete normalized body",
    );
    for (const [bodyEndMs, frames] of [
      [8000, 60],
      [8001, 61],
      [8100, 61],
    ] as const) {
      const job = makeModeratedDanceNormalizationJob({
        tag: "fractional-body",
        sourceUrl: "https://private.example/synthetic",
        bodyStartMs: 2000,
        bodyEndMs,
        profile,
      });
      expect(job.tasks["body-identity"].arguments).toContain(
        `eof_action=pass,trim=end_frame=${frames},scale=`,
      );
    }
  });
  test("exact normalized frame evidence rejects short bodies, timestamp/stream/dimension substitution", () => {
    const good = framehash();
    expect(decodeModeratedDanceFramehash(encoder.encode(good), profile, 6000)).toHaveLength(60);
    for (const bad of [
      `${good}0, 60, 60, 1, 4096, ${"a".repeat(64)}\n`,
      good.replace(`0, 59, 59, 1, 4096, ${"9".repeat(64)}`, ""),
      good.replace("0, 0, 0, 1", "0, 1, 1, 1"),
      good.replace("#dimensions 0: 64x64", "#dimensions 0: 32x32"),
      good.replace("#tb 0: 1/10", "#tb 0: 1/30"),
      good.replace("0, 0, 0, 1", "1, 0, 0, 1"),
      good.replace("#hash: SHA256", "#hash: SHA1"),
    ])
      expect(() => decodeModeratedDanceFramehash(encoder.encode(bad), profile, 6000)).toThrow();
  });
  test("cross-account/session/cue changes cannot namespace replay; compatible epochs and raw/body are distinct", async () => {
    const frames = decodeModeratedDanceFramehash(encoder.encode(framehash()), profile, 6000),
      keys = new Map([
        ["old", new Uint8Array(32).fill(1)],
        ["new", new Uint8Array(32).fill(2)],
      ]);
    const a = await moderatedDanceReplayDigests({
      scope: "global",
      sourceSha256: "a".repeat(64),
      frames,
      keys,
    });
    const b = await moderatedDanceReplayDigests({
      scope: "global",
      sourceSha256: "b".repeat(64),
      frames,
      keys,
    });
    expect(a.claims).toHaveLength(4);
    expect(new Set(a.claims.map((c) => c.digest)).size).toBe(4);
    expect(a.claims.filter((c) => c.kind === "body")).toEqual(
      b.claims.filter((c) => c.kind === "body"),
    );
    expect(a.claims.filter((c) => c.kind === "raw")).not.toEqual(
      b.claims.filter((c) => c.kind === "raw"),
    );
    await expect(
      moderatedDanceReplayDigests({
        scope: "global",
        sourceSha256: "a".repeat(64),
        frames,
        keys: new Map(),
      }),
    ).rejects.toThrow();
  });
  test("bounded private export reads never redirect or leak a provider bearer", async () => {
    const calls: RequestInit[] = [];
    const bytes = await readModeratedDanceExport(
      "https://eu-central.storage.cloudconvert.com/private",
      10,
      new AbortController().signal,
      async (_url, init) => {
        calls.push(init ?? {});
        return new Response("test", { headers: { "content-length": "4" } });
      },
    );
    expect(new TextDecoder().decode(bytes)).toBe("test");
    expect(calls[0]?.redirect).toBe("manual");
    expect(calls[0]?.headers).toBeUndefined();
    await expect(
      readModeratedDanceExport(
        "https://evil.example/x",
        10,
        new AbortController().signal,
        async () => {
          throw new Error("must not fetch");
        },
      ),
    ).rejects.toThrow();
    await expect(
      readModeratedDanceExport(
        "https://eu-central.storage.cloudconvert.com/private",
        3,
        new AbortController().signal,
        async () => new Response("oversize"),
      ),
    ).rejects.toThrow();
  });
  test("private job observation requires all four exact, bounded exports and rejects duplicate/foreign artifacts", async () => {
    const files = ["recording.framehash", "frame-0.jpg", "frame-1.jpg", "frame-2.jpg"].map(
      (filename) => ({ filename, url: `https://eu-central.storage.cloudconvert.com/${filename}` }),
    );
    const transport = (entries: unknown[]) =>
      makeSongVideoCloudConvertTransport({
        apiKey: "test-only",
        fetch: async () =>
          new Response(
            JSON.stringify({
              data: {
                id: "job",
                tag: "private-attempt-1",
                status: "finished",
                tasks: [
                  {
                    name: "export-dance",
                    operation: "export/url",
                    status: "finished",
                    result: { files: entries },
                  },
                ],
              },
            }),
          ),
      });
    expect((await transport(files).showPrivateDance("job")).exports?.frames).toHaveLength(3);
    for (const bad of [
      files.slice(0, 3),
      [files[0], files[1], files[1], files[3]],
      files.map((f, i) => (i === 0 ? { ...f, url: "https://evil.example/x" } : f)),
    ])
      await expect(transport(bad).showPrivateDance("job")).rejects.toMatchObject({
        outcome: "uncertain",
      });
  });
});

test("prospective no-pose samples the dance without a pre-roll and preserves the body replay recipe", () => {
  const p = noPoseModeratedDanceIntakeFacts().profile;
  expect(moderatedDanceSafetySampleOffsets(2000, 8000, profile)).toEqual([0, 1000, 5000]);
  expect(moderatedDanceSafetySampleOffsets(0, 6000, p)).toEqual([0, 1500, 4500]);
  const job = makeModeratedDanceNormalizationJob({
    tag: "no-pose",
    sourceUrl: "https://private.example/synthetic",
    bodyStartMs: 0,
    bodyEndMs: 6000,
    profile: p,
  });
  expect(job.tasks["body-identity"].arguments).toContain("trim=start=0.000:end=6.000");
  expect(job.tasks["sample-1"].arguments).toContain("-ss 1.500");
  expect(job.tasks["sample-2"].arguments).toContain("-ss 4.500");
  const reference = makeModeratedDanceNormalizationJob({
    tag: "reference",
    sourceUrl: "https://private.example/synthetic",
    bodyStartMs: 0,
    bodyEndMs: 6000,
    profile,
  });
  expect(job.tasks["body-identity"]).toEqual(reference.tasks["body-identity"]);
});
