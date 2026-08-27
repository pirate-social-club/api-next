import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import { replaceLostDataRegistrationWorkflow } from "@pirate/application/data/registration-workflow-queue";
import {
  type CloudflareDataRegistrationWorkflowBinding,
  makeCloudflareDataRegistrationWorkflowLauncher,
} from "@pirate/platform-cf/data/registration-workflow-cloudflare";
import { makeDataRegistrationStore } from "@pirate/platform-cf/data-registration-repository";
import { Effect, type Layer } from "effect";

type DataRegistrationDispatchQueue = Readonly<{
  send: (message: Readonly<{ outbox_id: string }>) => Promise<void>;
}>;

export type DataRegistrationJobsBindings = Readonly<{
  DATA_REGISTRATION_ENABLED?: string;
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
}>;

type Candidate = Readonly<{
  registration_operation_id: string;
  workflow_revision: string;
  workflow_instance_id: string;
}>;

const workflowIsNeverMissingByThrownError = (): boolean => false;

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
          const result = yield* db.execute<Candidate>({
            label: "data-registration.workflow.sweep-candidates",
            text: `SELECT registration_operation_id,workflow_revision,workflow_instance_id
                     FROM data_registration_operations
                    WHERE state NOT IN ('registered','failed','reconciliation_required')
                      AND EXISTS (
                        SELECT 1 FROM data_registration_outbox launch
                         WHERE launch.registration_operation_id=
                               data_registration_operations.registration_operation_id
                           AND launch.workflow_revision=
                               data_registration_operations.workflow_revision
                           AND launch.state='delivered'
                      )
                    ORDER BY updated_at,registration_operation_id
                    LIMIT 25`,
            values: [],
            readonly: true,
          });
          return result.rows;
        }),
      ),
    );
    const counts = { inspected: 0, present: 0, replaced: 0, stale: 0 };
    for (const candidate of candidates) {
      counts.inspected += 1;
      const revision = BigInt(candidate.workflow_revision);
      if ((await workflow.get(candidate.workflow_instance_id)) === "present") {
        counts.present += 1;
        continue;
      }
      try {
        const outcome = await replaceLostDataRegistrationWorkflow(
          candidate.registration_operation_id,
          revision,
          { store, workflow },
        );
        if (outcome === "present") counts.present += 1;
        else counts.replaced += 1;
      } catch {
        counts.stale += 1;
      }
    }
    return Object.freeze({
      dispatched,
      dispatchFailed: outbox.length - dispatched,
      ...counts,
    });
  };
}
