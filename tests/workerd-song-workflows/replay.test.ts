import { abortAllDurableObjects, env, introspectWorkflowInstance } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { readAlignmentRecoveryTerminalMessage } from "../../packages/application/src/media/alignment-recovery-diagnostics.ts";

type SongWorkflowTestEnv = Readonly<{
  MEDIA_PROCESSING_WORKFLOW: Workflow;
  DATA_REGISTRATION_WORKFLOW: Workflow;
  RECOVERY_STATE: KVNamespace;
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

describe("song alignment recovery native Workflow", () => {
  const launch = (operationId: string) =>
    testEnv.MEDIA_PROCESSING_WORKFLOW.create({
      id: `media-${operationId}-r3`,
      params: {
        outboxId: operationId,
        submissionId: "recovery-submission",
        operationId,
        workflowRevision: 3,
      },
    });
  for (const operationId of ["recovery-exhausted", "recovery-transient", "recovery-reset"]) {
    it(`${operationId} completes through the real interpreter`, async () => {
      await using instance = await introspectWorkflowInstance(
        testEnv.MEDIA_PROCESSING_WORKFLOW,
        `media-${operationId}-r3`,
      );
      await instance.modify(async (modifier) => {
        await modifier.disableSleeps();
      });
      await launch(operationId);
      await instance.waitForStatus("complete");
      expect(await instance.getOutput()).toEqual({ outcome: "alignment_recorded" });
      expect(
        JSON.parse((await testEnv.RECOVERY_STATE.get(`completed:${operationId}`)) ?? "null"),
      ).toMatchObject({ kind: "alignment", status: "unavailable" });
      expect(Number((await testEnv.RECOVERY_STATE.get(`providers:${operationId}`)) ?? 0)).toBe(
        operationId === "recovery-exhausted" ? 0 : 1,
      );
      expect(Number(await testEnv.RECOVERY_STATE.get(`lookups:${operationId}`))).toBe(
        operationId === "recovery-reset" ? 6 : operationId === "recovery-transient" ? 3 : 1,
      );
    });
  }
  it("stale lookup ends non-retryably with its persisted reason and no provider effect", async () => {
    const operationId = "recovery-stale";
    await using instance = await introspectWorkflowInstance(
      testEnv.MEDIA_PROCESSING_WORKFLOW,
      `media-${operationId}-r3`,
    );
    await launch(operationId);
    await instance.waitForStatus("errored");
    expect(await instance.getError()).toMatchObject({
      name: "Error",
      message: expect.stringContaining("alignment_recovery_lookup_stale"),
    });
    expect((await instance.getError()).message).toContain("invalid_projection_row_count");
    expect(readAlignmentRecoveryTerminalMessage((await instance.getError()).message)).toEqual({
      outcome: "alignment_recovery_lookup_stale",
      reason: "invalid_projection_row_count",
    });
    expect(await testEnv.RECOVERY_STATE.get(`lookups:${operationId}`)).toBe("1");
    expect(await testEnv.RECOVERY_STATE.get(`providers:${operationId}`)).toBeNull();
    expect(await testEnv.RECOVERY_STATE.get(`completed:${operationId}`)).toBeNull();
  });
  it("three failed lookups survive eviction after each wait and retain the terminal cause", async () => {
    const operationId = "recovery-failed";
    await using instance = await introspectWorkflowInstance(
      testEnv.MEDIA_PROCESSING_WORKFLOW,
      `media-${operationId}-r3`,
    );
    await launch(operationId);
    for (const sequence of [0, 1]) {
      expect(
        await instance.waitForStepResult({
          name:
            sequence === 0
              ? "media-processing-0-launch"
              : "media-processing-1-workflow_replacement",
        }),
      ).toMatchObject({ result: { outcome: "alignment_recovery_lookup_failed" } });
      await abortAllDurableObjects();
    }
    await instance.waitForStatus("errored");
    const error = await instance.getError();
    expect(error).toMatchObject({
      name: "Error",
      message: expect.stringContaining("alignment_recovery_lookup_failed"),
    });
    expect(error.message).toContain("ControlPlaneAcquireFailed");
    expect(readAlignmentRecoveryTerminalMessage(error.message)).toMatchObject({
      outcome: "alignment_recovery_lookup_failed",
      reason: { errorClass: "ControlPlaneAcquireFailed" },
    });
    expect(await testEnv.RECOVERY_STATE.get(`lookups:${operationId}`)).toBe("3");
    expect(await testEnv.RECOVERY_STATE.get(`providers:${operationId}`)).toBeNull();
    expect(await testEnv.RECOVERY_STATE.get(`completed:${operationId}`)).toBeNull();
  }, 45_000);
});
