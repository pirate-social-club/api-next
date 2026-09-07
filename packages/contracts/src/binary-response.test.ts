import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { generateClient, generateOpenApi } from "./codegen.ts";
import { endpoint } from "./endpoint.ts";
import { NotFound } from "./errors.ts";
import { diffBreaking } from "./openapi-diff.ts";

const fixture = endpoint({
  method: "GET",
  path: "/fixture-poster",
  auth: Auth.public(),
  request: { headers: Schema.Struct({ "if-none-match": Schema.optional(Schema.String) }) },
  response: Schema.Unknown,
  responseRepresentation: {
    kind: "binary",
    contentType: "image/jpeg",
    cacheControl: "private, no-cache",
    conditional: "authorized-etag",
  },
  successStatus: [200, 304],
  errors: [NotFound],
});

describe("binary response contract", () => {
  test("compatibility detection protects bytes, conditional authorization and headers", () => {
    const before = generateOpenApi({ Fixture: fixture });
    expect(diffBreaking(before, structuredClone(before))).toEqual([]);
    for (const change of [
      (responses: Record<string, Record<string, unknown>>) => {
        delete responses["200"]?.content;
      },
      (responses: Record<string, Record<string, unknown>>) => {
        delete responses["304"]?.["x-conditional-authorization"];
      },
      (responses: Record<string, Record<string, unknown>>) => {
        delete responses["304"]?.headers;
      },
      (responses: Record<string, Record<string, unknown>>) => {
        if (responses["304"])
          responses["304"].content = {
            "image/jpeg": { schema: { type: "string", format: "binary" } },
          };
      },
    ]) {
      const after = structuredClone(before);
      change(
        after.paths["/fixture-poster"]?.get?.responses as Record<string, Record<string, unknown>>,
      );
      expect(diffBreaking(before, after).length).toBeGreaterThan(0);
    }
  });
  test("rejects incompatible method and statuses", () => {
    expect(() => endpoint({ ...fixture, method: "POST" })).toThrow("Invalid binary");
    expect(() => endpoint({ ...fixture, successStatus: [200] })).toThrow("Invalid binary");
    expect(() => endpoint({ ...fixture, successStatus: [200, 204] })).toThrow("Invalid binary");
  });
  test("OpenAPI distinguishes JPEG, bodyless 304 and JSON denial", () => {
    const document = generateOpenApi({ Fixture: fixture });
    const responses = document.paths["/fixture-poster"]?.get?.responses as Record<string, unknown>;
    expect(responses["200"]).toMatchObject({
      content: { "image/jpeg": { schema: { type: "string", format: "binary" } } },
      "x-conditional-authorization": "handler-before-304",
    });
    expect(responses["304"]).not.toHaveProperty("content");
    expect(responses["304"]).toHaveProperty("headers.ETag.required", true);
    expect(responses["404"]).toHaveProperty("content.application/json");
  });
  test("generated client preserves streams, decodes 304 without JSON, and keeps denials typed", async () => {
    const source = generateClient({ Fixture: fixture });
    const javascript = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
    const generated = await import(`data:text/javascript;base64,${btoa(javascript)}`);
    const headers = {
      "content-type": "image/jpeg",
      "cache-control": "private, no-cache",
      etag: '"bytes"',
    };
    let response = new Response(new Uint8Array([255, 216, 255, 217]), { headers });
    const client = generated.createPirateApiClient("https://fixture.invalid", {
      fetchImpl: async () => response,
    });
    const first = await client.get_fixturePoster({});
    expect(first.status).toBe(200);
    expect(first.body).toBe(response.body);
    expect(first.etag).toBe('"bytes"');
    await first.body.cancel();
    response = new Response(null, { status: 304, headers });
    expect(await client.get_fixturePoster({})).toEqual({
      status: 304,
      body: null,
      etag: '"bytes"',
    });
    response = Response.json(
      { error: { code: "not_found", message: "Video not found", retryable: false } },
      { status: 404 },
    );
    await expect(client.get_fixturePoster({})).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
    response = new Response("wrong", { headers: { ...headers, "content-type": "text/html" } });
    await expect(client.get_fixturePoster({})).rejects.toThrow("Invalid binary response body");
    response = new Response("wrong", { headers: { ...headers, etag: "unquoted" } });
    await expect(client.get_fixturePoster({})).rejects.toThrow("Invalid binary response headers");
  });
});
