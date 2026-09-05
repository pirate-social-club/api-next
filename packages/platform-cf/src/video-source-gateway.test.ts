import { describe, expect, test } from "bun:test";
import {
  makeVideoSourceGateway,
  makeVideoSourceUrl,
  type VideoSourceBucket,
  type VideoSourceGatewayLogEvent,
  type VideoSourceGrant,
} from "./video-source-gateway.ts";

const capability = "aBCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-abcde";
const objectKey = "sealed/video/private-object.mp4";
const canonicalSha256 = "ab".repeat(32);
const bytes = new TextEncoder().encode("0123456789");

const grant: VideoSourceGrant = {
  expiresAtMs: 2_000,
  object: {
    key: objectKey,
    version: "sealed-version",
    etag: "sealed-etag",
    size: bytes.byteLength,
    contentType: "video/mp4",
    canonicalSha256,
  },
};

function stream(value: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(value);
      controller.close();
    },
  });
}

function makeBucket(replacement = false): VideoSourceBucket {
  const identity = {
    key: objectKey,
    version: replacement ? "replacement-version" : "sealed-version",
    etag: replacement ? "replacement-etag" : "sealed-etag",
    size: bytes.byteLength,
    checksums: { sha256: Uint8Array.from({ length: 32 }, () => 0xab).buffer },
    httpMetadata: { contentType: "video/mp4" },
  };
  return {
    head: async () => identity,
    get: async (_key, options) => {
      const range = options.range;
      const selected =
        range === undefined ? bytes : bytes.slice(range.offset, range.offset + range.length);
      return { ...identity, body: stream(selected) };
    },
  };
}

function setup(input: Readonly<{ now?: number; replacement?: boolean }> = {}) {
  const logs: VideoSourceGatewayLogEvent[] = [];
  return {
    logs,
    gateway: makeVideoSourceGateway({
      bucket: makeBucket(input.replacement),
      grants: { resolve: async (requested) => (requested === capability ? grant : null) },
      now: () => input.now ?? 1_000,
      logger: (event) => logs.push(event),
    }),
  };
}

describe("sealed video source gateway", () => {
  test("serves authenticated HEAD and exact byte ranges", async () => {
    const { gateway } = setup();
    const url = makeVideoSourceUrl("https://media.example", capability);
    const head = await gateway(new Request(url, { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
    expect(head.headers.get("content-range")).toBe("bytes 0-9/10");
    expect(head.headers.get("cache-control")).toBe("private, no-store");

    for (const [range, expectedContentRange, expectedBody] of [
      ["bytes=2-5", "bytes 2-5/10", "2345"],
      ["bytes=7-", "bytes 7-9/10", "789"],
      ["bytes=-3", "bytes 7-9/10", "789"],
    ] as const) {
      const response = await gateway(new Request(url, { headers: { range } }));
      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toBe(expectedContentRange);
      expect(await response.text()).toBe(expectedBody);
    }
  });

  test("rejects invalid ranges without reading object bytes", async () => {
    let reads = 0;
    const gateway = makeVideoSourceGateway({
      bucket: {
        ...makeBucket(),
        get: async () => {
          reads += 1;
          return null;
        },
      },
      grants: { resolve: async () => grant },
      now: () => 1_000,
    });

    for (const range of ["items=0-1", "bytes=3-2", "bytes=0-1,3-4", "bytes=10-"]) {
      const response = await gateway(
        new Request(makeVideoSourceUrl("https://media.example", capability), {
          headers: { range },
        }),
      );
      expect(response.status).toBe(416);
      expect(response.headers.get("content-range")).toBe("bytes */10");
    }
    expect(reads).toBe(0);
  });

  test("fails closed for missing, expired, queried, and replaced capabilities", async () => {
    const missing = await setup().gateway(
      new Request("https://media.example/.well-known/pirate/video-source/v1/short"),
    );
    const expired = await setup({ now: 2_000 }).gateway(
      new Request(makeVideoSourceUrl("https://media.example", capability)),
    );
    const queried = await setup().gateway(
      new Request(`${makeVideoSourceUrl("https://media.example", capability)}?key=${objectKey}`),
    );
    const replaced = await setup({ replacement: true }).gateway(
      new Request(makeVideoSourceUrl("https://media.example", capability)),
    );

    expect([missing.status, expired.status, queried.status, replaced.status]).toEqual([
      404, 404, 404, 409,
    ]);
  });

  test("typed diagnostics never contain the capability or sealed identity", async () => {
    const { gateway, logs } = setup();
    await gateway(
      new Request(makeVideoSourceUrl("https://media.example", capability), {
        headers: { range: "bytes=0-2" },
      }),
    );
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain(objectKey);
    expect(serialized).not.toContain(capability);
    expect(serialized).not.toContain(canonicalSha256);
    expect(logs).toEqual([
      { event: "source_request", method: "GET", outcome: "served", status: 206 },
    ]);
  });

  test("constructs only credential-free HTTPS source URLs", () => {
    expect(makeVideoSourceUrl("https://media.example/base?q=1", capability)).toBe(
      `https://media.example/.well-known/pirate/video-source/v1/${capability}`,
    );
    expect(() => makeVideoSourceUrl("http://media.example", capability)).toThrow();
    expect(() => makeVideoSourceUrl("https://user:secret@media.example", capability)).toThrow();
    expect(() => makeVideoSourceUrl("https://media.example:8443", capability)).toThrow();
  });
});
