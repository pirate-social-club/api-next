import { describe, expect, test } from "bun:test";
import { makeCloudflareStudyGenerationWorkflowLauncher } from "./study-generation-workflow-cloudflare.ts";

describe("Cloudflare Study generation Workflow launcher", () => {
  test("creates one deterministic instance and treats retained identity as convergence", async () => {
    const payload = { postId: "post-1" };
    let received: unknown;
    const created = makeCloudflareStudyGenerationWorkflowLauncher({
      createBatch: async (batch) => {
        received = batch;
        return [{}];
      },
      get: async () => {
        throw new Error("unused");
      },
    });
    expect(await created.create("study-generation-1", payload)).toBe("created");
    expect(received).toEqual([{ id: "study-generation-1", params: payload }]);

    const retained = makeCloudflareStudyGenerationWorkflowLauncher({
      createBatch: async () => [],
      get: async () => ({
        status: async () => ({ status: "running" }),
        restart: async () => undefined,
        resume: async () => undefined,
      }),
    });
    expect(await retained.create("study-generation-1", payload)).toBe("already_exists");
  });

  test("fails closed on an impossible batch result", async () => {
    const launcher = makeCloudflareStudyGenerationWorkflowLauncher({
      createBatch: async () => [{}, {}],
      get: async () => {
        throw new Error("unused");
      },
    });
    expect(launcher.create("study-generation-1", {})).rejects.toThrow("unexpected instance count");
  });

  test("recovers paused, errored, and terminated retained instances", async () => {
    for (const [status, expected] of [
      ["paused", "resumed"],
      ["errored", "restarted"],
      ["terminated", "restarted"],
    ] as const) {
      let resumed = 0;
      let restarted = 0;
      const launcher = makeCloudflareStudyGenerationWorkflowLauncher({
        createBatch: async () => [],
        get: async () => ({
          status: async () => ({ status }),
          restart: async () => {
            restarted += 1;
          },
          resume: async () => {
            resumed += 1;
          },
        }),
      });
      expect(await launcher.create("study-generation-1", {})).toBe(expected);
      expect(resumed).toBe(status === "paused" ? 1 : 0);
      expect(restarted).toBe(status === "paused" ? 0 : 1);
    }
  });

  test("converges every active or complete retained status without a transition", async () => {
    for (const status of ["queued", "running", "waiting", "waitingForPause", "complete"] as const) {
      let transitioned = false;
      const launcher = makeCloudflareStudyGenerationWorkflowLauncher({
        createBatch: async () => [],
        get: async () => ({
          status: async () => ({ status }),
          restart: async () => {
            transitioned = true;
          },
          resume: async () => {
            transitioned = true;
          },
        }),
      });
      expect(await launcher.create("study-generation-1", {})).toBe("already_exists");
      expect(transitioned).toBe(false);
    }
  });

  test("fails closed when retained instance status is unknown", async () => {
    const launcher = makeCloudflareStudyGenerationWorkflowLauncher({
      createBatch: async () => [],
      get: async () => ({
        status: async () => ({ status: "unknown" }),
        restart: async () => undefined,
        resume: async () => undefined,
      }),
    });
    await expect(launcher.create("study-generation-1", {})).rejects.toThrow("unknown status");
  });
});
