import { expect, test } from "bun:test";
import { Schema } from "effect";
import { reconciliationDigest } from "../packages/platform-cf/src/karaoke-reconciliation-evidence.ts";
import { validateKaraokeReleaseConfiguration } from "./staging-karaoke-release-config.ts";
import { makeKaraokeReleaseHttp } from "./staging-karaoke-release-http.ts";
import {
  karaokeAccessConfigurationDigest,
  makeKaraokeIngressRelease,
} from "./staging-karaoke-release-ingress.ts";
import { KaraokeReleasePlan } from "./staging-karaoke-release-operation.ts";
import { makeKaraokeProducerRelease } from "./staging-karaoke-release-producers.ts";
import { STAGING_PRODUCER_WORKERS } from "./staging-persona-deployment-collector.ts";

const accountId = "08a4c22cf52e2ecae883e36f80a33f4a";
const names = [
  "pirate-media-processing-staging",
  "pirate-data-registration-staging",
  "pirate-media-processing-staging-dlq",
  "pirate-data-registration-staging-dlq",
];
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const plan: KaraokeReleasePlan = {
  version: "staging-karaoke-release-plan-v1",
  ingressApplicationId: "a".repeat(32),
  resumeQueues: names.map((name, index) => ({ name, id: String(index + 1).repeat(32) })),
  servingWorkers: STAGING_PRODUCER_WORKERS.map((worker, index) => ({
    worker,
    versionId: uuid(index + 1),
  })),
  reviewedGrantDigest: "d".repeat(64),
  surfaceOrder: ["database", "producers", "ingress"],
};
const now = () => new Date().toISOString();
const schedules = STAGING_PRODUCER_WORKERS.map((worker) => ({ worker, crons: ["*/5 * * * *"] }));

function producerFixture() {
  const state = {
    writes: [] as string[],
    paused: new Set(plan.resumeQueues.map((q) => q.id)),
    lost: false,
    stale: false,
    wrongQueue: false,
    schedules: new Map<string, { cron: string }[]>(),
    staleSchedules: false,
  };
  const fetch = (async (raw: string | URL | Request, init?: RequestInit) => {
    const url = String(raw);
    expect(url.startsWith(`https://api.cloudflare.com/client/v4/accounts/${accountId}/`)).toBe(
      true,
    );
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture");
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      state.writes.push(url);
      if (state.lost) throw new Error("lost response secret must not propagate");
    }
    const queue = plan.resumeQueues.find((q) => url.endsWith(`/queues/${q.id}`));
    let result: unknown;
    if (url.endsWith("/schedules")) {
      if (method === "PUT") state.schedules.set(url, JSON.parse(String(init?.body)));
      result = {
        schedules: state.staleSchedules && method === "GET" ? [] : (state.schedules.get(url) ?? []),
      };
    } else if (queue) {
      if (method === "PATCH") {
        expect(JSON.parse(String(init?.body))).toEqual({ settings: { delivery_paused: false } });
        state.paused.delete(queue.id);
      }
      result = {
        queue_id: queue.id,
        queue_name: state.wrongQueue ? "foreign" : queue.name,
        settings: { delivery_paused: state.paused.has(queue.id) },
      };
    } else {
      const worker = plan.servingWorkers.find((w) =>
        url.endsWith(`/workers/scripts/${w.worker}/deployments`),
      );
      if (!worker) throw new Error("unexpected fixture route");
      const deployment = {
        id: uuid(90),
        created_on: "2026-09-01T00:00:00.000001Z",
        strategy: "percentage",
        versions: [
          {
            version_id: state.stale && method === "GET" ? uuid(99) : worker.versionId,
            percentage: 100,
          },
        ],
      };
      result = method === "GET" ? { deployments: [deployment] } : deployment;
    }
    return Response.json({ success: true, result });
  }) as typeof globalThis.fetch;
  const producer = makeKaraokeProducerRelease({
    plan,
    schedules,
    accountId,
    apiToken: "fixture",
    fetch,
  });
  const directive = { resumeQueues: plan.resumeQueues, servingWorkers: plan.servingWorkers };
  return { state, producer, directive };
}

test("producer release proves deployment IDs and queue readbacks and retains provider evidence", async () => {
  const f = producerFixture();
  const receipt = await f.producer.execute(f.directive, now);
  expect(f.state.writes).toHaveLength(12);
  expect(f.state.writes.slice(0, 4).every((url) => url.endsWith("/deployments"))).toBe(true);
  expect(receipt.receipt).toBe(reconciliationDigest(receipt.providerEvidence ?? ""));
  expect(await f.producer.observeRestored()).toBe("restored");
});

test("a provider acknowledgement with stale deployed versions produces no receipt", async () => {
  const f = producerFixture();
  f.state.stale = true;
  await expect(f.producer.execute(f.directive, now)).rejects.toThrow();
  expect(await f.producer.observeRestored()).toBe("uncertain");
});

test("a schedule acknowledgement without matching readback never completes the producer surface", async () => {
  const f = producerFixture();
  f.state.staleSchedules = true;
  await expect(f.producer.execute(f.directive, now)).rejects.toThrow("producers_not_restored");
  expect(await f.producer.observeRestored()).toBe("uncertain");
  expect(f.state.writes.filter((url) => url.endsWith("/schedules"))).toHaveLength(4);
});

test("incomplete reviewed schedule identities refuse before any provider call", () => {
  let calls = 0;
  expect(() =>
    makeKaraokeProducerRelease({
      plan,
      accountId,
      apiToken: "fixture",
      schedules: [],
      fetch: (async () => {
        calls++;
        throw new Error();
      }) as unknown as typeof globalThis.fetch,
    }),
  ).toThrow();
  expect(calls).toBe(0);
});

test("wrong queue identity refuses before any producer write", async () => {
  const f = producerFixture();
  f.state.wrongQueue = true;
  await expect(f.producer.execute(f.directive, now)).rejects.toThrow("identity_changed");
  expect(f.state.writes).toHaveLength(0);
});

test("lost provider response is redacted and never retried", async () => {
  const f = producerFixture();
  f.state.lost = true;
  await expect(f.producer.execute(f.directive, now)).rejects.toThrow("provider_response_unproven");
  expect(f.state.writes).toHaveLength(1);
});

test("foreign producer pins refuse at construction", () => {
  expect(() =>
    makeKaraokeProducerRelease({
      plan: { ...plan, servingWorkers: [] },
      schedules,
      accountId,
      apiToken: "fixture",
    }),
  ).toThrow("pins_incomplete");
});

test("provider transport rejects redirects without forwarding the token", async () => {
  let calls = 0;
  const fetch = (async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: "https://example.invalid" } });
  }) as unknown as typeof globalThis.fetch;
  const http = makeKaraokeReleaseHttp({ accountId, apiToken: "fixture", fetch });
  await expect(http(`/queues/${"a".repeat(32)}`, "PATCH", {})).rejects.toThrow("response_unproven");
  expect(calls).toBe(1);
});

test("complete restoration directives are bound into the plan digest", () => {
  const restoration = {
    ingress: { kind: "remove-fence-application", remainingApplicationsDigest: "b".repeat(64) },
    database: { targetBindingDigest: "c".repeat(64), restoreRuntimeConnect: true },
    producers: { schedules },
  };
  const boundPlan = Schema.decodeUnknownSync(KaraokeReleasePlan)({
    ...plan,
    restorationDigest: reconciliationDigest(JSON.stringify(restoration)),
  });
  const config = {
    version: "staging-karaoke-live-release-v1",
    plan: boundPlan,
    approvedPlanDigest: reconciliationDigest(JSON.stringify(boundPlan)),
    restoration,
  };
  expect(validateKaraokeReleaseConfiguration(config).plan.surfaceOrder).toEqual([
    "database",
    "producers",
    "ingress",
  ]);
  restoration.ingress.remainingApplicationsDigest = "e".repeat(64);
  expect(() => validateKaraokeReleaseConfiguration(config)).toThrow("approved_plan_changed");
});

function ingressFixture() {
  const applicationId = plan.ingressApplicationId;
  const app = {
    id: applicationId,
    type: "self_hosted",
    destinations: [{ type: "worker", worker_id: "7ada21fbaf794466bae2eda487299555" }],
  };
  const restored = {
    id: "b".repeat(32),
    name: "fixture",
    decision: "bypass",
    include: [{ everyone: {} }],
    exclude: [],
    require: [],
  };
  const state = {
    writes: 0,
    policy: { ...restored, decision: "deny" },
    stale: false,
    failed: false,
  };
  const fetch = (async (raw: string | URL | Request, init?: RequestInit) => {
    if (state.failed) throw new Error("transport unavailable");
    const url = String(raw);
    if (!url.startsWith("https://api.cloudflare.com/")) return new Response(null, { status: 403 });
    if (init?.method === "PUT") {
      state.writes++;
      state.policy = restored;
      return Response.json({ success: true, result: restored });
    }
    const result = url.includes("/policies")
      ? [{ ...state.policy, ...(state.stale && state.writes > 0 ? { decision: "deny" } : {}) }]
      : url.includes("?page=")
        ? [app]
        : app;
    return Response.json({ success: true, result, result_info: { page: 1, total_pages: 1 } });
  }) as typeof globalThis.fetch;
  const ingress = makeKaraokeIngressRelease({
    applicationId,
    accountId,
    apiToken: "fixture",
    fetch,
    restoration: {
      kind: "restore-policy",
      policyId: restored.id,
      applicationDigest: karaokeAccessConfigurationDigest(app),
      policyBody: restored,
      restoredPolicyDigest: karaokeAccessConfigurationDigest(restored),
    },
  });
  return { ingress, state, directive: { applicationId } };
}

test("ingress restores the reviewed policy and independently reads it twice", async () => {
  const f = ingressFixture();
  const receipt = await f.ingress.execute(f.directive, now);
  expect(f.state.writes).toBe(1);
  expect(receipt.surface).toBe("ingress");
  expect(await f.ingress.observeRestored()).toBe("restored");
});

test("ingress success response cannot substitute for changed readback", async () => {
  const f = ingressFixture();
  f.state.stale = true;
  await expect(f.ingress.execute(f.directive, now)).rejects.toThrow("policy_changed");
  expect(await f.ingress.observeRestored()).toBe("uncertain");
  expect(f.state.writes).toBe(1);
});

test("failed ingress transport never claims restored", async () => {
  const f = ingressFixture();
  f.state.failed = true;
  expect(await f.ingress.observeRestored()).toBe("uncertain");
  expect(f.state.writes).toBe(0);
});

test("explicit removal deletes only the reviewed fence app and verifies complete remaining inventory", async () => {
  const applicationId = plan.ingressApplicationId;
  const app = {
    id: applicationId,
    type: "self_hosted",
    destinations: [{ type: "worker", worker_id: "7ada21fbaf794466bae2eda487299555" }],
  };
  let present = true;
  let writes = 0;
  const fetch = (async (raw: string | URL | Request, init?: RequestInit) => {
    const url = String(raw);
    if (!url.startsWith("https://api.cloudflare.com/")) return new Response(null, { status: 403 });
    if (init?.method === "DELETE") {
      expect(url.endsWith(`/access/apps/${applicationId}`)).toBe(true);
      writes++;
      present = false;
      return Response.json({ success: true, result: { id: applicationId } });
    }
    const result = url.includes("/policies")
      ? [{ id: "b".repeat(32), decision: "deny", include: [{ everyone: {} }] }]
      : present
        ? [app]
        : [];
    return Response.json({ success: true, result, result_info: { page: 1, total_pages: 1 } });
  }) as typeof globalThis.fetch;
  const ingress = makeKaraokeIngressRelease({
    accountId,
    apiToken: "fixture",
    applicationId,
    fetch,
    restoration: {
      kind: "remove-fence-application",
      remainingApplicationsDigest: karaokeAccessConfigurationDigest([]),
    },
  });
  expect((await ingress.execute({ applicationId }, now)).surface).toBe("ingress");
  expect(writes).toBe(1);
  expect(await ingress.observeRestored()).toBe("restored");
  await expect(ingress.execute({ applicationId }, now)).rejects.toThrow();
  expect(writes).toBe(1);
});

test("configuration digest never drops nested policy fields", () => {
  expect(
    karaokeAccessConfigurationDigest({
      id: "fixture",
      created_at: "old",
      include: [{ created_at: "a" }],
    }),
  ).toBe(
    karaokeAccessConfigurationDigest({
      id: "fixture",
      created_at: "new",
      include: [{ created_at: "a" }],
    }),
  );
  expect(
    karaokeAccessConfigurationDigest({ id: "fixture", include: [{ created_at: "a" }] }),
  ).not.toBe(karaokeAccessConfigurationDigest({ id: "fixture", include: [{ created_at: "b" }] }));
});
