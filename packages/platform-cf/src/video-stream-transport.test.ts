import { expect, test } from "bun:test";
import { makeVideoSourceUrl } from "./video-source-gateway.ts";
import { makeVideoStreamTransport } from "./video-stream-transport.ts";

const gateway = "https://video-source-staging.pirate.sc";
const grantUrl = makeVideoSourceUrl(gateway, "g".repeat(43));

const identity = {
  operationId: "operation-1",
  creator: "a".repeat(64),
  sourceSha256: "b".repeat(64),
};
const source = {
  identity,
  sealedSourceRef: "media://immutable/operation-1/video/1",
  sourceByteLength: 1234,
  sourceMediaType: "video/mp4",
  acceptanceDeadlineMs: 1000,
  requireSignedURLs: true,
  downloadsEnabled: false,
} as const;
const video = {
  uid: "c".repeat(32),
  creator: identity.creator,
  meta: { source_sha256: identity.sourceSha256, operation_id: identity.operationId },
  requireSignedURLs: true,
  readyToStream: true,
  status: { state: "ready" },
};
function fixture(issuedUrl = grantUrl) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const grants: unknown[] = [];
  let reply: (url: string) => Response = (url) =>
    Response.json({
      success: true,
      result: url.endsWith("/downloads") ? {} : url.endsWith("/copy") ? video : [video],
    });
  const transport = makeVideoStreamTransport({
    accountId: "d".repeat(32),
    apiToken: "fixture-token",
    sourceGatewayOrigin: gateway,
    nowMs: () => 0,
    grants: {
      issue: async (input) => {
        grants.push(input);
        return {
          url: issuedUrl,
          expiresAtMs: input.expiresAtMs,
        };
      },
    },
    fetch: (async (url, init) => {
      calls.push({ url: String(url), init });
      return reply(String(url));
    }) as typeof fetch,
  });
  return {
    transport,
    calls,
    grants,
    reply: (fn: typeof reply) => {
      reply = fn;
    },
  };
}

test("Stream copy uses exact sealed facts and a signed-only server template", async () => {
  const f = fixture();
  await f.transport.copy(source);
  expect(f.grants).toEqual([
    {
      objectKey: "immutable/operation-1/video/1",
      requestId: identity.operationId,
      sha256: identity.sourceSha256,
      byteLength: 1234,
      mediaType: "video/mp4",
      expiresAtMs: 1000,
    },
  ]);
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]?.init?.redirect).toBe("error");
  expect(JSON.parse(String(f.calls[0]?.init?.body))).toEqual({
    input: grantUrl,
    creator: identity.creator,
    meta: video.meta,
    requireSignedURLs: true,
  });
});

test("expired intent or invalid logical source cannot issue a grant or copy", async () => {
  const f = fixture();
  await expect(f.transport.copy({ ...source, acceptanceDeadlineMs: 0 })).rejects.toThrow();
  await expect(
    f.transport.copy({ ...source, sealedSourceRef: "https://attacker.invalid" }),
  ).rejects.toThrow();
  expect(f.grants).toHaveLength(0);
  expect(f.calls).toHaveLength(0);
});

test("copy transport does not retry a lost response or expose source secrets in errors", async () => {
  const f = fixture();
  f.reply(() => {
    throw new Error("fixture-token https://secret.invalid/grant");
  });
  await expect(f.transport.copy(source)).rejects.toThrow("Stream transport unavailable");
  expect(f.calls).toHaveLength(1);
});

test("Stream readiness requires encoding completion and no download artifacts", async () => {
  const f = fixture();
  expect(await f.transport.observe(identity)).toEqual([
    {
      providerVideoId: video.uid,
      creator: identity.creator,
      sourceSha256: identity.sourceSha256,
      requireSignedURLs: true,
      downloadsEnabled: false,
      encoding: "ready",
    },
  ]);
  expect(f.calls[0]?.url).toEndWith(`?creator=${identity.creator}&limit=2`);
  f.reply((url) =>
    Response.json({
      success: true,
      result: url.endsWith("/downloads") ? {} : [{ ...video, readyToStream: false }],
    }),
  );
  expect((await f.transport.observe(identity))[0]?.encoding).toBe("pending");
  f.reply((url) =>
    Response.json({
      success: true,
      result: url.endsWith("/downloads")
        ? { default: { status: "inprogress" } }
        : [{ ...video, requireSignedURLs: false }],
    }),
  );
  expect((await f.transport.observe(identity))[0]).toMatchObject({
    downloadsEnabled: true,
    requireSignedURLs: false,
  });
});

test("identity mismatch and duplicate assets are preserved for domain reconciliation", async () => {
  const f = fixture();
  f.reply((url) =>
    Response.json({
      success: true,
      result: url.endsWith("/downloads")
        ? {}
        : [video, { ...video, meta: { ...video.meta, operation_id: "foreign" } }],
    }),
  );
  const result = await f.transport.observe(identity);
  expect(result).toHaveLength(2);
  expect(result[1]?.sourceSha256).toBe("");
});

test("failed, malformed and oversized responses are unavailable, never empty evidence", async () => {
  const f = fixture();
  for (const response of [
    new Response("unavailable", { status: 502 }),
    Response.json({ success: false, result: [] }),
    Response.json({ success: true }),
    new Response("x".repeat(262_145)),
  ]) {
    f.reply(() => response);
    await expect(f.transport.observe(identity)).rejects.toThrow("Stream observation unavailable");
  }
});

test("download inspection failure cannot produce ready", async () => {
  const f = fixture();
  f.reply((url) =>
    url.endsWith("/downloads")
      ? new Response(null, { status: 503 })
      : Response.json({ success: true, result: [video] }),
  );
  await expect(f.transport.observe(identity)).rejects.toThrow("Stream observation unavailable");
});

test("an empty successful lookup remains empty without a download request", async () => {
  const f = fixture();
  f.reply(() => Response.json({ success: true, result: [] }));
  expect(await f.transport.observe(identity)).toEqual([]);
  expect(f.calls).toHaveLength(1);
});

test("HTTP success does not substitute for a valid copy acknowledgement", async () => {
  for (const reply of [
    { success: false, result: video },
    { success: true, result: {} },
  ]) {
    const f = fixture();
    f.reply(() => Response.json(reply));
    await expect(f.transport.copy(source)).rejects.toThrow(
      "Stream copy acknowledgement unavailable",
    );
    expect(f.calls).toHaveLength(1);
  }
});

test("grant host, scheme, credentials, path and query cannot escape the configured gateway", async () => {
  for (const url of [
    grantUrl.replace(gateway, "https://attacker.invalid"),
    grantUrl.replace("https:", "http:"),
    grantUrl.replace("https://", "https://credential@"),
    `${grantUrl}?extra=1`,
    `${grantUrl}#fragment`,
    `${gateway}/other/${"g".repeat(43)}`,
  ]) {
    const f = fixture(url);
    await expect(f.transport.copy(source)).rejects.toThrow(
      "Stream source grant origin or path mismatch",
    );
    expect(f.calls).toHaveLength(0);
  }
});

test("oversized declared response is canceled without reading its body", async () => {
  const f = fixture();
  let canceled = false;
  f.reply(
    () =>
      new Response(
        new ReadableStream({
          cancel() {
            canceled = true;
          },
        }),
        {
          headers: { "content-length": "262145" },
        },
      ),
  );
  await expect(f.transport.observe(identity)).rejects.toThrow("Stream observation unavailable");
  expect(canceled).toBe(true);
});

test("provider ignoring the two-result limit cannot create unbounded download lookups", async () => {
  const f = fixture();
  f.reply(() => Response.json({ success: true, result: [video, video, video] }));
  await expect(f.transport.observe(identity)).rejects.toThrow("Stream observation unavailable");
  expect(f.calls).toHaveLength(1);
});
