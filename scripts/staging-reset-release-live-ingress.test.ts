import { expect, test } from "bun:test";
import {
  ACCOUNT,
  type AccessFenceState,
  accessFenceFetch,
  WORKER_DESTINATION,
} from "./staging-reset-release-live-refence-fixture.ts";

const { makeLiveIngressRefence } = await import("./staging-reset-release-ingress-refence.ts");

test("the production ingress reversal creates the reviewed fence, proves it and is idempotent", async () => {
  const state: AccessFenceState = {
    apps: [],
    policies: [],
    creates: 0,
    policyCreates: 0,
    probeStatus: 403,
  };
  const refence = makeLiveIngressRefence({
    accountId: ACCOUNT,
    apiToken: "token",
    fetch: accessFenceFetch(state),
  });
  // With the forward surface not yet run the fence exists; with a fixture that
  // omits it the binding is still constructible. Both are read-only here.
  await expect(refence.assertAvailable()).resolves.toBeUndefined();
  await refence.run();
  expect(state.creates).toBe(1);
  expect(state.policyCreates).toBe(1);
  expect(state.apps[0]?.destinations).toEqual([WORKER_DESTINATION]);
  expect(state.policies[0]).toMatchObject({ decision: "deny", include: [{ everyone: {} }] });
  await refence.run();
  expect(state.creates).toBe(1);
  expect(state.policyCreates).toBe(1);
});

test("the production ingress reversal refuses an ambiguous or foreign worker application", async () => {
  const fenceApp = { id: "f".repeat(32), type: "self_hosted", destinations: [WORKER_DESTINATION] };
  const ambiguous: AccessFenceState = {
    apps: [fenceApp, { ...fenceApp, id: "e".repeat(32) }],
    policies: [],
    creates: 0,
    policyCreates: 0,
    probeStatus: 403,
  };
  await expect(
    makeLiveIngressRefence({
      accountId: ACCOUNT,
      apiToken: "token",
      fetch: accessFenceFetch(ambiguous),
    }).assertAvailable(),
  ).rejects.toThrow("staging_live_ingress_refence_unproven");
  const foreign: AccessFenceState = {
    apps: [fenceApp],
    policies: [{ id: "a".repeat(32), decision: "allow", include: [{ everyone: {} }] }],
    creates: 0,
    policyCreates: 0,
    probeStatus: 403,
  };
  await expect(
    makeLiveIngressRefence({
      accountId: ACCOUNT,
      apiToken: "token",
      fetch: accessFenceFetch(foreign),
    }).assertAvailable(),
  ).rejects.toThrow("staging_live_ingress_refence_unproven");
});

test("the production ingress reversal refuses until both hosts answer the block", async () => {
  const state: AccessFenceState = {
    apps: [],
    policies: [],
    creates: 0,
    policyCreates: 0,
    probeStatus: 404,
  };
  await expect(
    makeLiveIngressRefence({
      accountId: ACCOUNT,
      apiToken: "token",
      fetch: accessFenceFetch(state),
    }).run(),
  ).rejects.toThrow("staging_live_ingress_refence_unproven");
  expect(state.policyCreates).toBe(1);
});

test("a correctly shaped fence created without its policy is completed idempotently", async () => {
  const state: AccessFenceState = {
    apps: [
      {
        id: "f".repeat(32),
        type: "self_hosted",
        destinations: [WORKER_DESTINATION],
      },
    ],
    policies: [],
    creates: 0,
    policyCreates: 0,
    probeStatus: 403,
  };
  const refence = makeLiveIngressRefence({
    accountId: ACCOUNT,
    apiToken: "token",
    fetch: accessFenceFetch(state),
  });
  await refence.run();
  expect(state.creates).toBe(0);
  expect(state.policyCreates).toBe(1);
  await refence.run();
  expect(state.creates).toBe(0);
  expect(state.policyCreates).toBe(1);
});

test("a malformed existing worker application is refused before any policy write", async () => {
  // The independent reproduction: the staging Worker plus an unrelated Worker,
  // no policies. The previous implementation wrote the deny policy first and
  // rejected the shape afterwards.
  const state: AccessFenceState = {
    apps: [
      {
        id: "f".repeat(32),
        type: "self_hosted",
        destinations: [WORKER_DESTINATION, { type: "worker", worker_id: "unrelated-worker" }],
      },
    ],
    policies: [],
    creates: 0,
    policyCreates: 0,
    probeStatus: 403,
  };
  await expect(
    makeLiveIngressRefence({
      accountId: ACCOUNT,
      apiToken: "token",
      fetch: accessFenceFetch(state),
    }).run(),
  ).rejects.toThrow("staging_live_ingress_refence_unproven");
  expect(state.creates).toBe(0);
  expect(state.policyCreates).toBe(0);
});

test("a created application that does not match the reviewed target is refused before its policy write", async () => {
  const state: AccessFenceState = {
    apps: [],
    policies: [],
    creates: 0,
    policyCreates: 0,
    probeStatus: 403,
    extraDestinationOnCreate: true,
  };
  await expect(
    makeLiveIngressRefence({
      accountId: ACCOUNT,
      apiToken: "token",
      fetch: accessFenceFetch(state),
    }).run(),
  ).rejects.toThrow("staging_live_ingress_refence_unproven");
  expect(state.creates).toBe(1);
  expect(state.policyCreates).toBe(0);
});

test("a stalled host probe aborts with a named timeout instead of hanging", async () => {
  const state: AccessFenceState = {
    apps: [],
    policies: [],
    creates: 0,
    policyCreates: 0,
    probeStatus: 403,
  };
  const base = accessFenceFetch(state);
  const stalled = (async (raw: string | URL | Request, init?: RequestInit) => {
    const url = String(raw);
    if (
      url.startsWith("https://api-next-staging.pirate.sc/") ||
      url.startsWith("https://pirate-http-worker-staging.")
    )
      return await new Promise<Response>(() => {});
    return base(raw as never, init as never);
  }) as unknown as typeof globalThis.fetch;
  const refence = makeLiveIngressRefence({
    accountId: ACCOUNT,
    apiToken: "token",
    fetch: stalled,
    probeTimeoutMs: 25,
  });
  const started = Date.now();
  await expect(refence.run()).rejects.toThrow("staging_live_ingress_probe_timeout");
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(state.policyCreates).toBe(1);
});
