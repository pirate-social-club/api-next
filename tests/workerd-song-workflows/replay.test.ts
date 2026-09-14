import { env, introspectWorkflowInstance } from "cloudflare:test";
import { describe, expect, it } from "vitest";

type SongWorkflowTestEnv = Readonly<{
  MEDIA_PROCESSING_WORKFLOW: Workflow;
  DATA_REGISTRATION_WORKFLOW: Workflow;
}>;

const testEnv = env as unknown as SongWorkflowTestEnv;

describe("song Workflow native replay", () => {
  it("retries the real media Workflow step and returns the reloaded terminal authority", async () => {
    const instanceId = "media-operation-1-r1";
    await using instance = await introspectWorkflowInstance(
      testEnv.MEDIA_PROCESSING_WORKFLOW,
      instanceId,
    );
    await instance.modify(async (modifier) => {
      await modifier.disableRetryDelays();
      await modifier.mockStepError(
        { name: "media-processing-0-launch" },
        new Error("transient database outage"),
        1,
      );
    });

    await testEnv.MEDIA_PROCESSING_WORKFLOW.create({
      id: instanceId,
      params: {
        outboxId: "outbox-1",
        submissionId: "submission-1",
        operationId: "operation-1",
        workflowRevision: 1,
      },
    });

    await instance.waitForStatus("complete");
    await expect(
      instance.waitForStepResult({ name: "media-processing-0-launch" }),
    ).resolves.toEqual({
      eventType: "analysis_launch",
      result: { outcome: "blocked" },
    });
    await expect(instance.getOutput()).resolves.toEqual({ outcome: "blocked" });
  });

  it("retries the real DATA Workflow step with its serialized revision payload", async () => {
    const instanceId = "data-operation-1-r1";
    await using instance = await introspectWorkflowInstance(
      testEnv.DATA_REGISTRATION_WORKFLOW,
      instanceId,
    );
    await instance.modify(async (modifier) => {
      await modifier.disableRetryDelays();
      await modifier.mockStepError(
        { name: "data-registration-0" },
        new Error("transient signer secret outage"),
        1,
      );
    });

    await testEnv.DATA_REGISTRATION_WORKFLOW.create({
      id: instanceId,
      params: {
        outboxId: "outbox-1",
        registrationOperationId: "operation-1",
        workflowRevision: "1",
      },
    });

    await instance.waitForStatus("complete");
    await expect(instance.waitForStepResult({ name: "data-registration-0" })).resolves.toEqual({
      outcome: "inert",
    });
    await expect(instance.getOutput()).resolves.toEqual({ outcome: "inert" });
  });
});
