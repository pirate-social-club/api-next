import { Schema } from "effect";
import { STAGING_PRODUCER_WORKERS } from "./staging-persona-deployment-collector.ts";
import { readBoundedProviderJson } from "./staging-provider-response.ts";

export const STAGING_FENCED_QUEUES = [
  "pirate-media-processing-staging",
  "pirate-data-registration-staging",
  "pirate-media-processing-staging-dlq",
  "pirate-data-registration-staging-dlq",
] as const;
const WorkflowNames = [
  "pirate-study-generation-staging",
  "pirate-media-processing-staging",
  "pirate-data-registration-staging",
  "pirate-video-analysis-staging",
] as const;
const WorkflowBindings = [
  ["pirate-http-worker-staging", "StudyGenerationWorkflow"],
  ["pirate-media-processor-worker-staging", "MediaProcessingWorkflow"],
  ["pirate-data-registration-worker-staging", "DataRegistrationWorkflow"],
  ["pirate-media-processor-worker-staging", "VideoAnalysisWorkflow"],
] as const;
const Id = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u));
const UUID = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u),
);
const Name = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,100}$/u));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Envelope = Schema.Struct({ success: Schema.Literal(true), result: Schema.Unknown });
const Page = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Array(Schema.Unknown),
  result_info: Schema.Struct({ page: Count, total_pages: Count, total_count: Count, count: Count }),
});
const Queue = Schema.Struct({
  queue_id: Id,
  queue_name: Schema.Literals(STAGING_FENCED_QUEUES),
  settings: Schema.Struct({ delivery_paused: Schema.Literal(true) }),
  producers_total_count: Count,
  producers: Schema.Array(
    Schema.Struct({
      type: Schema.Literal("worker"),
      script: Schema.Literals(STAGING_PRODUCER_WORKERS),
    }),
  ),
});
const Workflow = Schema.Struct({
  id: UUID,
  name: Name,
  script_name: Name,
  class_name: Name,
  schedules: Schema.Array(Schema.Unknown),
});
const Instance = Schema.Struct({
  id: Name,
  workflow_id: UUID,
  status: Schema.Literals(["complete", "errored", "terminated"]),
});
const Schedules = Schema.Struct({ schedules: Schema.Array(Schema.Unknown) });
const decode = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
): S["Type"] => Schema.decodeUnknownSync(schema)(value);

/** Read-only snapshot of Cloudflare controls. Does not stop services, drain a DO,
 * cancel an external provider effect, or establish the complete producer fence.
 */
export async function collectStagingCloudflareProducers(input: {
  readonly accountId: string;
  readonly apiToken: string;
  readonly queues: readonly {
    readonly name: (typeof STAGING_FENCED_QUEUES)[number];
    readonly id: string;
  }[];
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
}) {
  decode(Id, input.accountId);
  if (
    !input.apiToken ||
    input.queues.length !== 4 ||
    new Set(input.queues.map((q) => q.id)).size !== 4 ||
    [...input.queues.map((q) => q.name)].sort().join() !== [...STAGING_FENCED_QUEUES].sort().join()
  )
    throw new Error("producer_configuration_denied");
  for (const queue of input.queues) decode(Id, queue.id);
  const queuePins = input.queues.map((pin) => ({ ...pin }));
  const controller = new AbortController();
  const now = input.now ?? Date.now;
  const started = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const transport = input.fetch ?? globalThis.fetch;
  try {
    return await Promise.race([
      (async () => {
        const get = async (path: string) => {
          controller.signal.throwIfAborted();
          const response = await transport(
            `https://api.cloudflare.com/client/v4/accounts/${input.accountId}/${path}`,
            {
              method: "GET",
              redirect: "manual",
              signal: controller.signal,
              headers: { authorization: `Bearer ${input.apiToken}`, accept: "application/json" },
            },
          );
          return readBoundedProviderJson(response, 1_048_576);
        };
        const list = async (path: string) => {
          const values: unknown[] = [];
          let pages: number | undefined;
          let count: number | undefined;
          for (let page = 1; page <= 40; page++) {
            const current = decode(Page, await get(`${path}?page=${page}&per_page=100`));
            const info = current.result_info;
            if (
              info.page !== page ||
              info.count !== current.result.length ||
              info.total_pages > 40 ||
              (pages !== undefined && info.total_pages !== pages) ||
              (count !== undefined && info.total_count !== count)
            )
              throw new Error("producer_pagination_changed");
            pages = info.total_pages;
            count = info.total_count;
            values.push(...current.result);
            if (page === Math.max(1, pages)) {
              if (values.length !== count || (pages === 0 && count !== 0))
                throw new Error("producer_inventory_incomplete");
              return values;
            }
          }
          throw new Error("producer_inventory_limit");
        };
        const scan = async () => {
          const queues = [];
          for (const pin of [...queuePins].sort((a, b) => a.name.localeCompare(b.name))) {
            const queue = decode(Queue, decode(Envelope, await get(`queues/${pin.id}`)).result);
            if (
              queue.queue_id !== pin.id ||
              queue.queue_name !== pin.name ||
              queue.producers_total_count !== queue.producers.length
            )
              throw new Error("producer_queue_mismatch");
            queues.push({
              ...queue,
              producers: [...queue.producers].sort((a, b) => a.script.localeCompare(b.script)),
            });
          }
          const schedules = [];
          for (const script of STAGING_PRODUCER_WORKERS) {
            const observed = decode(
              Schedules,
              decode(Envelope, await get(`workers/scripts/${script}/schedules`)).result,
            );
            if (observed.schedules.length !== 0) throw new Error("producer_cron_active");
            schedules.push({ script, crons: [] });
          }
          const all = (await list("workflows")).map((value) => decode(Workflow, value));
          if (
            new Set(all.map((value) => value.id)).size !== all.length ||
            new Set(all.map((value) => value.name)).size !== all.length
          )
            throw new Error("producer_workflow_duplicates");
          const selected = all.filter((value) =>
            STAGING_PRODUCER_WORKERS.some((script) => script === value.script_name),
          );
          if (
            !WorkflowNames.slice(0, 3).every((name) =>
              selected.some((value) => value.name === name),
            ) ||
            selected.some(
              (value) =>
                !WorkflowNames.some(
                  (name, index) =>
                    name === value.name &&
                    WorkflowBindings[index]?.[0] === value.script_name &&
                    WorkflowBindings[index]?.[1] === value.class_name,
                ) || value.schedules.length !== 0,
            )
          )
            throw new Error("producer_workflow_scope_unproven");
          const workflows = [];
          for (const workflow of selected.sort((a, b) => a.name.localeCompare(b.name))) {
            const instances = (await list(`workflows/${workflow.name}/instances`)).map((value) =>
              decode(Instance, value),
            );
            if (
              instances.some((value) => value.workflow_id !== workflow.id) ||
              new Set(instances.map((value) => value.id)).size !== instances.length
            )
              throw new Error("producer_instance_scope_unproven");
            workflows.push({
              ...workflow,
              instances: instances.sort((a, b) => a.id.localeCompare(b.id)),
            });
          }
          return { queues, schedules, workflows };
        };
        const first = await scan();
        const second = await scan();
        const ended = now();
        if (
          JSON.stringify(first) !== JSON.stringify(second) ||
          ended < started ||
          ended - started > 20_000
        )
          throw new Error("producer_snapshot_changed");
        return {
          ...second,
          verifiedAt: new Date(ended).toISOString(),
          executionAuthorized: false as const,
        };
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("producer_snapshot_timeout"));
        }, 20_000);
      }),
    ]);
  } catch {
    throw new Error("staging_cloudflare_producers_unproven");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}
