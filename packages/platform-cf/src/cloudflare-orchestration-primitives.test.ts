import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  applyCloudflareQueueDisposition,
  classifyWorkflowCreateBatch,
  cloudflareDigestWorkflowId,
  isExplicitlyEnabled,
  isPresentWorkflowStatus,
  PROCESSING_WORKFLOW_STEP_OPTIONS,
} from "./cloudflare-orchestration-primitives.ts";

describe("Cloudflare orchestration primitives", () => {
  test("shares exact UTF-8 digest encoding across DATA and video prefixes", async () => {
    const logical = "video-analysis:operation:例:v1:c2";
    const digest = createHash("sha256").update(logical, "utf8").digest("hex");
    for (const prefix of ["drw", "vaw"] as const) {
      const id = await cloudflareDigestWorkflowId(prefix, logical);
      expect(id).toBe(`${prefix}-${digest}`);
      expect(id).toHaveLength(68);
      expect(id).toMatch(/^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/u);
    }
    expect(await cloudflareDigestWorkflowId("vaw", logical.replace(":c2", ":c3"))).not.toBe(
      `vaw-${digest}`,
    );
    for (const invalid of ["", " x", "x ", "x".repeat(513)]) {
      await expect(cloudflareDigestWorkflowId("vaw", invalid)).rejects.toThrow(
        "invalid logical Workflow identity",
      );
    }
  });
  test("keeps the shared processing step policy exact", () => {
    expect(PROCESSING_WORKFLOW_STEP_OPTIONS).toEqual({
      retries: { limit: 2, delay: "15 seconds", backoff: "exponential" },
      timeout: "15 minutes",
    });
  });

  test("enables only the literal true spelling", () => {
    expect([undefined, "", "TRUE", " true", "true"].map(isExplicitlyEnabled)).toEqual([
      false,
      false,
      false,
      false,
      true,
    ]);
  });

  test("classifies only retained nonterminal Workflow states as present", () => {
    expect(
      ["queued", "running", "paused", "waiting", "waitingForPause", "rollingBack"].every(
        isPresentWorkflowStatus,
      ),
    ).toBe(true);
    expect(["complete", "errored", "terminated", "unknown"].some(isPresentWorkflowStatus)).toBe(
      false,
    );
  });

  test("maps createBatch cardinality and rejects impossible counts", () => {
    expect(classifyWorkflowCreateBatch([{}], "invalid count")).toBe("created");
    expect(classifyWorkflowCreateBatch([], "invalid count")).toBe("already_exists");
    expect(() => classifyWorkflowCreateBatch([{}, {}], "invalid count")).toThrow("invalid count");
  });

  test("applies exactly one explicit Queue disposition", () => {
    const actions: string[] = [];
    const message = {
      ack: () => actions.push("ack"),
      retry: (options?: { readonly delaySeconds?: number }) =>
        actions.push(options?.delaySeconds === undefined ? "dlq" : `retry:${options.delaySeconds}`),
    };

    applyCloudflareQueueDisposition(message, { disposition: "ack" });
    applyCloudflareQueueDisposition(message, { disposition: "retry", delaySeconds: 30 });
    applyCloudflareQueueDisposition(message, { disposition: "dlq" });

    expect(actions).toEqual(["ack", "retry:30", "dlq"]);
  });
});
