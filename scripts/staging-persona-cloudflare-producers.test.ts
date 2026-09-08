import { expect, test } from "bun:test";
import {
  collectStagingCloudflareProducers,
  STAGING_FENCED_QUEUES,
} from "./staging-persona-cloudflare-producers.ts";
import { STAGING_PRODUCER_WORKERS } from "./staging-persona-deployment-collector.ts";

const workflows = [
  {
    name: "pirate-study-generation-staging",
    script_name: STAGING_PRODUCER_WORKERS[0],
    class_name: "StudyGenerationWorkflow",
  },
  {
    name: "pirate-media-processing-staging",
    script_name: STAGING_PRODUCER_WORKERS[2],
    class_name: "MediaProcessingWorkflow",
  },
  {
    name: "pirate-data-registration-staging",
    script_name: STAGING_PRODUCER_WORKERS[3],
    class_name: "DataRegistrationWorkflow",
  },
].map((value, index) => ({
  ...value,
  id: `${String(index).repeat(8)}-1111-4111-8111-111111111111`,
  schedules: [],
}));
const config = {
  accountId: "a".repeat(32),
  apiToken: "fixture-token",
  queues: STAGING_FENCED_QUEUES.map((name, index) => ({ name, id: String(index).repeat(32) })),
};
const page = (values: unknown[], number = 1, pages = 1, total = values.length) => ({
  success: true,
  result: values,
  result_info: { page: number, count: values.length, total_pages: pages, total_count: total },
});
function fixture(change?: (path: URL, body: Record<string, unknown>) => unknown) {
  let calls = 0;
  const fetcher = (async (raw, init) => {
    calls++;
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("manual");
    const url = new URL(String(raw));
    let body: Record<string, unknown>;
    const queue = config.queues.find((q) => url.pathname.endsWith(`/queues/${q.id}`));
    if (queue)
      body = {
        success: true,
        result: {
          queue_id: queue.id,
          queue_name: queue.name,
          settings: { delivery_paused: true },
          producers_total_count: 0,
          producers: [],
        },
      };
    else if (url.pathname.endsWith("/schedules"))
      body = { success: true, result: { schedules: [] } };
    else if (url.pathname.endsWith("/workflows")) body = page(workflows);
    else {
      const workflow = workflows.find((value) => url.pathname.includes(`/${value.name}/instances`));
      if (!workflow) throw new Error("unexpected-fixture-path");
      body = page([{ id: "retained-instance", status: "complete", workflow_id: workflow.id }]);
    }
    return Response.json(change?.(url, body) ?? body);
  }) as typeof fetch;
  return { fetcher, calls: () => calls };
}

test("reads every scoped queue, cron and workflow twice without making mutations", async () => {
  const f = fixture();
  const result = await collectStagingCloudflareProducers({ ...config, fetch: f.fetcher });
  expect(f.calls()).toBe(24);
  expect(result.workflows.length).toBe(3);
  expect(result.executionAuthorized).toBe(false);
  expect(JSON.stringify(result)).not.toContain(config.apiToken);
});

test("paused, queued and unknown instance states all fail closed", async () => {
  for (const status of [
    "paused",
    "queued",
    "running",
    "waiting",
    "waitingForPause",
    "rollingBack",
    "unknown",
  ]) {
    const f = fixture((url, body) =>
      url.pathname.endsWith("/instances")
        ? page([{ id: "instance", workflow_id: workflows[0]?.id, status }])
        : body,
    );
    await expect(
      collectStagingCloudflareProducers({ ...config, fetch: f.fetcher }),
    ).rejects.toThrow("producers_unproven");
  }
});

test("a nonterminal instance on a later page is not missed", async () => {
  const f = fixture((url, body) => {
    if (!url.pathname.endsWith("/instances")) return body;
    const number = Number(url.searchParams.get("page"));
    return page(
      [
        {
          id: `instance-${number}`,
          workflow_id: workflows[0]?.id,
          status: number === 1 ? "complete" : "running",
        },
      ],
      number,
      2,
      2,
    );
  });
  await expect(collectStagingCloudflareProducers({ ...config, fetch: f.fetcher })).rejects.toThrow(
    "producers_unproven",
  );
  expect(f.calls()).toBeGreaterThanOrEqual(11);
});

test("missing pagination, unreviewed workflows and active cron schedules refuse", async () => {
  for (const kind of ["pagination", "workflow", "cron", "queue"] as const) {
    const f = fixture((url, body) => {
      if (kind === "pagination" && url.pathname.endsWith("/workflows"))
        return { success: true, result: workflows };
      if (kind === "workflow" && url.pathname.endsWith("/workflows"))
        return page([
          ...workflows,
          { ...workflows[0], name: "unreviewed", id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
        ]);
      if (kind === "cron" && url.pathname.endsWith("/schedules"))
        return { success: true, result: { schedules: [{ cron: "* * * * *" }] } };
      if (kind === "queue" && url.pathname.includes("/queues/"))
        return {
          success: true,
          result: {
            ...(body.result as Record<string, unknown>),
            settings: { delivery_paused: false },
          },
        };
      return body;
    });
    await expect(
      collectStagingCloudflareProducers({ ...config, fetch: f.fetcher }),
    ).rejects.toThrow("producers_unproven");
  }
});
