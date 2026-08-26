import { describe, expect, test } from "bun:test";
import {
  applyDataRegistrationQueueDisposition,
  type CloudflareDataRegistrationWorkflowBinding,
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
    const binding: CloudflareDataRegistrationWorkflowBinding = {
      get: async () => ({
        status: async () => ({ status: present ? "running" : "unknown" }),
      }),
      create: async () => {
        present = true;
        throw new Error("already exists");
      },
    };
    const launcher = makeCloudflareDataRegistrationWorkflowLauncher(binding, () => false);

    expect(await launcher.create("workflow-1", payload)).toBe("already_exists");
    expect(await launcher.get("workflow-1")).toBe("present");
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
