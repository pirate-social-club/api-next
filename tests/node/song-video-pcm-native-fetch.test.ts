import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

interface NativeRuntime {
  dispatchFetch(url: string): Promise<Response>;
  dispose(): Promise<void>;
}
const require = createRequire(import.meta.url);
const { Miniflare, convertV4MiniflareOptions } = createRequire(require.resolve("wrangler"))(
  "miniflare",
) as {
  Miniflare: new (options: Record<string, unknown>) => NativeRuntime;
  convertV4MiniflareOptions: (options: Record<string, unknown>) => Record<string, unknown>;
};

test("PCM admission downloads with native fetch, streams R2 and admits measured facts", async () => {
  const script = execFileSync(
    "bun",
    [
      "build",
      fileURLToPath(new URL("./fixtures/pcm-admission-native-fetch-worker.ts", import.meta.url)),
      "--target",
      "browser",
    ],
    { encoding: "utf8" },
  );
  const id = `song-pcm-${"a".repeat(64)}`;
  const calls: string[] = [];
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script,
      compatibilityDate: "2026-08-01",
      compatibilityFlags: ["nodejs_compat"],
      r2Buckets: ["PCM"],
      outboundService: (request: Request) => {
        const url = new URL(request.url);
        calls.push(`${request.method} ${url.hostname}`);
        if (url.hostname === "us-east.storage.cloudconvert.com") {
          expect(request.headers.has("authorization")).toBe(false);
          return new Response(new Uint8Array(16), { headers: { "content-length": "16" } });
        }
        expect(url.hostname).toBe("api.cloudconvert.com");
        if (request.method === "DELETE") return new Response(null, { status: 204 });
        const job = {
          id: "job-pcm",
          tag: id,
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
                    url: "https://us-east.storage.cloudconvert.com/native-pcm/song.pcm",
                  },
                ],
              },
            },
          ],
        };
        return Response.json({ data: url.search ? [job] : job });
      },
    }),
  );
  try {
    const response = await runtime.dispatchFetch("https://local.invalid/repro");
    expect(await response.json()).toMatchObject({
      outcome: "ack",
      state: "admitted",
      cleaned: true,
      facts: {
        byteLength: 16,
        durationSamples: 4,
        pcmSha256: "374708fff7719dd5979ec875d56cd2286f6d3cf7ec317a3b25632aab28ec37bb",
      },
    });
    expect(calls).toEqual([
      "GET api.cloudconvert.com",
      "GET us-east.storage.cloudconvert.com",
      "GET api.cloudconvert.com",
      "DELETE api.cloudconvert.com",
    ]);
  } finally {
    await runtime.dispose();
  }
}, 15_000);
