import { isPresentWorkflowStatus } from "./cloudflare-orchestration-primitives.ts";

export type VideoWorkflowObservation = Readonly<{
  state: "present" | "missing" | "terminal";
  status: string | null;
}>;

export type VideoWorkflowStatusFetch = (
  url: string,
  init: Readonly<{
    method: "GET";
    redirect: "manual";
    signal: AbortSignal;
    headers: Readonly<Record<string, string>>;
  }>,
) => Promise<Response>;

export type VideoWorkflowAccess = Readonly<{
  accountId: string | undefined;
  workflowName: string | undefined;
  scriptName: string | undefined;
  readToken: string | undefined;
}>;

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    await response.body?.cancel();
    throw new Error("Workflow lookup response is not JSON");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Workflow lookup response is empty");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 131_072) throw new Error("Workflow lookup response exceeds its bound");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!object(value)) throw new Error("Workflow lookup response is malformed");
  return value;
}

/** Used only after a binding lookup throws; never launches or mutates an instance. */
export function makeAuthenticatedVideoWorkflowLookup(
  access: VideoWorkflowAccess,
  fetcher: VideoWorkflowStatusFetch = fetch,
): (instanceId: string, effectIdentity: string) => Promise<VideoWorkflowObservation> {
  if (
    !/^[a-f0-9]{32}$/.test(access.accountId ?? "") ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(access.workflowName ?? "") ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(access.scriptName ?? "") ||
    !/^[a-zA-Z0-9_-]{16,256}$/.test(access.readToken ?? "")
  ) {
    throw new Error("Video Workflow read access requires account, workflow, script and read token");
  }
  const base = `https://api.cloudflare.com/client/v4/accounts/${access.accountId}/workflows/${access.workflowName}`;
  return async (instanceId, effectIdentity) => {
    if (!/^vaw-[a-f0-9]{64}$/.test(instanceId))
      throw new Error("Invalid video Workflow instance id");
    const signal = AbortSignal.timeout(5_000);
    const get = async (url: string) => {
      const response = await fetcher(url, {
        method: "GET",
        redirect: "manual",
        signal,
        headers: { Authorization: `Bearer ${access.readToken}`, Accept: "application/json" },
      });
      // Workers supports manual, not error. Never follow a bearer-bearing
      // request; only 200 and the explicitly verified 404 path are usable.
      if (response.status !== 200 && response.status !== 404) {
        await response.body?.cancel();
        throw new Error("Workflow lookup did not establish absence");
      }
      return { status: response.status, body: await boundedJson(response) };
    };
    const instance = await get(`${base}/instances/${instanceId}?simple=true`);
    if (instance.status === 200 && instance.body.success === true && object(instance.body.result)) {
      const result = instance.body.result;
      if (!object(result.params) || result.params.effectIdentity !== effectIdentity) {
        throw new Error("Workflow lookup identity does not match launch authority");
      }
      const status = result.status;
      if (typeof status === "string" && isPresentWorkflowStatus(status))
        return { state: "present", status };
      if (status === "complete" || status === "errored" || status === "terminated")
        return { state: "terminal", status };
      throw new Error("Workflow lookup status is unrecognized");
    }
    // A bare 404 could mean an invalid account/workflow or an intermediary.
    // Require a structured API error plus the exact live parent configuration.
    if (
      instance.status !== 404 ||
      instance.body.success !== false ||
      !Array.isArray(instance.body.errors) ||
      instance.body.errors.length === 0 ||
      !instance.body.errors.every(
        (error) =>
          object(error) && typeof error.code === "number" && typeof error.message === "string",
      )
    ) {
      throw new Error("Workflow lookup did not establish absence");
    }
    const parent = await get(base);
    if (
      parent.status !== 200 ||
      parent.body.success !== true ||
      !object(parent.body.result) ||
      parent.body.result.name !== access.workflowName ||
      parent.body.result.script_name !== access.scriptName ||
      parent.body.result.class_name !== "VideoAnalysisWorkflow"
    ) {
      throw new Error("Workflow lookup parent configuration is not authoritative");
    }
    return { state: "missing", status: null };
  };
}
