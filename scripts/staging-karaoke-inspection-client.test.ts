import { expect, test } from "bun:test";
import {
  KARAOKE_RESET_INVENTORY_DIGEST,
  KARAOKE_RESET_OBJECT_IDS,
} from "../packages/platform-cf/src/karaoke-reset-installation.ts";
import { inspectStagingKaraokeObject } from "./staging-karaoke-inspection-client.ts";

const target = {
  namespaceId: "d692b9d32ecc4cb4825510bde88cf97a" as const,
  objectId: KARAOKE_RESET_OBJECT_IDS[0],
  generation: "staging-reset-v1" as const,
  inventoryDigest: KARAOKE_RESET_INVENTORY_DIGEST,
};
const observation = {
  alarm: null,
  sockets: 0,
  scoreState: null,
  recordingState: null,
  archiveKey: null,
  uploadId: null,
};
const snapshot = {
  version: "staging-karaoke-reset-inspection-v1",
  ...target,
  observedAt: "2026-09-07T00:00:00.000Z",
  markerState: "active",
  initial: observation,
  current: observation,
  authority: null,
  installationReceipt: {
    ...target,
    state: "active",
    initial: observation,
    current: observation,
    cancellationSucceeded: true,
    quiescenceEstablished: false,
  },
};
const input = {
  origin: "https://reset.example.test",
  assertion: "fixture.header.signature",
  target,
  now: () => Date.parse(snapshot.observedAt),
};
const transport = (respond: (request: Request) => Response | Promise<Response>): typeof fetch =>
  Object.assign(
    async (url: string | URL | Request, options?: RequestInit) =>
      respond(new Request(url, options)),
    { preconnect() {} },
  );

test("inspects only the frozen target through Access cookie and preserves false quiescence", async () => {
  let calls = 0;
  const result = await inspectStagingKaraokeObject({
    ...input,
    fetch: transport(async (request) => {
      calls++;
      expect(request.url).toBe(`${input.origin}/inspect`);
      expect(request.method).toBe("POST");
      expect(request.redirect).toBe("manual");
      expect(request.headers.get("cookie")).toBe(`CF_Authorization=${input.assertion}`);
      expect(request.headers.has("cf-access-jwt-assertion")).toBe(false);
      expect(await request.json()).toEqual(target);
      return Response.json(snapshot);
    }),
  });
  expect(calls).toBe(1);
  expect(result.installationReceipt?.quiescenceEstablished).toBe(false);
});

test("refuses redirects, malformed or stale observations and mismatched targets without retry", async () => {
  for (const response of [
    new Response(null, { status: 302, headers: { location: "https://elsewhere.test" } }),
    new Response(null, { status: 403 }),
    new Response("not-json", { headers: { "content-type": "application/json" } }),
    Response.json({ ...snapshot, extra: true }),
    Response.json({ ...snapshot, objectId: KARAOKE_RESET_OBJECT_IDS[1] }),
    Response.json({ ...snapshot, observedAt: "2026-09-06T23:59:59.999Z" }),
    Response.json({ ...snapshot, observedAt: "2026-09-07T00:00:00.001Z" }),
    Response.json({ padding: "x".repeat(33_000) }),
  ]) {
    let calls = 0;
    await expect(
      inspectStagingKaraokeObject({
        ...input,
        fetch: transport(() => {
          calls++;
          return response;
        }),
      }),
    ).rejects.toThrow("karaoke_inspection_failed");
    expect(calls).toBe(1);
  }
});

test("rejects unsafe origins and cookie injection before network", async () => {
  let calls = 0;
  for (const change of [
    { origin: "http://reset.example.test" },
    { origin: "https://reset.example.test:8443" },
    { origin: "https://reset.example.test/?secret=value" },
    { assertion: "a.b.c; other=value" },
  ]) {
    await expect(
      inspectStagingKaraokeObject({
        ...input,
        ...change,
        fetch: transport(() => {
          calls++;
          return Response.json(snapshot);
        }),
      }),
    ).rejects.toThrow();
  }
  expect(calls).toBe(0);
});

test("bounds a stalled transport and redacts its errors", async () => {
  await expect(
    inspectStagingKaraokeObject({
      ...input,
      fetch: transport(() => {
        throw new Error(input.assertion);
      }),
    }),
  ).rejects.toThrow("karaoke_inspection_failed");
  const started = Date.now();
  await expect(
    inspectStagingKaraokeObject({
      ...input,
      fetch: transport(() => new Promise<Response>(() => {})),
    }),
  ).rejects.toThrow("karaoke_inspection_failed");
  expect(Date.now() - started).toBeLessThan(6_500);
}, 10_000);
