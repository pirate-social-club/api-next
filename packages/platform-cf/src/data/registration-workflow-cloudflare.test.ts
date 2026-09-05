import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  applyDataRegistrationQueueDisposition,
  type CloudflareDataRegistrationWorkflowBinding,
  cloudflareDataRegistrationWorkflowId,
  makeCloudflareDataRegistrationWorkflowLauncher,
} from "./registration-workflow-cloudflare";

const payload = {
  outboxId: "outbox-1",
  registrationOperationId: "operation-1",
  workflowRevision: 1n,
} as const;

describe("Cloudflare DATA registration adapters", () => {
  test("converges a duplicate Workflow create through the deterministic instance", async () => {
    let present = false;
    const providerIds: string[] = [];
    const binding: CloudflareDataRegistrationWorkflowBinding = {
      get: async (instanceId) => {
        providerIds.push(instanceId);
        return { status: async () => ({ status: present ? "running" : "unknown" }) };
      },
      createBatch: async ([input]) => {
        if (input !== undefined) providerIds.push(input.id);
        if (present) return [];
        present = true;
        return [{}];
      },
    };
    const launcher = makeCloudflareDataRegistrationWorkflowLauncher(binding, () => false);

    expect(await launcher.create("workflow-1", payload)).toBe("created");
    expect(await launcher.create("workflow-1", payload)).toBe("already_exists");
    expect(await launcher.get("workflow-1")).toBe("present");
    const providerId = await cloudflareDataRegistrationWorkflowId("workflow-1");
    expect(providerIds).toEqual([providerId, providerId, providerId]);
    expect(providerId).toMatch(/^drw-[0-9a-f]{64}$/u);
    expect(providerId).toBe(`drw-${createHash("sha256").update("workflow-1").digest("hex")}`);
    expect(providerId.length).toBeLessThanOrEqual(100);
  });

  test("propagates createBatch transport failure without a get probe", async () => {
    const binding: CloudflareDataRegistrationWorkflowBinding = {
      get: async () => {
        throw new Error("get must not be called");
      },
      createBatch: async () => {
        throw new Error("transport unavailable");
      },
    };
    const launcher = makeCloudflareDataRegistrationWorkflowLauncher(binding, () => false);
    await expect(launcher.create("workflow-1", payload)).rejects.toThrow("transport unavailable");
  });

  test("projects active statuses as present and terminal statuses as replacement candidates", async () => {
    for (const status of [
      "queued",
      "running",
      "paused",
      "waiting",
      "waitingForPause",
      "rollingBack",
    ] as const) {
      const binding: CloudflareDataRegistrationWorkflowBinding = {
        get: async () => ({ status: async () => ({ status }) }),
        createBatch: async () => [],
      };
      const launcher = makeCloudflareDataRegistrationWorkflowLauncher(binding, () => false);
      expect(await launcher.get("workflow-1")).toBe("present");
    }

    for (const status of ["unknown", "errored", "terminated", "complete"] as const) {
      const binding: CloudflareDataRegistrationWorkflowBinding = {
        get: async () => ({ status: async () => ({ status }) }),
        createBatch: async () => [],
      };
      const launcher = makeCloudflareDataRegistrationWorkflowLauncher(binding, () => false);
      expect(await launcher.get("workflow-1")).toBe("missing");
    }
  });

  test("maps persisted queue dispositions to message ack and retry controls", () => {
    const calls: string[] = [];
    const message = {
      ack: () => calls.push("ack"),
      retry: (options?: { delaySeconds?: number }) =>
        calls.push(options?.delaySeconds === undefined ? "dlq" : `retry:${options.delaySeconds}`),
    };

    applyDataRegistrationQueueDisposition(message, { disposition: "ack" });
    applyDataRegistrationQueueDisposition(message, {
      disposition: "retry",
      delaySeconds: 30,
    });
    applyDataRegistrationQueueDisposition(message, { disposition: "dlq" });

    expect(calls).toEqual(["ack", "retry:30", "dlq"]);
  });
});
