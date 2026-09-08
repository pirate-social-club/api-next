import { expect, test } from "bun:test";
import {
  normalizeIngressProbe,
  planPersistentIngressFence,
  STAGING_API_SOURCE_SHA,
  STAGING_HTTP_CUSTOM_DOMAIN,
  STAGING_HTTP_WORKER_ID,
  STAGING_HTTP_WORKERS_DEV,
  STAGING_SOLID_SOURCE_SHA,
  verifyPersistentIngressFence,
} from "./staging-persona-ingress-fence";

const pins = { api: STAGING_API_SOURCE_SHA, solid: STAGING_SOLID_SOURCE_SHA } as const;
const workerPolicy = {
  id: "access-worker-policy",
  kind: "worker" as const,
  workerId: STAGING_HTTP_WORKER_ID,
  hostnames: [],
  paths: [],
  action: "deny" as const,
  enabled: true,
};

test("plans a persistent Worker-level policy without replacing specific applications", () => {
  expect(
    planPersistentIngressFence({
      workerId: STAGING_HTTP_WORKER_ID,
      existingApplications: [],
      runtimePins: pins,
    }),
  ).toMatchObject({ action: "create-worker-policy", survivesNormalDeploy: true });
  expect(
    planPersistentIngressFence({
      workerId: STAGING_HTTP_WORKER_ID,
      existingApplications: [workerPolicy],
      runtimePins: pins,
    }),
  ).toMatchObject({
    action: "verify-existing-worker-policy",
    existingApplicationId: workerPolicy.id,
  });
});

test("requires the exact Worker, both release pins, and no more-specific allow override", () => {
  expect(() =>
    planPersistentIngressFence({ workerId: "other", existingApplications: [], runtimePins: pins }),
  ).toThrow("worker_unproven");
  expect(() =>
    planPersistentIngressFence({
      workerId: STAGING_HTTP_WORKER_ID,
      existingApplications: [],
      runtimePins: { api: "0".repeat(40), solid: STAGING_SOLID_SOURCE_SHA },
    }),
  ).toThrow("runtime_pins_unproven");
  expect(() =>
    planPersistentIngressFence({
      workerId: STAGING_HTTP_WORKER_ID,
      existingApplications: [
        {
          ...workerPolicy,
          kind: "hostname",
          workerId: STAGING_HTTP_WORKER_ID,
          hostnames: [STAGING_HTTP_CUSTOM_DOMAIN],
          action: "allow",
        },
      ],
      runtimePins: pins,
    }),
  ).toThrow("specific_override");
  expect(() =>
    planPersistentIngressFence({
      workerId: STAGING_HTTP_WORKER_ID,
      existingApplications: [workerPolicy, { ...workerPolicy, id: "second" }],
      runtimePins: pins,
    }),
  ).toThrow("worker_policy_ambiguous");
});

test("classifies only Access denial responses as denied", () => {
  expect(normalizeIngressProbe({ host: STAGING_HTTP_CUSTOM_DOMAIN, status: 403 })).toMatchObject({
    denied: true,
  });
  expect(
    normalizeIngressProbe({
      host: STAGING_HTTP_WORKERS_DEV,
      status: 302,
      location: "https://example.cloudflareaccess.com/cdn-cgi/access/login?x=1",
    }).denied,
  ).toBe(true);
  expect(
    normalizeIngressProbe({ host: STAGING_HTTP_CUSTOM_DOMAIN, status: 302, location: "/login" })
      .denied,
  ).toBe(false);
  expect(normalizeIngressProbe({ host: STAGING_HTTP_CUSTOM_DOMAIN, status: 503 }).denied).toBe(
    false,
  );
});

test("requires both custom-domain and workers.dev denial after both reviewed runtime pins", () => {
  const base = {
    workerId: STAGING_HTTP_WORKER_ID,
    customDomain: STAGING_HTTP_CUSTOM_DOMAIN,
    workersDevHostname: STAGING_HTTP_WORKERS_DEV,
    previewIngressEnabled: false,
    workerLevelApplication: workerPolicy,
    moreSpecificApplications: [],
    deploymentPins: pins,
    probes: [
      normalizeIngressProbe({
        host: STAGING_HTTP_CUSTOM_DOMAIN,
        status: 403,
        accessApplicationId: workerPolicy.id,
      }),
      normalizeIngressProbe({
        host: STAGING_HTTP_WORKERS_DEV,
        status: 403,
        accessApplicationId: workerPolicy.id,
      }),
    ],
  } as const;
  expect(verifyPersistentIngressFence(base, workerPolicy.id)).toMatchObject({
    ingressDenied: true,
    survivesNormalDeploy: true,
  });
  for (const change of [
    { probes: base.probes.slice(0, 1) },
    {
      probes: base.probes.map((probe, index) =>
        index === 1 ? { ...probe, denied: false } : probe,
      ),
    },
    { deploymentPins: { ...pins, api: "0".repeat(40) } },
    { workerLevelApplication: { ...workerPolicy, id: "replaced" } },
  ]) {
    expect(() => verifyPersistentIngressFence({ ...base, ...change }, workerPolicy.id)).toThrow();
  }
});
