import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import worker, { makeVideoSourceGatewayWorker } from "../../apps/video-source-gateway/src/index.ts";
import {
  makeVideoSourceUrl,
  type VideoSourceGrant,
} from "../../packages/platform-cf/src/video-source-gateway.ts";

const bindings = env as typeof env & {
  MEDIA_IMMUTABLE_ORIGINALS: R2Bucket;
  CONTROL_PLANE: { connectionString: string };
};
const capability = "a".repeat(43);
const key = "sealed/private-fixture.mp4";
const url = makeVideoSourceUrl("https://source.example", capability);
let grant: VideoSourceGrant;
let lines: string[];
const handler = makeVideoSourceGatewayWorker(() => ({
  resolve: async (requested) => (requested === capability ? grant : null),
}));
beforeEach(async () => {
  lines = [];
  for (const method of ["log", "warn", "error", "info", "debug"] as const)
    vi.spyOn(console, method).mockImplementation((...args) => {
      lines.push(JSON.stringify(args));
    });
  const object = await bindings.MEDIA_IMMUTABLE_ORIGINALS.put(key, "0123456789", {
    httpMetadata: { contentType: "video/mp4" },
  });
  grant = {
    expiresAtMs: Date.now() + 60_000,
    object: {
      key,
      version: object.version,
      etag: object.etag,
      size: object.size,
      contentType: "video/mp4",
      canonicalSha256: "84d89877f0d4041efb6bf91a16f0248f2fd573e6af05c19f96bedb9f882f7882",
    },
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  const output = lines.join("\n");
  for (const secret of [capability, key, grant.object.canonicalSha256])
    expect(output).not.toContain(secret);
});

describe("video source Worker real handler in Workerd", () => {
  test("HEAD and full GET use the sealed R2 object", async () => {
    const head = await handler.fetch(new Request(url, { method: "HEAD" }), bindings);
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
    expect(head.headers.get("content-length")).toBe("10");
    const full = await handler.fetch(new Request(url), bindings);
    expect(full.status).toBe(200);
    expect(new TextDecoder().decode(await full.arrayBuffer())).toBe("0123456789");
    expect(full.headers.get("cache-control")).toBe("private, no-store");
  });
  test.each([
    ["bytes=2-5", "2345", "bytes 2-5/10"],
    ["bytes=-3", "789", "bytes 7-9/10"],
  ])("single range %s", async (range, body, contentRange) => {
    const result = await handler.fetch(new Request(url, { headers: { range } }), bindings);
    expect(result.status).toBe(206);
    expect(new TextDecoder().decode(await result.arrayBuffer())).toBe(body);
    expect(result.headers.get("content-range")).toBe(contentRange);
  });
  test("multi-range is rejected", async () => {
    const result = await handler.fetch(
      new Request(url, { headers: { range: "bytes=0-1,4-5" } }),
      bindings,
    );
    expect(result.status).toBe(416);
    expect(result.headers.get("content-range")).toBe("bytes */10");
  });
  test("queries and all other paths stay closed, including write methods", async () => {
    for (const target of [
      `${url}?x=1`,
      "https://source.example/",
      "https://source.example/upload",
    ]) {
      for (const method of ["GET", "POST"])
        expect((await handler.fetch(new Request(target, { method }), bindings)).status).toBe(404);
    }
    expect((await handler.fetch(new Request(url, { method: "POST" }), bindings)).status).toBe(405);
  });
  test("expiry is rechecked on each request", async () => {
    expect((await handler.fetch(new Request(url, { method: "HEAD" }), bindings)).status).toBe(200);
    grant = { ...grant, expiresAtMs: Date.now() - 1 };
    expect((await handler.fetch(new Request(url), bindings)).status).toBe(404);
  });
  test("replaced R2 object fails closed", async () => {
    await bindings.MEDIA_IMMUTABLE_ORIGINALS.put(key, "replacement", {
      httpMetadata: { contentType: "video/mp4" },
    });
    expect((await handler.fetch(new Request(url), bindings)).status).toBe(409);
  });
  test("dependency exceptions cannot leak through logs or responses", async () => {
    const unavailable = makeVideoSourceGatewayWorker(() => ({
      resolve: async () => {
        throw new Error(`${url} ${key} ${grant.object.canonicalSha256}`);
      },
    }));
    const result = await unavailable.fetch(new Request(url), bindings);
    expect(result.status).toBe(503);
    expect(await result.text()).toBe("");
    expect(lines).toEqual([
      JSON.stringify([JSON.stringify({ event: "source_unavailable", status: 503 })]),
    ]);
  });
  test("default entrypoint fails closed for invalid control-plane configuration", async () => {
    expect(
      (
        await worker.fetch(new Request(url), {
          ...bindings,
          CONTROL_PLANE: {
            connectionString: "postgresql://fixture:fixture@127.0.0.1:invalid/unavailable",
          },
        })
      ).status,
    ).toBe(503);
  });
  test("default entrypoint bounds unavailable socket resolution", async () => {
    const started = performance.now();
    const result = await worker.fetch(new Request(url), {
      ...bindings,
      CONTROL_PLANE: { connectionString: "postgresql://fixture:fixture@127.0.0.1:1/unavailable" },
    });
    expect(result.status).toBe(503);
    expect(await result.text()).toBe("");
    expect(performance.now() - started).toBeLessThan(4_500);
  }, 6_000);
  test("resolution deadline aborts even a resolver that never settles", async () => {
    let observed: AbortSignal | undefined;
    const hung = makeVideoSourceGatewayWorker(() => ({
      resolve: (_capability, signal) => {
        observed = signal;
        return new Promise(() => {});
      },
    }));
    const result = await hung.fetch(new Request(url), bindings);
    expect(result.status).toBe(503);
    expect(observed?.aborted).toBe(true);
  }, 6_000);
});
