import { describe, expect, test } from "bun:test";
import {
  Auth,
  BadRequest,
  type EndpointDefinition,
  endpoint,
  InternalError,
  PollNamespaceOwnership,
  StartNamespaceOwnership,
} from "@pirate/contracts";
import { Schema } from "effect";
import { Hono } from "hono";
import { decodeInput } from "./transport.ts";

const startPath =
  "http://worker.test/community-creation-intents/intent-1/namespace-ownership/start";
const pollPath = "http://worker.test/community-creation-intents/intent-1/namespace-ownership/poll";

const exactStart =
  '{"ceremony_intent_id":"ceremony-1","expected_revision":1,"idempotency_key":"start-1"}';

async function decodeBody(
  endpoint: EndpointDefinition,
  url: string,
  body: string | Uint8Array,
  headers: Record<string, string> = { "content-type": "application/json" },
): Promise<{ readonly decoded?: unknown; readonly failure?: unknown }> {
  const app = new Hono();
  let decoded: unknown;
  let failure: unknown;
  app.post(endpoint.path, async (context) => {
    try {
      decoded = (await decodeInput(endpoint, context as never, null)).body;
    } catch (error) {
      failure = error;
    }
    return new Response("ok");
  });
  await app.request(url, { method: "POST", headers, body });
  return {
    ...(decoded === undefined ? {} : { decoded }),
    ...(failure === undefined ? {} : { failure }),
  };
}

describe("namespace ownership exact-json transport", () => {
  test("accepts canonical JSON and preserves the decoded typed body", async () => {
    const result = await decodeBody(StartNamespaceOwnership, startPath, exactStart);
    expect(result.failure).toBeUndefined();
    expect(result.decoded).toEqual({
      ceremony_intent_id: "ceremony-1",
      expected_revision: 1,
      idempotency_key: "start-1",
    });
  });

  test("rejects duplicate keys, whitespace, alternate numbers, BOM, wrong order, and excess fields", async () => {
    const invalidBodies = [
      '{"ceremony_intent_id":"ceremony-1","expected_revision":1,"idempotency_key":"start-1","idempotency_key":"start-1"}',
      '{ "ceremony_intent_id":"ceremony-1","expected_revision":1,"idempotency_key":"start-1"}',
      '{"ceremony_intent_id":"ceremony-1","expected_revision":1.0,"idempotency_key":"start-1"}',
      '{"ceremony_intent_id":"ceremony-1","expected_revision":1e0,"idempotency_key":"start-1"}',
      '{"ceremony_intent_id":"ceremony-1","expected_revision":-0,"idempotency_key":"start-1"}',
      '{"ceremony_intent_id":"ceremony-1","expected_revision":null,"idempotency_key":"start-1"}',
      '{"ceremony_intent_id":"c\\u0065remony-1","expected_revision":1,"idempotency_key":"start-1"}',
      '\uFEFF{"ceremony_intent_id":"ceremony-1","expected_revision":1,"idempotency_key":"start-1"}',
      '{"idempotency_key":"start-1","ceremony_intent_id":"ceremony-1","expected_revision":1}',
      '{"ceremony_intent_id":"ceremony-1","expected_revision":1,"idempotency_key":"start-1","extra":true}',
    ];
    for (const body of invalidBodies) {
      const result = await decodeBody(StartNamespaceOwnership, startPath, body);
      expect(result.decoded, body).toBeUndefined();
      expect(result.failure, body).toBeInstanceOf(BadRequest);
    }
    const invalidUtf8 = await decodeBody(
      StartNamespaceOwnership,
      startPath,
      new Uint8Array([0x7b, 0xff, 0x7d]),
    );
    expect(invalidUtf8.failure).toBeInstanceOf(BadRequest);
  });

  test("enforces the endpoint-specific streamed byte limits", async () => {
    const compactEndpoint = endpoint({
      method: "POST",
      path: "/test/compact-limit",
      auth: Auth.public(),
      request: {
        body: Schema.Struct({ value: Schema.String }),
        bodyEncoding: "exact-json",
        maxBodyBytes: 10,
      },
      response: Schema.Struct({ ok: Schema.Boolean }),
    });
    const compact = await decodeBody(
      compactEndpoint,
      "http://worker.test/test/compact-limit",
      '{"value":"x"}',
    );
    expect(compact.failure).toBeInstanceOf(BadRequest);

    const invalidLimitEndpoint = endpoint({
      method: "POST",
      path: "/test/invalid-limit",
      auth: Auth.public(),
      request: {
        body: Schema.Struct({ value: Schema.String }),
        bodyEncoding: "exact-json",
        maxBodyBytes: 1_048_577,
      },
      response: Schema.Struct({ ok: Schema.Boolean }),
    });
    const invalidLimit = await decodeBody(
      invalidLimitEndpoint,
      "http://worker.test/test/invalid-limit",
      '{"value":"x"}',
    );
    expect(invalidLimit.failure).toBeInstanceOf(InternalError);

    const start = await decodeBody(
      StartNamespaceOwnership,
      startPath,
      `{"ceremony_intent_id":"${"x".repeat(2_000)}","expected_revision":1,"idempotency_key":"start-1"}`,
    );
    expect(start.failure).toBeInstanceOf(BadRequest);

    const poll = await decodeBody(
      PollNamespaceOwnership,
      pollPath,
      `{"ceremony_intent_id":"${"x".repeat(4_000)}","session_id":"session-1","expected_revision":1,"idempotency_key":"poll-1","channel":"poll_result"}`,
    );
    expect(poll.failure).toBeInstanceOf(BadRequest);
  });

  test("requires application/json for exact-json bodies", async () => {
    const result = await decodeBody(StartNamespaceOwnership, startPath, exactStart, {
      "content-type": "text/plain",
    });
    expect(result.failure).toBeInstanceOf(BadRequest);
  });

  test("preserves raw-text BOM bytes for legacy callback bodies", async () => {
    const rawEndpoint = endpoint({
      method: "POST",
      path: "/test/raw-bom",
      auth: Auth.public(),
      request: { body: Schema.String, bodyEncoding: "raw-text" },
      response: Schema.Struct({ ok: Schema.Boolean }),
    });
    const app = new Hono();
    let decoded: unknown;
    app.post("/test/raw-bom", async (context) => {
      decoded = (await decodeInput(rawEndpoint, context as never, null)).body;
      return new Response("ok");
    });
    const body = "\uFEFFraw callback bytes\n";
    await app.request("http://worker.test/test/raw-bom", {
      method: "POST",
      body,
    });
    expect(decoded).toBe(body);
  });
});
