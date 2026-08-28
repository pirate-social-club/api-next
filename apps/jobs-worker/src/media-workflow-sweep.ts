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
}>;

export type MediaWorkflowSweepDependencies = Readonly<{
  readonly store: Pick<
    MediaProcessingStore,
    "listWorkflowCandidates" | "loadAuthority" | "replaceMissingWorkflow"
  >;
  readonly workflow: Pick<MediaProcessingWorkflowLauncher, "get">;
  readonly observe?: MediaProcessingObserver;
}>;

const terminalStatuses: ReadonlySet<MediaProcessingAuthority["status"]> = new Set([
  "published",
  "blocked",
  "processing_failed",
  "abandoned",
]);

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
  const result = { inspected: 0, present: 0, replaced: 0, stale: 0, limitReached: 0 };
  for (const candidate of candidates) {
    if (candidate.workflowRevision < 1 || terminalStatuses.has(candidate.status)) continue;
    result.inspected += 1;
    if (songWorkflowReplacementLimitReached(candidate.workflowRevision)) {
      result.limitReached += 1;
      continue;
    }
    if ((await dependencies.workflow.get(workflowInstanceId(candidate))) === "present") {
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
      terminalStatuses.has(authority.status)
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
