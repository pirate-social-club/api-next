import {
  observeVideoStreamIngest,
  prepareVideoStreamCopy,
  type VideoStreamIdentity,
  type VideoStreamIngestState,
  type VideoStreamObservation,
} from "@pirate/domain";

/** Loaded from durable publication/source facts, never from queue payload fields. */
export type VideoStreamClaim = Readonly<{
  effectIdentity: string;
  leaseOwner: string;
  fence: number;
  revision: number;
  identity: VideoStreamIdentity;
  sealedSourceRef: string;
  authority: Readonly<{
    submissionId: string;
    postId: string;
    creationRevision: number;
    videoRevision: number;
    analysisRevision: number;
  }>;
  state: VideoStreamIngestState;
}>;

interface VideoStreamIngestStore {
  /** Atomically claim eligible work and reload exact publication/source authority. */
  claim(effectIdentity: string): Promise<VideoStreamClaim | null>;
  /**
   * Fence by live lease, owner, revision and source authority in one transaction.
   * A successful write returns its incremented revision. A null result grants no I/O.
   * release atomically updates the outbox disposition from the persisted state:
   * sending/bound remain pending; ready completes; failed/reconciliation stop.
   */
  transition(
    claim: VideoStreamClaim,
    next: VideoStreamIngestState,
    release: boolean,
  ): Promise<VideoStreamClaim | null>;
}

interface VideoStreamIngestTransport {
  /** Resolve a bounded exact-object grant internally; no caller URL or bucket key. */
  copy(
    input: Readonly<{
      identity: VideoStreamIdentity;
      sealedSourceRef: string;
      requireSignedURLs: true;
      downloadsEnabled: false;
    }>,
  ): Promise<void>;
  /** Validate provider responses before returning these observations. */
  observe(identity: VideoStreamIdentity): Promise<readonly VideoStreamObservation[]>;
}

export interface VideoStreamIngestServices {
  store: VideoStreamIngestStore;
  transport: VideoStreamIngestTransport;
  nowMs(): number;
  /** Explicit composition policy; this interpreter chooses no production deadlines. */
  deadlines(nowMs: number): Readonly<{
    acceptanceDeadlineMs: number;
    encodingDeadlineMs: number;
  }>;
}

/** One bounded turn. Durable orchestration owns waits; there is no queue poll loop. */
export async function consumeVideoStreamIngest(
  effectIdentity: string,
  services: VideoStreamIngestServices,
): Promise<"unclaimed" | "stale" | "retry" | "pending" | "ready" | "failed"> {
  let claim = await services.store.claim(effectIdentity);
  if (claim === null) return "unclaimed";
  const nowMs = services.nowMs();
  const deadlines = claim.state.state === "not_started" ? services.deadlines(nowMs) : claim.state;
  const prepared = prepareVideoStreamCopy({
    current: claim.state,
    identity: claim.identity,
    nowMs,
    ...deadlines,
  });
  if (prepared.copyAllowed) {
    claim = await services.store.transition(claim, prepared.next, false);
    if (claim === null) return "stale";
    try {
      await services.transport.copy({
        identity: claim.identity,
        sealedSourceRef: claim.sealedSourceRef,
        requireSignedURLs: true,
        downloadsEnabled: false,
      });
    } catch {
      // Acceptance may have happened. Retain sending and its deadlines, never recopy.
      // Lease expiry recovers both lost responses and crashes after persisted intent.
      return "retry";
    }
  }
  let next = claim.state;
  if (!["ready", "failed", "reconciliation_required"].includes(next.state)) {
    let matches: readonly VideoStreamObservation[];
    try {
      matches = await services.transport.observe(claim.identity);
    } catch {
      // Unavailable evidence is not an empty lookup or a terminal encoding failure.
      return "retry";
    }
    next = observeVideoStreamIngest({ current: next, matches, nowMs: services.nowMs() });
  }
  if ((await services.store.transition(claim, next, true)) === null) return "stale";
  if (next.state === "ready") return "ready";
  if (next.state === "failed" || next.state === "reconciliation_required") return "failed";
  return "pending";
}
