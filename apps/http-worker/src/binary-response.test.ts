import { describe, expect, test } from "bun:test";
import { Auth, endpoint } from "@pirate/contracts";
import { Schema } from "effect";
import { binaryEndpointResponse } from "./binary-response.ts";

const definition = endpoint({
  method: "GET",
  path: "/fixture-poster",
  auth: Auth.public(),
  response: Schema.Unknown,
  responseRepresentation: {
    kind: "binary",
    contentType: "image/jpeg",
    cacheControl: "private, no-cache",
    conditional: "authorized-etag",
  },
  successStatus: [200, 304],
});
const headers = () =>
  new Headers({
    etag: '"bytes"',
    "cache-control": "public",
    "x-private-locator": "must not escape",
  });

describe("binary serialization after authorized handler completion", () => {
  test("preserves stream identity and forces the declared private response headers", async () => {
    const body = new ReadableStream<Uint8Array>();
    const response = await binaryEndpointResponse(definition, body, 200, headers());
    expect(response.body).toBe(body);
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("x-private-locator")).toBeNull();
    await body.cancel();
  });
  test("requires an empty body on 304 and cancels a rejected stream", async () => {
    expect((await binaryEndpointResponse(definition, null, 304, headers())).body).toBeNull();
    let cancelled = false;
    const body = new ReadableStream({
      cancel: () => {
        cancelled = true;
      },
    });
    await expect(binaryEndpointResponse(definition, body, 304, headers())).rejects.toThrow(
      "Invalid binary",
    );
    expect(cancelled).toBe(true);
  });
  test.each(["json", "response", "etag", "type", "status"])(
    "rejects %s without a transport bypass",
    async (kind) => {
      const responseHeaders = headers();
      if (kind === "etag") responseHeaders.delete("etag");
      if (kind === "type") responseHeaders.set("content-type", "text/html");
      const body =
        kind === "json"
          ? { arbitrary: "json" }
          : kind === "response"
            ? new Response("bypass")
            : new ReadableStream();
      await expect(
        binaryEndpointResponse(definition, body, kind === "status" ? 206 : 200, responseHeaders),
      ).rejects.toThrow("Invalid binary");
    },
  );
});
