import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

interface NativeRuntime {
  dispatchFetch(url: string): Promise<Response>;
  dispose(): Promise<void>;
}

// Resolve the exact runtime owned by installed Wrangler, not a second runtime.
const require = createRequire(import.meta.url);
const { Miniflare, convertV4MiniflareOptions } = createRequire(require.resolve("wrangler"))(
  "miniflare",
) as {
  Miniflare: new (options: Record<string, unknown>) => NativeRuntime;
  convertV4MiniflareOptions: (options: Record<string, unknown>) => Record<string, unknown>;
};

test("bounded master downloader calls native workerd fetch with the correct receiver", async () => {
  const script = execFileSync(
    "bun",
    [
      "build",
      fileURLToPath(new URL("./fixtures/cloudconvert-native-download-worker.ts", import.meta.url)),
      "--target",
      "browser",
    ],
    { encoding: "utf8" },
  );
  let requests = 0;
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script,
      compatibilityDate: "2026-08-01",
      compatibilityFlags: ["nodejs_compat"],
      // Native fetch is untouched. Intercept at the runtime service boundary.
      outboundService: (request: Request) => {
        expect(request.url).toBe(
          "https://us-east.storage.cloudconvert.com/native-fetch-fixture/master.mp4",
        );
        expect(request.method).toBe("GET");
        expect(request.headers.has("authorization")).toBe(false);
        requests++;
        return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-length": "3" } });
      },
    }),
  );
  try {
    const response = await runtime.dispatchFetch("https://local.invalid/repro");
    const result = await response.json();
    expect(result).toEqual({
      byteLength: 3,
      sha256: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
    });
    expect(response.status).toBe(200);
    expect(requests).toBe(1);
  } finally {
    await runtime.dispose();
  }
}, 15_000);
