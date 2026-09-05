import {
  classifyWorkflowCreateBatch,
  cloudflareDigestWorkflowId,
  isPresentWorkflowStatus,
} from "./cloudflare-orchestration-primitives.ts";
import {
  makeAuthenticatedVideoWorkflowLookup,
  type VideoWorkflowAccess,
  type VideoWorkflowObservation,
  type VideoWorkflowStatusFetch,
} from "./video-workflow-status-api.ts";

export type { VideoWorkflowStatusFetch } from "./video-workflow-status-api.ts";

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

function logicalIdentity(effectIdentity: string, continuation: number): string {
  if (!Number.isInteger(continuation) || continuation < 0 || continuation > 2)
    throw new TypeError("video Workflow continuation must be between zero and two");
  return continuation === 0 ? effectIdentity : `${effectIdentity}:k${continuation}`;
}

/** Transport boundary only; PostgreSQL owns whether a missing or terminal instance is recoverable. */
export function makeCloudflareVideoAnalysisWorkflowLauncher(
  binding: VideoAnalysisWorkflowBinding,
  isMissing: (error: unknown) => boolean,
  recoverLookup?: (instanceId: string, effectIdentity: string) => Promise<VideoWorkflowObservation>,
) {
  const inspect = async (
    effectIdentity: string,
    continuation = 0,
  ): Promise<{ state: "present" | "missing" | "terminal"; status: string | null }> => {
    const logical = logicalIdentity(effectIdentity, continuation);
    const id = await cloudflareDigestWorkflowId("vaw", logical);
    try {
      const status = (await (await binding.get(id)).status()).status;
      if (isPresentWorkflowStatus(status)) return { state: "present", status };
      if (["complete", "errored", "terminated"].includes(status))
        return { state: "terminal", status };
      // Unknown status is not proof of absence and must not trigger a fresh encode.
      throw new Error("Unrecognized video Workflow status");
    } catch (error) {
      if (isMissing(error)) return { state: "missing", status: null };
      if (recoverLookup !== undefined) return recoverLookup(id, logical);
      throw error;
    }
  };
  return {
    instanceId: (effectIdentity: string, continuation = 0) =>
      cloudflareDigestWorkflowId("vaw", logicalIdentity(effectIdentity, continuation)),
    create: async (
      effectIdentity: string,
      continuation = 0,
    ): Promise<"created" | "already_exists"> => {
      const logical = logicalIdentity(effectIdentity, continuation);
      const id = await cloudflareDigestWorkflowId("vaw", logical);
      return classifyWorkflowCreateBatch(
        await binding.createBatch([{ id, params: { effectIdentity: logical } }]),
        "Video Workflow createBatch returned an unexpected instance count",
      );
    },
    inspect,
    get: async (identity: string, continuation = 0) =>
      (await inspect(identity, continuation)).state,
  };
}

/** Both concrete Workers use the same authenticated recovery boundary. */
export function makeConfiguredVideoAnalysisWorkflowLauncher(
  binding: VideoAnalysisWorkflowBinding,
  access: VideoWorkflowAccess,
  fetcher: VideoWorkflowStatusFetch = fetch,
) {
  return makeCloudflareVideoAnalysisWorkflowLauncher(
    binding,
    () => false,
    makeAuthenticatedVideoWorkflowLookup(access, fetcher),
  );
}
