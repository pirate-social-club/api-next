import { expect, test } from "bun:test";
import {
  collectStagingWorkerDeployments,
  STAGING_PRODUCER_WORKERS,
} from "./staging-persona-deployment-collector.ts";

const versionId = "11111111-1111-4111-8111-111111111111";
const deploymentId = "22222222-2222-4222-8222-222222222222";
const now = Date.parse("2026-09-07T08:00:00Z");
const config = {
  accountId: "a".repeat(32),
  apiToken: "fixture-private-token",
  reviewedVersions: STAGING_PRODUCER_WORKERS.map((worker) => ({ worker, versionId })),
  now: () => now,
};
const deployment = () => ({
  id: deploymentId,
  created_on: "2026-09-07T07:00:00Z",
  strategy: "percentage",
  versions: [{ percentage: 100, version_id: versionId }],
});
const envelope = (deployments: unknown[] = [deployment()]) => ({
  success: true,
  result: { deployments },
});
const transport = (read: (index: number, init?: RequestInit) => Response) => {
  let calls = 0;
  return ((_: unknown, init?: RequestInit) => Promise.resolve(read(calls++, init))) as typeof fetch;
};

test("observes all four reviewed versions twice without claiming producer fencing", async () => {
  let calls = 0;
  const result = await collectStagingWorkerDeployments({
    ...config,
    fetch: transport((_, init) => {
      calls++;
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("manual");
      return Response.json(envelope());
    }),
  });
  expect(calls).toBe(8);
  expect(result.deployments.map((value) => value.worker)).toEqual([...STAGING_PRODUCER_WORKERS]);
  expect(result.executionAuthorized).toBe(false);
  expect("producers" in result).toBe(false);
  expect(JSON.stringify(result)).not.toContain(config.apiToken);
});

test("rejects incomplete or duplicate reviewed pins before transport", async () => {
  for (const pins of [
    config.reviewedVersions.slice(1),
    config.reviewedVersions.map(() => ({ worker: STAGING_PRODUCER_WORKERS[0], versionId })),
  ]) {
    let calls = 0;
    await expect(
      collectStagingWorkerDeployments({
        ...config,
        reviewedVersions: pins,
        fetch: transport(() => {
          calls++;
          return Response.json(envelope());
        }),
      }),
    ).rejects.toThrow("pins_incomplete");
    expect(calls).toBe(0);
  }
});

test("rejects old matching history, partial rollout, malformed and future deployment", async () => {
  const bad = [
    [{ ...deployment(), versions: [{ percentage: 100, version_id: deploymentId }] }, deployment()],
    [{ ...deployment(), versions: [{ percentage: 99, version_id: versionId }] }],
    [{ ...deployment(), versions: [...deployment().versions, ...deployment().versions] }],
    [{ ...deployment(), created_on: "2026-09-08T07:00:00Z" }],
    [{ ...deployment(), id: "not-a-deployment" }],
    [],
  ];
  for (const entries of bad) {
    await expect(
      collectStagingWorkerDeployments({
        ...config,
        fetch: transport(() => Response.json(envelope(entries))),
      }),
    ).rejects.toThrow("observation_failed");
  }
});

test("rejects deployment replacement between scans even with the same version", async () => {
  await expect(
    collectStagingWorkerDeployments({
      ...config,
      fetch: transport((index) =>
        Response.json(envelope([{ ...deployment(), id: index < 4 ? deploymentId : versionId }])),
      ),
    }),
  ).rejects.toThrow("observation_failed");
});

test("rejects redirects and oversized responses and redacts transport errors", async () => {
  for (const response of [new Response(null, { status: 302 }), new Response("x".repeat(262_145))]) {
    await expect(
      collectStagingWorkerDeployments({ ...config, fetch: transport(() => response) }),
    ).rejects.toThrow("staging_deployment_observation_failed");
  }
  await expect(
    collectStagingWorkerDeployments({
      ...config,
      fetch: (() => {
        throw new Error(config.apiToken);
      }) as typeof fetch,
    }),
  ).rejects.toThrow(/^staging_deployment_observation_failed$/u);
});

test("bounds an unresponsive transport even when it ignores abort", async () => {
  let signal: AbortSignal | null | undefined;
  await expect(
    collectStagingWorkerDeployments({
      ...config,
      fetch: ((_: unknown, init?: RequestInit) => {
        signal = init?.signal;
        return new Promise<Response>(() => undefined);
      }) as typeof fetch,
    }),
  ).rejects.toThrow("staging_deployment_observation_failed");
  expect(signal?.aborted).toBe(true);
}, 20_000);

test("cancels a rejected response body", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }),
    { status: 302 },
  );
  await expect(
    collectStagingWorkerDeployments({ ...config, fetch: transport(() => response) }),
  ).rejects.toThrow("staging_deployment_observation_failed");
  expect(cancelled).toBe(true);
});
