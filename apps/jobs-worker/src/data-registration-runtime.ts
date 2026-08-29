import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import { replaceLostDataRegistrationWorkflow } from "@pirate/application/data/registration-workflow-queue";
import {
  type CloudflareDataRegistrationWorkflowBinding,
  makeCloudflareDataRegistrationWorkflowLauncher,
} from "@pirate/platform-cf/data/registration-workflow-cloudflare";
import { makeDataRegistrationStore } from "@pirate/platform-cf/data-registration-repository";
import { Effect, type Layer } from "effect";
import { songWorkflowReplacementLimitReached } from "./song-workflow-recovery-policy";

type DataRegistrationDispatchQueue = Readonly<{
  send: (message: Readonly<{ outbox_id: string }>) => Promise<void>;
}>;

export type DataRegistrationJobsBindings = Readonly<{
  DATA_REGISTRATION_ENABLED?: string;
  DATA_REGISTRATION_RPC_URL?: string;
  DATA_REGISTRATION_SIGNER_ADDRESS?: string;
  DATA_REGISTRATION_NATIVE_BALANCE_FLOOR_WEI?: string;
  DATA_REGISTRATION_QUEUE?: DataRegistrationDispatchQueue;
  DATA_REGISTRATION_WORKFLOW?: CloudflareDataRegistrationWorkflowBinding;
}>;

export type DataRegistrationMaintenanceResult = Readonly<{
  dispatched: number;
  dispatchFailed: number;
  inspected: number;
  present: number;
  replaced: number;
  stale: number;
  limitReached: number;
}>;

export type DataRegistrationWorkflowCandidate = Readonly<{
  registration_operation_id: string;
  workflow_revision: string;
  workflow_instance_id: string;
  launch_state: "delivered" | "exhausted";
}>;

const workflowIsNeverMissingByThrownError = (): boolean => false;

export async function recoverDataRegistrationWorkflowCandidates(
  candidates: readonly DataRegistrationWorkflowCandidate[],
  dependencies: Readonly<{
    store: ReturnType<typeof makeDataRegistrationStore>;
    workflow: ReturnType<typeof makeCloudflareDataRegistrationWorkflowLauncher>;
  }>,
): Promise<
  Pick<
    DataRegistrationMaintenanceResult,
    "inspected" | "present" | "replaced" | "stale" | "limitReached"
  >
> {
  const counts = { inspected: 0, present: 0, replaced: 0, stale: 0, limitReached: 0 };
  for (const candidate of candidates) {
    counts.inspected += 1;
    const revision = BigInt(candidate.workflow_revision);
    if (songWorkflowReplacementLimitReached(revision)) {
      counts.limitReached += 1;
      continue;
    }
    if ((await dependencies.workflow.get(candidate.workflow_instance_id)) === "present") {
      counts.present += 1;
      continue;
    }
    try {
      const outcome = await replaceLostDataRegistrationWorkflow(
        candidate.registration_operation_id,
        revision,
        dependencies,
      );
      if (outcome === "present") counts.present += 1;
      else counts.replaced += 1;
    } catch {
      counts.stale += 1;
    }
  }
  return counts;
}

export function makeDataRegistrationMaintenance(
  env: DataRegistrationJobsBindings,
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): (() => Promise<DataRegistrationMaintenanceResult>) | null {
  if (env.DATA_REGISTRATION_ENABLED !== "true") return null;
  if (env.DATA_REGISTRATION_QUEUE === undefined || env.DATA_REGISTRATION_WORKFLOW === undefined) {
    throw new Error("DATA registration Queue and Workflow bindings are required when enabled");
  }
  const queue = env.DATA_REGISTRATION_QUEUE;
  const workflow = makeCloudflareDataRegistrationWorkflowLauncher(
    env.DATA_REGISTRATION_WORKFLOW,
    workflowIsNeverMissingByThrownError,
  );
  const store = makeDataRegistrationStore(runtime);

  return async () => {
    const outbox = await store.listEligibleOutbox(25);
    const deliveries = await Promise.allSettled(
      outbox.map((record) => queue.send({ outbox_id: record.outboxId })),
    );
    const dispatched = deliveries.filter((result) => result.status === "fulfilled").length;
    const candidates = await Effect.runPromise(
      Effect.provide(runtime)(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          const result = yield* db.execute<DataRegistrationWorkflowCandidate>({
            label: "data-registration.workflow.sweep-candidates",
            text: `SELECT operation.registration_operation_id,operation.workflow_revision,
                          operation.workflow_instance_id,launch.state AS launch_state
                     FROM data_registration_operations operation
                     JOIN data_registration_outbox launch
                       ON launch.registration_operation_id=operation.registration_operation_id
                      AND launch.workflow_revision=operation.workflow_revision
                    WHERE operation.state NOT IN ('registered','failed','reconciliation_required')
                      AND launch.state IN ('delivered','exhausted')
                    ORDER BY operation.updated_at,operation.registration_operation_id
                    LIMIT 25`,
            values: [],
            readonly: true,
          });
          return result.rows;
        }),
      ),
    );
    const counts = await recoverDataRegistrationWorkflowCandidates(candidates, { store, workflow });
    return Object.freeze({
      dispatched,
      dispatchFailed: outbox.length - dispatched,
      ...counts,
    });
  };
}
