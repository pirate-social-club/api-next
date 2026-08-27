import { describe, expect, test } from "bun:test";
import type { DataRegistrationWorkflowDependencies } from "../../../packages/application/src/data/registration-workflow.ts";
import type { DataRegistrationQueueDependencies } from "../../../packages/application/src/data/registration-workflow-queue.ts";
import { type DataRegistrationWorkflowStep, makeDataRegistrationWorkflowRunner } from "./index.ts";
import { isDataRegistrationEnabled } from "./posture.ts";

describe("DATA registration Worker posture", () => {
  test("is disabled by default and requires an exact opt-in", () => {
    expect(isDataRegistrationEnabled(undefined)).toBe(false);
    expect(isDataRegistrationEnabled("false")).toBe(false);
    expect(isDataRegistrationEnabled("TRUE")).toBe(false);
    expect(isDataRegistrationEnabled("true")).toBe(true);
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
});
