// PRIVATE TEST PROPOSAL. All definitions remain disabled.
import { expect, test } from "bun:test";
import { guestParticipationRegistry } from "@pirate/contracts";
import { GuestAuthError } from "@pirate/contracts";
import { makeStaticHnsForwarderKeyRegistryV1 } from "@pirate/platform-cf/hns-forwarder-v3";
import { Effect } from "effect";
import { makeHnsCommunityAppApiComposition } from "./hns-community-app-api-composition.ts";
import { verifyHnsCommunityAppApiRequest } from "./hns-community-app-api-transport.ts";
import { createHttpWorker } from "./transport.ts";

test("guest OPTIONS middleware short-circuits and malformed/disabled paths stay private no-store", async () => {
  const worker = createHttpWorker({ config: { corsOrigin: "https://web.example" } });
  for (const endpoint of Object.values(guestParticipationRegistry)) {
    const path = endpoint.path.replace(/:[A-Za-z]+/gu, "fixture");
    const preflight = await worker.fetch(
      new Request(`https://api.example${path}`, {
        method: "OPTIONS",
        headers: {
          origin: "https://web.example",
          "access-control-request-method": endpoint.method,
        },
      }),
    );
    expect(preflight.headers.get("cache-control")).toBe("private, no-store");
    const unavailable = await worker.fetch(
      new Request(`https://api.example${path}`, { method: endpoint.method }),
    );
    expect(unavailable.status).toBe(404);
    expect(unavailable.headers.get("cache-control")).toBe("private, no-store");
    expect(unavailable.headers.has("set-cookie")).toBe(false);
  }
  const malformed = await worker.fetch(
    new Request("https://api.example/communities/a%2Fb/posts/post/study/guest/v1/sessions", {
      method: "POST",
    }),
  );
  expect(malformed.status).toBe(400);
  expect(malformed.headers.get("cache-control")).toBe("private, no-store");
});

test("HNS verified Access invokes refusal callback before body clone/hash and before forwarder authority lookup", async () => {
  let accessCalls = 0;
  let authorityCalls = 0;
  let callbacks = 0;
  let read = false;
  const composition = makeHnsCommunityAppApiComposition(true, {
    protected_origin: "https://hns-ingress.example",
    access_validator: {
      verify: async () => {
        accessCalls += 1;
      },
    },
    authority_source: {
      resolve: () => {
        authorityCalls += 1;
        return Effect.succeed(null);
      },
    },
    key_registry: makeStaticHnsForwarderKeyRegistryV1([
      {
        key_id: "fixture-key",
        key_bytes: new Uint8Array(32).fill(17),
        signing_enabled: true,
        verify_not_before: 0,
        verify_not_after: 10_000,
      },
    ]),
    replay_store: { consume: async () => false },
    clock: { nowUnixSeconds: () => 500 },
    limits: {
      max_body_bytes: 1_048_576,
      freshness_window_seconds: 300,
      future_clock_skew_seconds: 5,
    },
  });
  if (!composition.enabled) throw new Error("complete fixture composition absent");
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        read = true;
        controller.error(new Error("must remain unread"));
      },
    },
    { highWaterMark: 0 },
  );
  const request = new Request("https://hns-ingress.example/api/guest/bootstrap", {
    method: "POST",
    headers: { "cf-access-jwt-assertion": "fixture-assertion" },
    body,
    duplex: "half",
  });
  await expect(
    verifyHnsCommunityAppApiRequest(request, composition, async () => {
      callbacks += 1;
      throw new GuestAuthError({
        message: "Refused before body",
        details: { reason_code: "guest_origin_or_csrf_invalid" },
      });
    }),
  ).rejects.toBeInstanceOf(GuestAuthError);
  expect({ accessCalls, authorityCalls, callbacks, read }).toEqual({
    accessCalls: 1,
    authorityCalls: 0,
    callbacks: 1,
    read: false,
  });
});

test("disabled guest HNS routes refuse before Access/MAC verification or body clone", async () => {
  let accessCalls = 0;
  let replayCalls = 0;
  let authorityCalls = 0;
  const composition = makeHnsCommunityAppApiComposition(true, {
    protected_origin: "https://hns-ingress.example",
    access_validator: {
      verify: async () => {
        accessCalls += 1;
        throw new Error("must remain unused");
      },
    },
    authority_source: {
      resolve: () => {
        authorityCalls += 1;
        return Effect.succeed(null);
      },
    },
    key_registry: makeStaticHnsForwarderKeyRegistryV1([
      {
        key_id: "fixture-key",
        key_bytes: new Uint8Array(32).fill(17),
        signing_enabled: true,
        verify_not_before: 0,
        verify_not_after: 10_000,
      },
    ]),
    replay_store: {
      consume: async () => {
        replayCalls += 1;
        return false;
      },
    },
    clock: { nowUnixSeconds: () => 500 },
    limits: {
      max_body_bytes: 1_048_576,
      freshness_window_seconds: 300,
      future_clock_skew_seconds: 5,
    },
  });
  const worker = createHttpWorker({
    config: { corsOrigin: "https://web.example" },
    hnsCommunityAppApi: composition,
  });
  let read = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        read = true;
        controller.error(new Error("must remain unread"));
      },
    },
    { highWaterMark: 0 },
  );
  const response = await worker.fetch(
    new Request("https://hns-ingress.example/api/guest/bootstrap", {
      method: "POST",
      body,
      duplex: "half",
    }),
  );
  expect(response.status).toBe(404);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.has("set-cookie")).toBe(false);
  expect({ accessCalls, replayCalls, authorityCalls, read }).toEqual({
    accessCalls: 0,
    replayCalls: 0,
    authorityCalls: 0,
    read: false,
  });
});
