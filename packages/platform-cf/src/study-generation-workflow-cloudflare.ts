export interface CloudflareStudyGenerationWorkflowBinding<Payload> {
  readonly createBatch: (
    options: readonly { readonly id: string; readonly params: Payload }[],
  ) => Promise<readonly unknown[]>;
}

export const makeCloudflareStudyGenerationWorkflowLauncher = <Payload>(
  binding: CloudflareStudyGenerationWorkflowBinding<Payload>,
) => ({
  create: async (instanceId: string, payload: Payload): Promise<"created" | "already_exists"> => {
    const created = await binding.createBatch([{ id: instanceId, params: payload }]);
    if (created.length === 1) return "created";
    if (created.length === 0) return "already_exists";
    throw new Error("Study Workflow createBatch returned an unexpected instance count");
  },
});
