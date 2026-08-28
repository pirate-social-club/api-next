import { describe, expect, test } from "bun:test";
import type { DataRegistrationStore } from "@pirate/application/data/registration-persistence";
import {
  consumeDataRegistrationQueueMessage,
  type DataRegistrationWorkflowLauncher,
} from "@pirate/application/data/registration-workflow-queue";
import {
  type DataRegistrationWorkflowCandidate,
  recoverDataRegistrationWorkflowCandidates,
} from "./data-registration-runtime";

const candidate: DataRegistrationWorkflowCandidate = {
  registration_operation_id: "operation-1",
  workflow_revision: "1",
  workflow_instance_id: "data-registration-workflow:operation-1:r1",
  launch_state: "exhausted",
};

describe("DATA registration scheduled recovery", () => {
  test("replaces one exhausted current launch and converges concurrent sweeps", async () => {
    let revision = 1n;
    let replacements = 0;
    let replacementState = "pending" as "pending" | "running" | "delivered";
    const replacementOutboxId = "operation-1:outbox:r2";
    const store = {
      getOperation: async () => ({
        registrationOperationId: "operation-1",
        workflowRevision: revision,
        workflowInstanceId: `data-registration-workflow:operation-1:r${revision}`,
      }),
      replaceMissingWorkflow: async (_operationId: string, expectedRevision: bigint) => {
        if (revision === expectedRevision) {
          revision += 1n;
          replacements += 1;
        }
        return {
          operation: { workflowRevision: revision },
          outbox: { state: replacementState, workflowRevision: revision },
        };
      },
      getOutbox: async (outboxId: string) =>
        outboxId === replacementOutboxId
          ? {
              outboxId,
              registrationOperationId: "operation-1",
              workflowRevision: 2n,
              workflowInstanceId: "data-registration-workflow:operation-1:r2",
              eventType: "workflow_replacement",
              effectIdentity: "operation-1:replacement:r2",
              state: replacementState,
              deliveryAttempts: 0,
              claimOwner: null,
              claimFence: 0n,
              leaseExpiresAt: null,
              nextEligibleAt: null,
              failureCode: null,
            }
          : null,
      claimOutbox: async () => {
        replacementState = "running";
        return {
          ...(await store.getOutbox(replacementOutboxId)),
          state: "running",
          deliveryAttempts: 1,
          claimOwner: "worker-1",
          claimFence: 1n,
        };
      },
      completeOutbox: async () => {
        replacementState = "delivered";
        return true;
      },
    } as unknown as DataRegistrationStore;
    let creates = 0;
    const workflow = {
      get: async () => "missing" as const,
      create: async () => {
        creates += 1;
        return "created" as const;
      },
    } satisfies DataRegistrationWorkflowLauncher;

    const first = await recoverDataRegistrationWorkflowCandidates([candidate], {
      store,
      workflow,
    });
    const second = await recoverDataRegistrationWorkflowCandidates([candidate], {
      store,
      workflow,
    });

    expect(first).toEqual({ inspected: 1, present: 0, replaced: 1, stale: 0 });
    expect(second).toEqual({ inspected: 1, present: 0, replaced: 0, stale: 1 });
    expect(replacements).toBe(1);

    expect(
      await consumeDataRegistrationQueueMessage(
        { outbox_id: replacementOutboxId },
        { store, workflow, workerId: "worker-1", leaseSeconds: 60 },
      ),
    ).toEqual({ disposition: "ack" });
    expect(replacementState).toBe("delivered");
    expect(creates).toBe(1);
  });

  test("suppresses present launch candidates", async () => {
    const result = await recoverDataRegistrationWorkflowCandidates([candidate], {
      store: {} as DataRegistrationStore,
      workflow: {
        get: async () => "present",
        create: async () => "already_exists",
      },
    });
    expect(result).toEqual({ inspected: 1, present: 1, replaced: 0, stale: 0 });
  });
});
