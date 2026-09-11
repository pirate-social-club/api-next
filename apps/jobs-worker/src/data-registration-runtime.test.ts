import { describe, expect, test } from "bun:test";
import { ControlPlaneDb, type ControlPlaneStatement } from "@pirate/application";
import type { DataRegistrationStore } from "@pirate/application/data/registration-persistence";
import {
  consumeDataRegistrationQueueMessage,
  type DataRegistrationWorkflowLauncher,
} from "@pirate/application/data/registration-workflow-queue";
import { Effect, Layer } from "effect";
import {
  type DataRegistrationWorkflowCandidate,
  listDataRegistrationSweepCandidates,
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

    expect(first).toEqual({
      inspected: 1,
      present: 0,
      replaced: 1,
      stale: 0,
      limitReached: 0,
      lookupFailed: 0,
    });
    expect(second).toEqual({
      inspected: 1,
      present: 0,
      replaced: 0,
      stale: 1,
      limitReached: 0,
      lookupFailed: 0,
    });
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
    expect(result).toEqual({
      inspected: 1,
      present: 1,
      replaced: 0,
      stale: 0,
      limitReached: 0,
      lookupFailed: 0,
    });
  });

  test("isolates a DATA status-lookup failure and continues", async () => {
    const failing = {
      ...candidate,
      registration_operation_id: "operation-failing",
      workflow_instance_id: "data-registration-workflow:operation-failing:r1",
    };
    const result = await recoverDataRegistrationWorkflowCandidates([failing, candidate], {
      store: {} as DataRegistrationStore,
      workflow: {
        get: async (instanceId: string) => {
          if (instanceId.includes("operation-failing")) throw new Error("workflow api down");
          return "present" as const;
        },
        create: async () => "already_exists" as const,
      },
    });
    expect(result).toEqual({
      inspected: 2,
      present: 1,
      replaced: 0,
      stale: 0,
      limitReached: 0,
      lookupFailed: 1,
    });
  });

  test("stops after three replacement revisions", async () => {
    let reads = 0;
    const result = await recoverDataRegistrationWorkflowCandidates(
      [{ ...candidate, workflow_revision: "4" }],
      {
        store: {} as DataRegistrationStore,
        workflow: {
          get: async () => {
            reads += 1;
            return "missing";
          },
          create: async () => "created",
        },
      },
    );
    expect(result).toEqual({
      inspected: 1,
      present: 0,
      replaced: 0,
      stale: 0,
      limitReached: 1,
      lookupFailed: 0,
    });
    expect(reads).toBe(0);
  });

  test("advances and wraps the DATA inspection cursor across ticks", async () => {
    const candidates = {
      a: {
        registration_operation_id: "operation-a",
        workflow_revision: "1",
        workflow_instance_id: "data-registration-workflow:operation-a:r1",
        launch_state: "delivered" as const,
        updated_at: "2026-01-01 00:00:00.000001+00",
      },
      b: {
        registration_operation_id: "operation-b",
        workflow_revision: "1",
        workflow_instance_id: "data-registration-workflow:operation-b:r1",
        launch_state: "delivered" as const,
        updated_at: "2026-01-01 00:00:00.000002+00",
      },
    };
    let cursor: { last_updated_at: string; last_identifier: string } | undefined;
    const statements: string[] = [];
    const runtime = Layer.succeed(ControlPlaneDb, {
      execute: (statement: ControlPlaneStatement) => {
        statements.push(statement.label);
        if (statement.label === "data-registration.workflow-cursor") {
          return Effect.succeed({
            rows: cursor === undefined ? [] : [{ ...cursor }],
            rowCount: cursor === undefined ? 0 : 1,
          });
        }
        if (statement.label === "data-registration.workflow.sweep-candidates") {
          const after = statement.values[0] as string | undefined;
          const rows =
            after === undefined
              ? [candidates.a]
              : after < candidates.b.updated_at
                ? [candidates.b]
                : [];
          return Effect.succeed({ rows, rowCount: rows.length });
        }
        if (statement.label === "data-registration.workflow-cursor.advance") {
          cursor = {
            last_updated_at: statement.values[0] as string,
            last_identifier: statement.values[1] as string,
          };
          return Effect.succeed({ rows: [], rowCount: 1 });
        }
        throw new Error(`unexpected statement ${statement.label}`);
      },
    } as unknown as ControlPlaneDb["Service"]);
    const first = await listDataRegistrationSweepCandidates(runtime);
    const second = await listDataRegistrationSweepCandidates(runtime);
    const third = await listDataRegistrationSweepCandidates(runtime);
    expect(first.map((entry) => entry.registration_operation_id)).toEqual(["operation-a"]);
    expect(second.map((entry) => entry.registration_operation_id)).toEqual(["operation-b"]);
    expect(third.map((entry) => entry.registration_operation_id)).toEqual(["operation-a"]);
    expect(
      statements.filter((label) => label === "data-registration.workflow-cursor.advance"),
    ).toHaveLength(3);
  });
});
