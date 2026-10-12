import { describe, expect, test } from "bun:test";
import {
  BadRequest,
  type EndpointDefinition,
  PollSpacesOwnership,
  SpacesOwnerProofRefused,
  StartSpacesOwnership,
} from "@pirate/contracts";
import type { SpacesOwnerProofStore } from "@pirate/platform-cf/spaces-owner-proof-repository";
import { Hono } from "hono";
import { createHttpWorker, decodeInput } from "./transport.ts";

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

describe("Spaces owner recovery transport", () => {
  const progress = {
    contract: "pirate-spaces-ownership-progress-v1" as const,
    network: "mainnet" as const,
    canonical_root: "yahoo",
    read_at: "2026-10-12T12:00:00.000Z",
    ceremony: null,
    operator_assignment: null,
  };
  const base = "https://worker.test/communities/community-1/spaces-ownership";
  const cookie = "__Host-pirate_session=owner-session; __Host-pirate_csrf=csrf-token";
  const pending = {
    contract: "pirate-spaces-ownership-result-v1",
    ceremony_id: `sowner_${"a".repeat(32)}`,
    generation: 1,
    status: "verification_pending",
    retry_after_seconds: 30,
    replayed: false,
  };
  const makeWorker = (refuseResume = false) => {
    const calls: unknown[] = [];
    const store: SpacesOwnerProofStore = {
      list: async (input) => {
        calls.push(input);
        return { items: [{ canonical_root: "yahoo" }], next_cursor: null };
      },
      current: async (input) => {
        calls.push(input);
        return progress;
      },
      resume: async (input) => {
        if (refuseResume) throw new SpacesOwnerProofRefused("not_found");
        calls.push(input);
        return pending;
      },
      start: async () => {
        throw new Error("Unexpected start");
      },
      poll: async () => {
        throw new Error("Unexpected poll");
      },
    };
    const app = createHttpWorker({
      spacesOwnerProof: store,
      config: { corsOrigin: "https://solid.test" },
      authenticate: () => ({ kind: "user", subject: "owner-account" }),
      authorize: () => undefined,
    });
    return { app, store, calls };
  };

  test("reads private progress with a browser session and validates the selected root", async () => {
    const { app, calls } = makeWorker();
    for (const headers of [{}, { authorization: "Bearer owner-token" }]) {
      expect((await app.request(`${base}?root=yahoo`, { headers })).status).toBe(401);
    }
    expect(calls).toHaveLength(0);
    for (const suffix of ["", "?root=@yahoo", "?root=YAHOO"]) {
      expect((await app.request(`${base}${suffix}`, { headers: { cookie } })).status).toBe(400);
    }
    const response = await app.request(`${base}?root=yahoo`, { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual(progress);
    expect(calls).toEqual([
      { accountId: "owner-account", communityId: "community-1", canonicalRoot: "yahoo" },
    ]);
  });

  test("discovers saved roots without a browser locator and keeps the list private", async () => {
    const { app, calls } = makeWorker();
    expect((await app.request(`${base}/roots`)).status).toBe(401);
    expect((await app.request(`${base}/roots?cursor=YAHOO`, { headers: { cookie } })).status).toBe(
      400,
    );
    expect(calls).toHaveLength(0);
    const response = await app.request(`${base}/roots`, { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({
      items: [{ canonical_root: "yahoo" }],
      next_cursor: null,
    });
    expect(calls).toEqual([{ accountId: "owner-account", communityId: "community-1" }]);
  });

  test("resuming requires exact origin and CSRF and passes no browser signature", async () => {
    const { app, calls } = makeWorker();
    const body = JSON.stringify({
      ceremony_id: pending.ceremony_id,
      idempotency_key: "pending-poll",
    });
    const headers = {
      cookie,
      origin: "https://solid.test",
      "x-csrf-token": "csrf-token",
      "content-type": "application/json",
    };
    expect(
      (
        await app.request(`${base}/resume`, {
          method: "POST",
          body,
          headers: { cookie, origin: headers.origin },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await app.request(`${base}/resume`, {
          method: "POST",
          body,
          headers: { ...headers, origin: "https://other.test" },
        })
      ).status,
    ).toBe(401);
    expect(calls).toHaveLength(0);
    expect(
      (await app.request(`${base}/resume`, { method: "POST", body: `${body} `, headers })).status,
    ).toBe(400);
    const response = await app.request(`${base}/resume`, { method: "POST", body, headers });
    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual(pending);
    expect(calls).toEqual([
      {
        accountId: "owner-account",
        communityId: "community-1",
        ceremonyId: pending.ceremony_id,
        idempotencyKey: "pending-poll",
      },
    ]);
  });

  test("does not reveal a missing or wrong-account poll through recovery errors", async () => {
    const { app } = makeWorker(true);
    const response = await app.request(`${base}/resume`, {
      method: "POST",
      headers: {
        cookie,
        origin: "https://solid.test",
        "x-csrf-token": "csrf-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ceremony_id: pending.ceremony_id,
        idempotency_key: "unavailable-poll",
      }),
    });
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(JSON.stringify(await response.json())).not.toContain(pending.ceremony_id);
  });
});
