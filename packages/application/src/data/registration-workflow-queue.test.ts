import { describe, expect, test } from "bun:test";
import type {
  DataRegistrationOperation,
  DataRegistrationOutbox,
  DataRegistrationStore,
} from "./registration-persistence";
import { deterministicDataRegistrationWorkflowId } from "./registration-persistence";
import {
  consumeDataRegistrationQueueMessage,
  type DataRegistrationWorkflowLauncher,
  replaceLostDataRegistrationWorkflow,
} from "./registration-workflow-queue";

const OPERATION_ID = "data-registration:1315:asset-1:1";
const WORKFLOW_ID = deterministicDataRegistrationWorkflowId(OPERATION_ID, 1n);

const operation = (): DataRegistrationOperation =>
  ({
    registrationOperationId: OPERATION_ID,
    workflowRevision: 1n,
    workflowInstanceId: WORKFLOW_ID,
  }) as DataRegistrationOperation;

const outbox = (overrides: Partial<DataRegistrationOutbox> = {}): DataRegistrationOutbox => ({
  outboxId: `${OPERATION_ID}:outbox:r1`,
  registrationOperationId: OPERATION_ID,
  workflowRevision: 1n,
  workflowInstanceId: WORKFLOW_ID,
  eventType: "registration_launch",
  effectIdentity: "effect-1",
  state: "pending",
  deliveryAttempts: 0,
  claimOwner: null,
  claimFence: 0n,
  leaseExpiresAt: null,
  nextEligibleAt: null,
  failureCode: null,
  ...overrides,
});

function harness(create: "created" | "already_exists" | "throw" = "created") {
  let current = outbox();
  let present = false;
  const calls: string[] = [];
  const store = {
    getOutbox: async () => current,
    getOperation: async () => operation(),
    claimOutbox: async (_id: string, workerId: string) => {
      calls.push("claim");
      current = {
        ...current,
        state: "running",
        deliveryAttempts: current.deliveryAttempts + 1,
        claimOwner: workerId,
        claimFence: current.claimFence + 1n,
      };
      return current;
    },
    completeOutbox: async () => {
      calls.push("complete");
      current = { ...current, state: "delivered", claimOwner: null };
      return true;
    },
    failOutbox: async () => {
      calls.push("fail");
      current = { ...current, state: "failed", claimOwner: null };
      return true;
    },
    replaceMissingWorkflow: async () => {
      calls.push("replace");
      return { operation: operation(), outbox: current };
    },
  } as unknown as DataRegistrationStore;
  const workflow: DataRegistrationWorkflowLauncher = {
    get: async () => {
      calls.push("get");
      return present ? "present" : "missing";
    },
    create: async () => {
      calls.push("create");
      if (create === "throw") throw new Error("unavailable");
      present = true;
      return create;
    },
  };
  return { calls, store, workflow, current: () => current };
}

describe("DATA registration Queue and recovery", () => {
  test("accepts only an outbox id and converges deterministic create", async () => {
    const state = harness();
    expect(
      await consumeDataRegistrationQueueMessage(
        { outbox_id: outbox().outboxId },
        { store: state.store, workflow: state.workflow, workerId: "worker-1", leaseSeconds: 60 },
      ),
    ).toEqual({ disposition: "ack" });
    expect(state.calls).toEqual(["claim", "get", "create", "complete"]);
    expect(state.current().state).toBe("delivered");

    expect(
      await consumeDataRegistrationQueueMessage(
        { outbox_id: outbox().outboxId, transaction: "hostile" },
        { store: state.store, workflow: state.workflow, workerId: "worker-1", leaseSeconds: 60 },
      ),
    ).toEqual({ disposition: "dlq" });
  });

  test("persists launch failure before retry", async () => {
    const state = harness("throw");
    expect(
      await consumeDataRegistrationQueueMessage(
        { outbox_id: outbox().outboxId },
        { store: state.store, workflow: state.workflow, workerId: "worker-1", leaseSeconds: 60 },
      ),
    ).toEqual({ disposition: "retry", delaySeconds: 15 });
    expect(state.calls.at(-1)).toBe("fail");
  });

  test("increments the persisted revision before replacement launch", async () => {
    const state = harness();
    expect(
      await replaceLostDataRegistrationWorkflow(OPERATION_ID, 1n, {
        store: state.store,
        workflow: state.workflow,
      }),
    ).toBe("replacement_enqueued");
    expect(state.calls).toEqual(["get", "replace"]);
  });
});
