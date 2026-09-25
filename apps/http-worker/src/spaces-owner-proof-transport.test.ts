import { describe, expect, test } from "bun:test";
import {
  BadRequest,
  type EndpointDefinition,
  PollSpacesOwnership,
  StartSpacesOwnership,
} from "@pirate/contracts";
import { Hono } from "hono";
import { decodeInput } from "./transport.ts";

async function decodeBody(endpoint: EndpointDefinition, body: string) {
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
  await app.request(
    `http://worker.test/communities/community-1/spaces-ownership/${endpoint === StartSpacesOwnership ? "start" : "poll"}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    },
  );
  return { decoded, failure };
}

describe("Spaces owner proof exact request bytes", () => {
  test("accepts only the JSON byte sequence persisted for start replay", async () => {
    const accepted = '{"idempotency_key":"start-1","canonical_root":"yahoo"}';
    expect((await decodeBody(StartSpacesOwnership, accepted)).decoded).toEqual({
      idempotency_key: "start-1",
      canonical_root: "yahoo",
    });
    for (const body of [
      '{"canonical_root":"yahoo","idempotency_key":"start-1"}',
      '{ "idempotency_key":"start-1","canonical_root":"yahoo"}',
      '{"idempotency_key":"start-1","canonical_root":"yahoo","idempotency_key":"start-1"}',
    ]) {
      expect((await decodeBody(StartSpacesOwnership, body)).failure).toBeInstanceOf(BadRequest);
    }
  });

  test("accepts only the JSON byte sequence persisted for poll replay", async () => {
    const body = JSON.stringify({
      ceremony_id: `sowner_${"a".repeat(32)}`,
      idempotency_key: "poll-1",
      signature_hex: "b".repeat(128),
    });
    expect((await decodeBody(PollSpacesOwnership, body)).decoded).toEqual(JSON.parse(body));
    expect((await decodeBody(PollSpacesOwnership, `${body} `)).failure).toBeInstanceOf(BadRequest);
  });
});
