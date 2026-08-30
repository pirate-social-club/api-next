export interface CloudflareStudyGenerationWorkflowBinding<Payload> {
  readonly createBatch: (
    options: readonly { readonly id: string; readonly params: Payload }[],
  ) => Promise<readonly unknown[]>;
  readonly get: (id: string) => Promise<CloudflareStudyGenerationWorkflowInstance>;
}

export type CloudflareStudyGenerationWorkflowStatus =
  | "queued"
  | "running"
  | "paused"
  | "errored"
  | "terminated"
  | "complete"
  | "waiting"
  | "waitingForPause"
  | "unknown";

export interface CloudflareStudyGenerationWorkflowInstance {
  readonly status: () => Promise<Readonly<{ status: CloudflareStudyGenerationWorkflowStatus }>>;
  readonly restart: () => Promise<void>;
  readonly resume: () => Promise<void>;
}

export const makeCloudflareStudyGenerationWorkflowLauncher = <Payload>(
  binding: CloudflareStudyGenerationWorkflowBinding<Payload>,
) => ({
  create: async (
    instanceId: string,
    payload: Payload,
  ): Promise<"created" | "already_exists" | "restarted" | "resumed"> => {
    const created = await binding.createBatch([{ id: instanceId, params: payload }]);
    if (created.length === 1) return "created";
    if (created.length !== 0) {
      throw new Error("Study Workflow createBatch returned an unexpected instance count");
    }
    const instance = await binding.get(instanceId);
    const status = (await instance.status()).status;
    if (status === "paused") {
      await instance.resume();
      return "resumed";
    }
    if (status === "errored" || status === "terminated") {
      await instance.restart();
      return "restarted";
    }
    if (
      status === "queued" ||
      status === "running" ||
      status === "waiting" ||
      status === "waitingForPause" ||
      status === "complete"
    ) {
      return "already_exists";
    }
    throw new Error("Study Workflow retained instance has unknown status");
  },
});
