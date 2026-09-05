import { describe, expect, it } from "vitest";
import { makeVideoAnalysisWorkflowRunner } from "../../apps/media-processor-worker/src/video-workflow.ts";
import type { VideoWorkflowServices } from "../../packages/application/src/video/workflow.ts";
import { makeCloudflareWorkflowEntrypoint } from "../../packages/platform-cf/src/cloudflare-workflow-entrypoint.ts";

describe("video Workflow native entrypoint helper", () => {
  it("fails closed locally when the video runtime is not composed", async () => {
    const Entrypoint = makeCloudflareWorkflowEntrypoint(
      makeVideoAnalysisWorkflowRunner(() => ({})),
    );
    await expect(
      Entrypoint.prototype.run.call(
        { env: {} } as never,
        {
          payload: { effectIdentity: "video-analysis:operation:v1:c1" },
          instanceId: "vaw-fixture",
        } as never,
        {} as never,
      ),
    ).rejects.toThrow("video Workflow runtime is not composed");
  });

  it("runs the authority step through the real superclass and preserves the shared retry options", async () => {
    const steps: string[] = [];
    const runtime = {
      outbox: { get: async () => null },
    } as unknown as VideoWorkflowServices;
    const Entrypoint = makeCloudflareWorkflowEntrypoint(
      makeVideoAnalysisWorkflowRunner(() => ({ videoWorkflow: runtime })),
    );
    const result = await Entrypoint.prototype.run.call(
      { env: {} } as never,
      {
        payload: { effectIdentity: "video-analysis:operation:v1:c1" },
        instanceId: "vaw-fixture",
      } as never,
      {
        do: async (name: string, options: unknown, run: () => Promise<unknown>) => {
          steps.push(name);
          expect(options).toEqual({
            retries: { limit: 2, delay: "15 seconds", backoff: "exponential" },
            timeout: "15 minutes",
          });
          return run();
        },
      } as never,
    );
    expect(result).toEqual({ status: "superseded" });
    expect(steps).toEqual(["resolve-authority"]);
  });
});
