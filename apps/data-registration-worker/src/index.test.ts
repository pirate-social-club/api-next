import { describe, expect, test } from "bun:test";
import type { DataRegistrationWorkflowDependencies } from "../../../packages/application/src/data/registration-workflow.ts";
import type { DataRegistrationQueueDependencies } from "../../../packages/application/src/data/registration-workflow-queue.ts";
import {
  type DataRegistrationWorkflowStep,
  makeDataRegistrationQueueWorker,
  makeDataRegistrationWorkflowRunner,
} from "./index.ts";

describe("DATA registration Worker posture", () => {
  test("resolves provider composition inside the durable step", async () => {
    const compositionError = new Error("signer secret unavailable");
    let insideStep = false;
    const runner = makeDataRegistrationWorkflowRunner(() => {
      expect(insideStep).toBe(true);
      throw compositionError;
    });
    const step = {
      do: async <T>(_name: string, _options: unknown, callback: () => Promise<T>) => {
        insideStep = true;
        try {
          return await callback();
        } finally {
          insideStep = false;
        }
      },
      sleep: async () => {
        throw new Error("composition failure must not poll");
      },
    } as DataRegistrationWorkflowStep;

    await expect(
      runner(
        {},
        {
          instanceId: "workflow-1",
          payload: {
            outboxId: "outbox-1",
            registrationOperationId: "operation-1",
            workflowRevision: 1n,
          },
        },
        step,
      ),
    ).rejects.toBe(compositionError);
  });

  test("runs identifier-only work inside a durable step while disabled", async () => {
    const stepNames: string[] = [];
    const workflow = {
      options: { enabled: true },
    } as DataRegistrationWorkflowDependencies;
    const runner = makeDataRegistrationWorkflowRunner(() => ({
      queue: {} as DataRegistrationQueueDependencies,
      workflow,
    }));
    const step = {
      do: async <T>(name: string, _options: unknown, callback: () => Promise<T>) => {
        stepNames.push(name);
        return callback();
      },
      sleep: async () => {
        throw new Error("an inert Workflow must not poll");
      },
    } as DataRegistrationWorkflowStep;

    expect(
      await runner(
        {},
        {
          instanceId: "workflow-1",
          payload: {
            outboxId: "outbox-1",
            registrationOperationId: "operation-1",
            workflowRevision: 1n,
          },
        },
        step,
      ),
    ).toEqual({ outcome: "inert" });
    expect(stepNames).toEqual(["data-registration-0"]);
  });

  test("retains queued identities without resolving secrets while disabled", async () => {
    let resolved = false;
    let retriedWith: unknown;
    const worker = makeDataRegistrationQueueWorker(() => {
      resolved = true;
      throw new Error("disabled queue must not compose provider adapters");
    });
    await worker.queue(
      {
        messages: [
          {
            body: { outbox_id: "outbox-1" },
            ack: () => {
              throw new Error("disabled queue must not acknowledge authority");
            },
            retry: (options) => {
              retriedWith = options;
            },
          },
        ],
      },
      {},
    );
    expect(resolved).toBe(false);
    expect(retriedWith).toEqual({ delaySeconds: 900 });
  });
});
