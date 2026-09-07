import type { VideoAnalysisOutboxRecord } from "./analysis-queue.ts";
import type { VideoAttemptReconciliationStore, VideoPublicationStore } from "./publication.ts";

export type VideoPublicationWakeup = Readonly<{
  identity: string;
  effectIdentity: string;
  actionId: string;
}>;
export interface VideoPublicationWakeupStore {
  listPending(limit: number): Promise<readonly VideoPublicationWakeup[]>;
  touch(wakeup: VideoPublicationWakeup): Promise<boolean>;
  acknowledge(wakeup: VideoPublicationWakeup): Promise<boolean>;
}
export interface VideoPublicationWakeupServices {
  wakeups: VideoPublicationWakeupStore;
  outbox: {
    get(identity: string): Promise<VideoAnalysisOutboxRecord | null>;
    scheduleContinuation(
      record: VideoAnalysisOutboxRecord,
      eventSequence: number,
    ): Promise<boolean>;
  };
  store: Pick<VideoPublicationStore, "getSubmissionByOperation"> &
    Pick<VideoAttemptReconciliationStore, "reconcileTerminalWorkflow">;
  launcher: {
    inspect(
      identity: string,
      continuation: number,
    ): Promise<{ state: "present" | "missing" | "terminal"; status: string | null }>;
    notify(identity: string, continuation: number, actionId: string): Promise<void>;
  };
}

/** The scheduler delivers events and repairs intent. Queue delivery alone creates instances. */
export async function dispatchVideoPublicationWakeups(
  services: VideoPublicationWakeupServices,
  limit = 25,
) {
  const pending = await services.wakeups.listPending(limit);
  const result = { selected: pending.length, delivered: 0, continued: 0, failed: 0 };
  for (const wakeup of pending) {
    try {
      if (!(await services.wakeups.touch(wakeup))) continue;
      const intent = await services.outbox.get(wakeup.effectIdentity);
      if (intent === null) throw new Error("video publication wakeup intent missing");
      const authority = await services.store.getSubmissionByOperation(intent);
      if (
        authority === null ||
        authority.state.creationRevision !== intent.creationRevision ||
        authority.state.videoRevision !== intent.videoRevision ||
        authority.state.status === "published" ||
        authority.state.status === "blocked" ||
        authority.state.status === "abandoned"
      ) {
        await services.wakeups.acknowledge(wakeup);
        continue;
      }
      if (
        authority.state.status !== "processing" ||
        authority.state.phase !== "publish" ||
        authority.state.analysis === null
      )
        continue;
      if (intent.state !== "launched") continue;
      const observation = await services.launcher.inspect(
        intent.effectIdentity,
        intent.continuation,
      );
      if (observation.state !== "present") {
        const disposition = await services.store.reconcileTerminalWorkflow({
          submission: authority.state,
          observedEventSequence: authority.eventSequence,
          continuation: intent.continuation,
          evidenceRef: `video-publication-wakeup:${wakeup.identity}:${observation.status ?? observation.state}`,
        });
        if (
          disposition === "continue" &&
          (await services.outbox.scheduleContinuation(intent, authority.eventSequence))
        )
          result.continued++;
        continue;
      }
      await services.launcher.notify(intent.effectIdentity, intent.continuation, wakeup.actionId);
      if (await services.wakeups.acknowledge(wakeup)) result.delivered++;
    } catch {
      // A lost sendEvent response retains the ledger row. A duplicate event has no authority.
      result.failed++;
    }
  }
  return result;
}
