import { describe, expect, test } from "bun:test";
import { cloudflareDigestWorkflowId } from "./cloudflare-orchestration-primitives.ts";
import { makeCloudflareVideoAnalysisWorkflowLauncher } from "./video-analysis-workflow-cloudflare.ts";

const logical = "video-analysis:operation-one:v1:c1";

describe("video Workflow transport", () => {
  test("lost create response and redelivery converge on the same instance and retain logical metadata", async () => {
    const instances = new Map<string, { readonly effectIdentity: string }>();
    let loseResponse = true;
    const seen: string[] = [];
    const launcher = makeCloudflareVideoAnalysisWorkflowLauncher(
      {
        createBatch: async ([input]) => {
          if (input === undefined) throw new Error("missing launch");
          seen.push(input.id);
          if (instances.has(input.id)) return [];
          instances.set(input.id, input.params);
          if (loseResponse) {
            loseResponse = false;
            throw new Error("lost response");
          }
          return [{}];
        },
        get: async (id) => {
          seen.push(id);
          if (!instances.has(id)) throw new Error("not found");
          return { status: async () => ({ status: "running" }) };
        },
      },
      (error) => error instanceof Error && error.message === "not found",
    );
    expect(await launcher.get(logical)).toBe("missing");
    await expect(launcher.create(logical)).rejects.toThrow("lost response");
    expect(await launcher.create(logical)).toBe("already_exists");
    expect(await launcher.get(logical)).toBe("present");
    const id = await cloudflareDigestWorkflowId("vaw", logical);
    expect(seen).toEqual([id, id, id, id]);
    expect([...instances.values()]).toEqual([{ effectIdentity: logical }]);
    expect(await launcher.create(logical.replace(":c1", ":c2"))).toBe("created");
    expect(instances.size).toBe(2);
  });

  test("keeps retained terminal instances distinct from confirmed absence", async () => {
    for (const status of ["complete", "errored", "terminated"]) {
      const launcher = makeCloudflareVideoAnalysisWorkflowLauncher(
        {
          get: async () => ({ status: async () => ({ status }) }),
          createBatch: async () => {
            throw new Error("must not create during inspection");
          },
        },
        () => false,
      );
      expect(await launcher.get(logical)).toBe("terminal");
    }
    const launcher = makeCloudflareVideoAnalysisWorkflowLauncher(
      {
        get: async () => ({ status: async () => ({ status: "unknown" }) }),
        createBatch: async () => [],
      },
      () => false,
    );
    await expect(launcher.get(logical)).rejects.toThrow("Unrecognized video Workflow status");
  });

  test("propagates lookup transport errors and rejects impossible create cardinality", async () => {
    const launcher = makeCloudflareVideoAnalysisWorkflowLauncher(
      {
        get: async () => {
          throw new Error("transport unavailable");
        },
        createBatch: async () => [{}, {}],
      },
      () => false,
    );
    await expect(launcher.get(logical)).rejects.toThrow("transport unavailable");
    await expect(launcher.create(logical)).rejects.toThrow("unexpected instance count");
  });
});
