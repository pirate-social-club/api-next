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
    });
    expect(await created.create("study-generation-1", payload)).toBe("created");
    expect(received).toEqual([{ id: "study-generation-1", params: payload }]);

    const retained = makeCloudflareStudyGenerationWorkflowLauncher({
      createBatch: async () => [],
    });
    expect(await retained.create("study-generation-1", payload)).toBe("already_exists");
  });

  test("fails closed on an impossible batch result", async () => {
    const launcher = makeCloudflareStudyGenerationWorkflowLauncher({
      createBatch: async () => [{}, {}],
    });
    expect(launcher.create("study-generation-1", {})).rejects.toThrow("unexpected instance count");
  });
});
