/** Private execution disposition; deliberately separate from the public reason-code contract. */
export class VideoWorkflowTerminalError extends Error {
  constructor(
    readonly reason: "superseded" | "membership_rejected" | "analysis_rejected" | "invalid_stage",
  ) {
    super(`video Workflow terminal: ${reason}`);
  }
}
