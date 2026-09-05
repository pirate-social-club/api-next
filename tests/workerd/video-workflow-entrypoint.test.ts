import { describe, expect, it } from "vitest";
import { makeVideoAnalysisWorkflowRunner } from "../../apps/media-processor-worker/src/video-workflow.ts";
import type { VideoWorkflowServices } from "../../packages/application/src/video/workflow.ts";
import { VideoWorkflowTerminalError } from "../../packages/application/src/video/workflow-errors.ts";
import {
  makeCloudflareWorkflowEntrypoint,
  makeWorkflowNonRetryableError,
} from "../../packages/platform-cf/src/cloudflare-workflow-entrypoint.ts";

describe("video Workflow native entrypoint helper", () => {
  it("fails closed locally when the video runtime is not composed", async () => {
    const Entrypoint = makeCloudflareWorkflowEntrypoint(
      makeVideoAnalysisWorkflowRunner(() => ({}), makeWorkflowNonRetryableError),
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
      makeVideoAnalysisWorkflowRunner(
        () => ({ videoWorkflow: runtime }),
        makeWorkflowNonRetryableError,
      ),
    );
    const result = Entrypoint.prototype.run.call(
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
    await expect(result).rejects.toMatchObject({
      name: "NonRetryableError",
      message: "video Workflow terminal: superseded",
    });
    expect(steps).toEqual(["resolve-authority"]);
  });
});

for (const reason of ["membership_rejected", "analysis_rejected", "database"] as const) {
  it(`classifies ${reason} inside the step callback without changing transient retry behaviour`, async () => {
    const error =
      reason === "database"
        ? new Error("database unavailable")
        : new VideoWorkflowTerminalError(reason);
    const runtime = {
      outbox: {
        get: async () => {
          throw error;
        },
      },
    } as unknown as VideoWorkflowServices;
    const Entrypoint = makeCloudflareWorkflowEntrypoint(
      makeVideoAnalysisWorkflowRunner(
        () => ({ videoWorkflow: runtime }),
        makeWorkflowNonRetryableError,
      ),
    );
    let attempts = 0;
    const execution = Entrypoint.prototype.run.call(
      { env: {} } as never,
      {
        payload: { effectIdentity: "video-analysis:operation:v1:c1" },
        instanceId: "vaw-fixture",
      } as never,
      {
        do: async (_name: string, _options: unknown, run: () => Promise<unknown>) => {
          for (;;) {
            attempts += 1;
            try {
              return await run();
            } catch (caught) {
              if ((caught as Error).name === "NonRetryableError" || attempts === 3) throw caught;
            }
          }
        },
      } as never,
    );
    if (reason === "database") await expect(execution).rejects.toBe(error);
    else
      await expect(execution).rejects.toMatchObject({
        name: "NonRetryableError",
        message: error.message,
      });
    expect(attempts).toBe(reason === "database" ? 3 : 1);
  });
}
