import { expect, test } from "bun:test";
import { isolatedWorkers, loadIsolatedWorkerPlan, planIsolatedWorker } from "./worker-plan.mjs";

const identity = {
  hyperdriveId: "04a1c805805d42d6bfc67ae7b005ec93",
  databaseHost: "aws-us-east-1-3.pg.psdb.cloud",
  attestationId: "megapot-e2e-sepolia-20261004-r2",
};
const sources = Object.fromEntries(
  await Promise.all(
    ["http", "jobs"].map(async (kind) => [
      kind,
      Bun.JSONC.parse(await Bun.file(`apps/${kind}-worker/wrangler.jsonc`).text()),
    ]),
  ),
);

test("current Worker bindings are isolated with admission disabled", async () => {
  const plans = await loadIsolatedWorkerPlan(process.cwd(), identity);
  for (const kind of ["http", "jobs"] as const) {
    const plan = plans[kind];
    expect(plan.name).toBe(isolatedWorkers[kind]);
    expect(plan.hyperdrive).toEqual([{ binding: "CONTROL_PLANE", id: identity.hyperdriveId }]);
    expect(plan.vars.MEGAPOT_REWARDS_ENABLED).toBe("false");
    expect(plan.services).toEqual([]);
    expect(plan.workflows).toEqual([]);
    expect(plan.queues).toEqual({ producers: [], consumers: [] });
    expect(
      plan.r2_buckets.every((binding: { bucket_name: string }) =>
        binding.bucket_name.includes("e2e"),
      ),
    ).toBe(true);
    expect(
      plan.durable_objects.bindings.every(
        (binding: { script_name?: string }) =>
          !binding.script_name || binding.script_name === isolatedWorkers.http,
      ),
    ).toBe(true);
  }
  expect(plans.http.routes[0].pattern).toBe("api-megapot-e2e-staging.pirate.sc");
  expect(plans.jobs.routes).toEqual([]);
  expect(plans.jobs.vars.MEGAPOT_COMMITMENT_PUBLIC_ORIGIN).toBe(
    "https://pub-48f50b887be54c92b4f8d7896ff1ece9.r2.dev",
  );
  expect(plans.jobs.secrets.required).not.toContain("MEGAPOT_COMMITMENT_PUBLIC_ORIGIN");
});

test("production, shared staging, retired and malformed database targets refuse", () => {
  for (const hyperdriveId of [
    "884b68c5a7904982a86620ed90032b77",
    "8cb7658a0f7143359c1becfec6a15c23",
    "cf1afd643ad7469fba79694ccac74df3",
    "bad",
  ]) {
    expect(() => planIsolatedWorker(sources.http, "http", { ...identity, hyperdriveId })).toThrow(
      "identity refused",
    );
  }
});

test("new writable storage and Durable Object targets require review", () => {
  for (const key of [
    "d1_databases",
    "kv_namespaces",
    "dispatch_namespaces",
    "analytics_engine_datasets",
    "unsafe",
  ]) {
    const source = structuredClone(sources.http);
    source.env.staging[key] = [];
    expect(() => planIsolatedWorker(source, "http", identity)).toThrow(
      "Unreviewed external binding",
    );
  }
  const bucket = structuredClone(sources.http);
  bucket.env.staging.r2_buckets.push({ binding: "UNKNOWN", bucket_name: "shared" });
  expect(() => planIsolatedWorker(bucket, "http", identity)).toThrow("Unreviewed R2 binding");
  const durable = structuredClone(sources.jobs);
  durable.env.staging.durable_objects.bindings.push({ name: "UNKNOWN", script_name: "shared" });
  expect(() => planIsolatedWorker(durable, "jobs", identity)).toThrow(
    "Unreviewed Durable Object target",
  );
});

test("planning leaves the published source configuration unchanged", () => {
  const before = JSON.stringify(sources.http);
  planIsolatedWorker(sources.http, "http", identity);
  expect(JSON.stringify(sources.http)).toBe(before);
});
