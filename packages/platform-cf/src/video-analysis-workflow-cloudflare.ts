import {
  classifyWorkflowCreateBatch,
  cloudflareDigestWorkflowId,
  isPresentWorkflowStatus,
} from "./cloudflare-orchestration-primitives.ts";

export interface VideoAnalysisWorkflowBinding {
  readonly get: (
    id: string,
  ) => Promise<{ readonly status: () => Promise<{ readonly status: string }> }>;
  readonly createBatch: (
    instances: readonly {
      readonly id: string;
      readonly params: { readonly effectIdentity: string };
    }[],
  ) => Promise<readonly unknown[]>;
}

/** Transport boundary only; PostgreSQL owns whether a missing or terminal instance is recoverable. */
export function makeCloudflareVideoAnalysisWorkflowLauncher(
  binding: VideoAnalysisWorkflowBinding,
  isMissing: (error: unknown) => boolean,
) {
  const inspect = async (
    effectIdentity: string,
  ): Promise<{ state: "present" | "missing" | "terminal"; status: string | null }> => {
    const id = await cloudflareDigestWorkflowId("vaw", effectIdentity);
    try {
      const status = (await (await binding.get(id)).status()).status;
      if (isPresentWorkflowStatus(status)) return { state: "present", status };
      if (["complete", "errored", "terminated"].includes(status))
        return { state: "terminal", status };
      // Unknown status is not proof of absence and must not trigger a fresh encode.
      throw new Error("Unrecognized video Workflow status");
    } catch (error) {
      if (isMissing(error)) return { state: "missing", status: null };
      throw error;
    }
  };
  return {
    instanceId: (effectIdentity: string) => cloudflareDigestWorkflowId("vaw", effectIdentity),
    create: async (effectIdentity: string): Promise<"created" | "already_exists"> => {
      const id = await cloudflareDigestWorkflowId("vaw", effectIdentity);
      return classifyWorkflowCreateBatch(
        await binding.createBatch([{ id, params: { effectIdentity } }]),
        "Video Workflow createBatch returned an unexpected instance count",
      );
    },
    inspect,
    get: async (identity: string) => (await inspect(identity)).state,
  };
}
