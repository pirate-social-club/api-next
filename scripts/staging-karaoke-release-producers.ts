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

/** Concrete staging-only transports. The plan fixes every identity before a
 * request. Provider mutation responses and two independent readbacks must
 * agree; a partial or unproven effect never produces a surface receipt.
 *
 * Serving versions and delivery resumption are deliberately separate surfaces.
 * A deployed pair has to be accepted through the product before background
 * writers act on it, and one call that deployed and resumed together made that
 * ordering impossible to express.
 */
function makeProducerTransport(configuration: {
  readonly plan: KaraokeReleasePlan;
  readonly accountId: string;
  readonly apiToken: string;
  readonly fetch?: typeof globalThis.fetch;
}) {
  const input = { ...configuration };
  const plan = structuredClone(input.plan);
  if (
    plan.resumeQueues.length !== QUEUES.length ||
    new Set(plan.resumeQueues.map((q) => q.id)).size !== QUEUES.length ||
    new Set(plan.resumeQueues.map((q) => q.name)).size !== QUEUES.length ||
    plan.resumeQueues.some((q) => !QUEUES.includes(q.name as never) || !Schema.is(Id)(q.id)) ||
    plan.servingWorkers.length !== STAGING_PRODUCER_WORKERS.length ||
    new Set(plan.servingWorkers.map((w) => w.worker)).size !== STAGING_PRODUCER_WORKERS.length ||
    plan.servingWorkers.some(
      (w) => !STAGING_PRODUCER_WORKERS.includes(w.worker as never) || !Schema.is(Uuid)(w.versionId),
    )
  )
    throw new Error("karaoke_release_producer_pins_incomplete");
  const http = makeKaraokeReleaseHttp(input);
  const versions = plan.servingWorkers as readonly ReviewedWorkerVersion[];
  const cronList = (value: unknown) =>
    Schema.decodeUnknownSync(Schedules)(value)
      .schedules.map((s) => s.cron)
      .sort();
  const workerSchedules = async () => {
    const result = [];
    for (const worker of STAGING_PRODUCER_WORKERS)
      result.push({
        worker,
        crons: cronList(await http(`/workers/scripts/${worker}/schedules`, "GET")),
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
  const deployments = async () =>
    (await collectStagingWorkerDeployments({ ...input, reviewedVersions: versions })).deployments;
  /** The producer fence, as the collector defines it: every queue paused and
   * no producer Worker holding a schedule. Deploying a version must not lift
   * it, and resuming must not begin without it. */
  const assertProducersFenced = async () => {
    if ((await queues()).some((queue) => !queue.settings.delivery_paused))
      throw new Error("karaoke_release_producers_not_fenced");
    if ((await workerSchedules()).some((observed) => observed.crons.length !== 0))
      throw new Error("karaoke_release_schedules_not_fenced");
  };
  return {
    input,
    plan,
    http,
    versions,
    cronList,
    workerSchedules,
    queues,
    deployments,
    assertProducersFenced,
  };
}

/** Restores the reviewed serving versions and nothing else. The producer fence
 * stays held across this surface: queues remain paused and no schedule is
 * restored, so the deployed pair can be verified before anything acts on it. */
export function makeKaraokeVersionRelease(configuration: {
  readonly plan: KaraokeReleasePlan;
  readonly accountId: string;
  readonly apiToken: string;
  readonly fetch?: typeof globalThis.fetch;
}) {
  const { plan, http, versions, queues, workerSchedules, deployments, assertProducersFenced } =
    makeProducerTransport(configuration);
  const readback = async () => {
    const first = await deployments();
    const fencedQueues = await queues();
    const fencedSchedules = await workerSchedules();
    const second = await deployments();
    if (
      JSON.stringify(first) !== JSON.stringify(second) ||
      fencedQueues.some((queue) => !queue.settings.delivery_paused) ||
      fencedSchedules.some((observed) => observed.crons.length !== 0)
    )
      throw new Error("karaoke_release_versions_not_restored");
    return { deployments: second, queues: fencedQueues, schedules: fencedSchedules };
  };
  const execute: KaraokeReleaseSurfaces["versions"] = async (directive, now) => {
    if (JSON.stringify(directive) !== JSON.stringify({ servingWorkers: plan.servingWorkers }))
      throw new Error("karaoke_release_producer_directive_changed");
    await assertProducersFenced();
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
    const observed = await readback();
    for (const response of responses)
      if (
        !observed.deployments.some(
          (deployment) =>
            deployment.worker === response.worker &&
            deployment.deploymentId === response.response.id,
        )
      )
        throw new Error("karaoke_release_deployment_readback_changed");
    const providerEvidence = JSON.stringify({ responses, observed });
    return {
      surface: "versions",
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
        return "uncertain";
      }
    },
  };
}

/** Resumes delivery and restores schedules, and only that. It refuses unless
 * the reviewed versions are already serving, so resumption cannot precede the
 * deployment whose acceptance authorised it. */
export function makeKaraokeProducerRelease(configuration: {
  readonly plan: KaraokeReleasePlan;
  readonly schedules: unknown;
  readonly accountId: string;
  readonly apiToken: string;
  readonly fetch?: typeof globalThis.fetch;
}) {
  const { plan, http, cronList, workerSchedules, queues, deployments, assertProducersFenced } =
    makeProducerTransport(configuration);
  const schedulePins = Schema.decodeUnknownSync(KaraokeReleasedSchedules)(
    structuredClone(configuration.schedules),
  );
  if (
    new Set(schedulePins.map((pin) => pin.worker)).size !== 4 ||
    schedulePins.some((pin) => new Set(pin.crons).size !== pin.crons.length)
  )
    throw new Error("karaoke_release_producer_pins_incomplete");
  const pinnedCrons = (worker: string) =>
    [...(schedulePins.find((pin) => pin.worker === worker)?.crons ?? [])].sort();
  const assertVersionsServing = async () => {
    const observed = await deployments();
    if (
      plan.servingWorkers.some(
        (pin) => !observed.some((deployment) => deployment.worker === pin.worker),
      )
    )
      throw new Error("karaoke_release_versions_not_serving");
    return observed;
  };
  const readback = async () => {
    const first = await queues();
    const firstSchedules = await workerSchedules();
    const deployed = await assertVersionsServing();
    const second = await queues();
    const secondSchedules = await workerSchedules();
    if (
      JSON.stringify(first) !== JSON.stringify(second) ||
      JSON.stringify(firstSchedules) !== JSON.stringify(secondSchedules) ||
      secondSchedules.some(
        (observed) =>
          JSON.stringify(observed.crons) !== JSON.stringify(pinnedCrons(observed.worker)),
      ) ||
      second.some((queue) => queue.settings.delivery_paused)
    )
      throw new Error("karaoke_release_producers_not_restored");
    return { queues: second, deployments: deployed, schedules: secondSchedules };
  };
  const execute: KaraokeReleaseSurfaces["producers"] = async (directive, now) => {
    if (JSON.stringify(directive) !== JSON.stringify({ resumeQueues: plan.resumeQueues }))
      throw new Error("karaoke_release_producer_directive_changed");
    // Versions first, then the fence check: resuming into an unverified pair is
    // the failure this split exists to prevent.
    await assertVersionsServing();
    await assertProducersFenced();
    const responses = [];
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
