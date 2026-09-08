import { Schema } from "effect";
import { reconciliationDigest } from "../packages/platform-cf/src/karaoke-reconciliation-evidence.ts";
import {
  decodeReconciliation,
  ReconciliationTime,
} from "../packages/platform-cf/src/karaoke-reconciliation-schema.ts";
import { makeKaraokeReleaseHttp } from "./staging-karaoke-release-http.ts";
import type {
  KaraokeReleasePlan,
  KaraokeReleaseSurfaces,
} from "./staging-karaoke-release-operation.ts";
import {
  collectStagingWorkerDeployments,
  type ReviewedWorkerVersion,
  STAGING_PRODUCER_WORKERS,
} from "./staging-persona-deployment-collector.ts";

const QUEUES = [
  "pirate-media-processing-staging",
  "pirate-data-registration-staging",
  "pirate-media-processing-staging-dlq",
  "pirate-data-registration-staging-dlq",
] as const;
const Id = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u));
const Uuid = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u),
);
const Queue = Schema.Struct({
  queue_id: Id,
  queue_name: Schema.String,
  settings: Schema.Struct({ delivery_paused: Schema.Boolean }),
});
const Deployment = Schema.Struct({
  id: Uuid,
  created_on: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  strategy: Schema.Literal("percentage"),
  versions: Schema.Array(
    Schema.Struct({ version_id: Uuid, percentage: Schema.Literal(100) }),
  ).check(Schema.isLengthBetween(1, 1)),
});
const Cron = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.isPattern(/^[^\p{Cc}]+$/u),
);
export const KaraokeReleasedSchedules = Schema.Array(
  Schema.Struct({
    worker: Schema.Literals(STAGING_PRODUCER_WORKERS),
    crons: Schema.Array(Cron).check(Schema.isMaxLength(100)),
  }),
).check(Schema.isLengthBetween(4, 4));
const Schedules = Schema.Struct({ schedules: Schema.Array(Schema.Struct({ cron: Cron })) });

/** Concrete staging-only transport. The plan fixes every identity before a
 * request. Provider mutation responses and two independent readbacks must
 * agree; a partial or unproven effect never produces a surface receipt. */
export function makeKaraokeProducerRelease(configuration: {
  readonly plan: KaraokeReleasePlan;
  readonly schedules: typeof KaraokeReleasedSchedules.Type;
  readonly accountId: string;
  readonly apiToken: string;
  readonly fetch?: typeof globalThis.fetch;
}) {
  const input = { ...configuration };
  const plan = structuredClone(input.plan);
  const schedulePins = Schema.decodeUnknownSync(KaraokeReleasedSchedules)(
    structuredClone(input.schedules),
  );
  if (
    plan.resumeQueues.length !== QUEUES.length ||
    new Set(plan.resumeQueues.map((q) => q.id)).size !== QUEUES.length ||
    new Set(plan.resumeQueues.map((q) => q.name)).size !== QUEUES.length ||
    plan.resumeQueues.some((q) => !QUEUES.includes(q.name as never) || !Schema.is(Id)(q.id)) ||
    plan.servingWorkers.length !== STAGING_PRODUCER_WORKERS.length ||
    new Set(plan.servingWorkers.map((w) => w.worker)).size !== STAGING_PRODUCER_WORKERS.length ||
    plan.servingWorkers.some(
      (w) => !STAGING_PRODUCER_WORKERS.includes(w.worker as never) || !Schema.is(Uuid)(w.versionId),
    ) ||
    new Set(schedulePins.map((pin) => pin.worker)).size !== 4 ||
    schedulePins.some((pin) => new Set(pin.crons).size !== pin.crons.length)
  )
    throw new Error("karaoke_release_producer_pins_incomplete");
  const http = makeKaraokeReleaseHttp(input);
  const versions = plan.servingWorkers as readonly ReviewedWorkerVersion[];
  const cronList = (value: unknown) =>
    Schema.decodeUnknownSync(Schedules)(value)
      .schedules.map((s) => s.cron)
      .sort();
  const schedules = async () => {
    const result = [];
    for (const pin of schedulePins)
      result.push({
        worker: pin.worker,
        crons: cronList(await http(`/workers/scripts/${pin.worker}/schedules`, "GET")),
      });
    return result;
  };
  const queues = async () => {
    const result = [];
    for (const pin of plan.resumeQueues) {
      const queue = Schema.decodeUnknownSync(Queue)(await http(`/queues/${pin.id}`, "GET"));
      if (queue.queue_id !== pin.id || queue.queue_name !== pin.name)
        throw new Error("karaoke_release_queue_identity_changed");
      result.push(queue);
    }
    return result;
  };
  const readback = async () => {
    const first = await queues();
    const firstSchedules = await schedules();
    const deployed = await collectStagingWorkerDeployments({
      ...input,
      reviewedVersions: versions,
    });
    const second = await queues();
    const secondSchedules = await schedules();
    if (
      JSON.stringify(first) !== JSON.stringify(second) ||
      JSON.stringify(firstSchedules) !== JSON.stringify(secondSchedules) ||
      secondSchedules.some(
        (observed, index) =>
          JSON.stringify(observed.crons) !==
          JSON.stringify([...(schedulePins[index]?.crons ?? [])].sort()),
      ) ||
      second.some((queue) => queue.settings.delivery_paused)
    )
      throw new Error("karaoke_release_producers_not_restored");
    return { queues: second, deployments: deployed.deployments, schedules: secondSchedules };
  };
  const execute: KaraokeReleaseSurfaces["producers"] = async (directive, now) => {
    if (
      JSON.stringify(directive) !==
      JSON.stringify({ resumeQueues: plan.resumeQueues, servingWorkers: plan.servingWorkers })
    )
      throw new Error("karaoke_release_producer_directive_changed");
    // Validate all queue identities before the first write. Restoring versions
    // precedes resuming deliveries, so a resumed queue cannot hit an old pin.
    if ((await queues()).some((queue) => !queue.settings.delivery_paused))
      throw new Error("karaoke_release_producers_not_fenced");
    if ((await schedules()).some((observed) => observed.crons.length !== 0))
      throw new Error("karaoke_release_schedules_not_fenced");
    const responses = [];
    for (const pin of versions) {
      const started = decodeReconciliation(ReconciliationTime, now());
      const response = Schema.decodeUnknownSync(Deployment)(
        await http(`/workers/scripts/${pin.worker}/deployments`, "POST", {
          strategy: "percentage",
          versions: [{ percentage: 100, version_id: pin.versionId }],
        }),
      );
      if (
        response.versions[0]?.version_id !== pin.versionId ||
        !Number.isFinite(Date.parse(response.created_on)) ||
        Date.parse(response.created_on) > Date.parse(now())
      )
        throw new Error("karaoke_release_deployment_unproven");
      responses.push({ worker: pin.worker, started, response });
    }
    for (const pin of plan.resumeQueues) {
      const response = Schema.decodeUnknownSync(Queue)(
        await http(`/queues/${pin.id}`, "PATCH", { settings: { delivery_paused: false } }),
      );
      if (
        response.queue_id !== pin.id ||
        response.queue_name !== pin.name ||
        response.settings.delivery_paused
      )
        throw new Error("karaoke_release_queue_response_unproven");
      responses.push({ queue: response });
    }
    // Triggers are independent of Worker versions. No schedule is inferred;
    // even intentionally empty released schedules must be explicitly pinned.
    for (const pin of schedulePins) {
      const response = cronList(
        await http(
          `/workers/scripts/${pin.worker}/schedules`,
          "PUT",
          pin.crons.map((cron) => ({ cron })),
        ),
      );
      if (JSON.stringify(response) !== JSON.stringify([...pin.crons].sort()))
        throw new Error("karaoke_release_schedule_response_unproven");
      responses.push({ schedules: { worker: pin.worker, crons: response } });
    }
    const observed = await readback();
    for (const response of responses) {
      if (
        "worker" in response &&
        !observed.deployments.some(
          (deployment) =>
            deployment.worker === response.worker &&
            deployment.deploymentId === response.response.id,
        )
      )
        throw new Error("karaoke_release_deployment_readback_changed");
    }
    const providerEvidence = JSON.stringify({ responses, observed });
    return {
      surface: "producers",
      releasedAt: now(),
      receipt: reconciliationDigest(providerEvidence),
      providerEvidence,
    };
  };
  return {
    execute,
    async observeRestored(): Promise<"restored" | "fenced" | "uncertain"> {
      try {
        await readback();
        return "restored";
      } catch {
        // Queue pause alone does not prove that the whole producer surface
        // (schedules, workflows and external producers) is fenced.
        return "uncertain";
      }
    },
  };
}
