import type { VideoAnalysisOutboxRecord } from "./analysis-queue.ts";
import type { VideoAttemptReconciliationStore, VideoPublicationStore } from "./publication.ts";

export interface VideoWorkflowRecoveryServices {
  readonly outbox: {
    readonly scheduleContinuation: (
      record: VideoAnalysisOutboxRecord,
      observedEventSequence: number,
    ) => Promise<boolean>;
    readonly listForReconciliation: (
      limit: number,
    ) => Promise<readonly VideoAnalysisOutboxRecord[]>;
    readonly markInstanceMissing: (record: VideoAnalysisOutboxRecord) => Promise<boolean>;
    readonly touchReconciliation: (record: VideoAnalysisOutboxRecord) => Promise<boolean>;
    readonly reconcileLaunch: (
      record: VideoAnalysisOutboxRecord,
      instanceId: string | null,
    ) => Promise<boolean>;
  };
  readonly store: Pick<VideoPublicationStore, "getSubmissionByOperation"> &
    Pick<VideoAttemptReconciliationStore, "reconcileTerminalWorkflow">;
  readonly launcher: {
    readonly inspect: (
      identity: string,
      continuation?: number,
    ) => Promise<{ state: "present" | "missing" | "terminal"; status: string | null }>;
    readonly instanceId: (identity: string, continuation?: number) => Promise<string>;
  };
}

/** Repair PostgreSQL launch intent only. The normal Queue dispatch remains the sole launcher. */
export async function recoverVideoWorkflowLaunches(
  services: VideoWorkflowRecoveryServices,
  limit = 25,
) {
  const records = await services.outbox.listForReconciliation(limit);
  const result = {
    inspected: records.length,
    missing: 0,
    terminal: 0,
    recovered: 0,
    failed: 0,
    deferred: 0,
  };
  for (const record of records) {
    try {
      // Rotate bounded scans even when provider lookup fails, avoiding starvation.
      if (!(await services.outbox.touchReconciliation(record))) continue;
      const authority = await services.store.getSubmissionByOperation(record);
      if (
        authority?.state.creationRevision === record.creationRevision &&
        authority.state.videoRevision === record.videoRevision &&
        authority.state.status === "processing_failed" &&
        record.state === "launching" &&
        record.launchAttempts === 3
      ) {
        if (await services.outbox.reconcileLaunch(record, null)) result.recovered += 1;
        continue;
      }
      if (
        authority === null ||
        authority.state.creationRevision !== record.creationRevision ||
        authority.state.videoRevision !== record.videoRevision ||
        authority.state.video?.canonicalSha256 !== record.canonicalVideoSha256 ||
        authority.state.status !== "processing" ||
        (authority.state.decision !== null && authority.state.phase !== "publish")
      )
        continue;
      const observation = await services.launcher.inspect(
        record.effectIdentity,
        record.continuation,
      );
      const status = observation.state;
      const instanceId = await services.launcher.instanceId(
        record.effectIdentity,
        record.continuation,
      );
      if (status === "terminal" || (status === "missing" && record.launchAttempts >= 3)) {
        const disposition = await services.store.reconcileTerminalWorkflow({
          submission: authority.state,
          observedEventSequence: authority.eventSequence,
          evidenceRef: `video-workflow:${instanceId}:${observation.status ?? status}`,
          continuation: record.continuation,
        });
        if (disposition === "continue") {
          if (await services.outbox.scheduleContinuation(record, authority.eventSequence))
            result.recovered += 1;
          continue;
        }
        if (disposition === "failed" || disposition === "reconciliation_required")
          result.terminal += 1;
        if (record.state === "launching" && status === "missing") {
          await services.outbox.reconcileLaunch(record, null);
        }
      } else if (record.state === "launching") {
        if (
          await services.outbox.reconcileLaunch(record, status === "present" ? instanceId : null)
        ) {
          result.recovered += 1;
        }
      } else if (status === "missing") {
        if (await services.outbox.markInstanceMissing(record)) result.missing += 1;
      }
    } catch {
      // Unknown status, transport errors and failed outcome writes prove no
      // absence. Leave the durable row for a future scheduled reconciliation.
      result.failed += 1;
    }
  }
  return result;
}
