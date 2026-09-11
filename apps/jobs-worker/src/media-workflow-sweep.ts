import { isMediaTerminalSubmissionStatus } from "../../../packages/application/src/media/media-recovery-eligibility.ts";
import type {
  MediaProcessingAuthority,
  MediaProcessingObserver,
  MediaProcessingStore,
  MediaProcessingWorkflowLauncher,
} from "../../../packages/application/src/media/processing-contracts.ts";
import { songWorkflowReplacementLimitReached } from "./song-workflow-recovery-policy.ts";

export type MediaWorkflowSweepResult = Readonly<{
  readonly inspected: number;
  readonly present: number;
  readonly replaced: number;
  readonly stale: number;
  readonly limitReached: number;
  readonly lookupFailed: number;
}>;

export type MediaWorkflowSweepDependencies = Readonly<{
  readonly store: Pick<
    MediaProcessingStore,
    "listWorkflowCandidates" | "loadAuthority" | "replaceMissingWorkflow"
  >;
  readonly workflow: Pick<MediaProcessingWorkflowLauncher, "get">;
  readonly observe?: MediaProcessingObserver;
}>;

// Published songs are not terminal for recovery: the shared candidate policy
// lists them while their exact alignment is still pending, so the sweep must
// inspect them and emit the replacement that routes back into alignment.
const workflowInstanceId = (authority: MediaProcessingAuthority): string =>
  `media-${authority.operationId}-r${authority.workflowRevision}`;

/**
 * Repairs a lost Workflow only by advancing authoritative PostgreSQL state and
 * emitting its replacement outbox. Queue delivery remains the sole launcher.
 */
export async function sweepMissingMediaWorkflows(
  dependencies: MediaWorkflowSweepDependencies,
): Promise<MediaWorkflowSweepResult> {
  const candidates = await dependencies.store.listWorkflowCandidates();
  const result = {
    inspected: 0,
    present: 0,
    replaced: 0,
    stale: 0,
    limitReached: 0,
    lookupFailed: 0,
  };
  for (const candidate of candidates) {
    if (candidate.workflowRevision < 1 || isMediaTerminalSubmissionStatus(candidate.status))
      continue;
    result.inspected += 1;
    if (songWorkflowReplacementLimitReached(candidate.replacementSequence)) {
      result.limitReached += 1;
      continue;
    }
    let workflowStatus: "present" | "missing";
    try {
      workflowStatus = await dependencies.workflow.get(workflowInstanceId(candidate));
    } catch {
      result.lookupFailed += 1;
      dependencies.observe?.({
        event: "workflow_lookup_failed",
        operationId: candidate.operationId,
        submissionId: candidate.submissionId,
        workflowRevision: candidate.workflowRevision,
      });
      continue;
    }
    if (workflowStatus === "present") {
      result.present += 1;
      continue;
    }

    const authority = await dependencies.store.loadAuthority(
      candidate.submissionId,
      candidate.operationId,
    );
    if (
      authority === null ||
      authority.workflowRevision !== candidate.workflowRevision ||
      isMediaTerminalSubmissionStatus(authority.status)
    ) {
      result.stale += 1;
      continue;
    }
    const committed = await dependencies.store.replaceMissingWorkflow(authority);
    if (committed === "committed") {
      result.replaced += 1;
      dependencies.observe?.({
        event: "workflow_replaced",
        operationId: authority.operationId,
        submissionId: authority.submissionId,
        workflowRevision: authority.workflowRevision + 1,
      });
    } else {
      result.stale += 1;
    }
  }
  return result;
}
