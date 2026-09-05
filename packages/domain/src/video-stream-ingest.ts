/** Durable decisions for one sealed source; the interpreter owns I/O and CAS. */
export type VideoStreamIdentity = Readonly<{
  operationId: string;
  creator: string;
  sourceSha256: string;
}>;

type PendingAttempt = Readonly<{
  identity: VideoStreamIdentity;
  acceptanceDeadlineMs: number;
  encodingDeadlineMs: number;
}>;

export type VideoStreamIngestState =
  | Readonly<{ state: "not_started" }>
  | (PendingAttempt & Readonly<{ state: "sending" }>)
  | (PendingAttempt & Readonly<{ state: "bound"; providerVideoId: string }>)
  | (PendingAttempt & Readonly<{ state: "ready"; providerVideoId: string }>)
  | (PendingAttempt &
      Readonly<{
        state: "reconciliation_required";
        reason: "acceptance_unknown" | "identity_mismatch" | "multiple_matches" | "unsafe_delivery";
      }>)
  | (PendingAttempt &
      Readonly<{
        state: "failed";
        providerVideoId: string;
        reason: "encoding_failed" | "encoding_timeout";
      }>);

export type VideoStreamObservation = Readonly<{
  providerVideoId: string;
  creator: string;
  sourceSha256: string;
  encoding: "pending" | "ready" | "error";
  requireSignedURLs: boolean;
  downloadsEnabled: boolean;
}>;

const sameIdentity = (left: VideoStreamIdentity, right: VideoStreamIdentity): boolean =>
  left.operationId === right.operationId &&
  left.creator === right.creator &&
  left.sourceSha256 === right.sourceSha256;

function validateIdentity(identity: VideoStreamIdentity): void {
  if (
    !identity.operationId.trim() ||
    identity.operationId.trim() !== identity.operationId ||
    !/^[A-Za-z0-9_-]{1,64}$/u.test(identity.creator) ||
    !/^[a-f0-9]{64}$/u.test(identity.sourceSha256)
  ) {
    throw new Error("Invalid Stream ingest identity");
  }
}

/** Only the successful durable CAS of this transition grants one copy call. */
export function prepareVideoStreamCopy(
  input: Readonly<{
    current: VideoStreamIngestState;
    identity: VideoStreamIdentity;
    nowMs: number;
    acceptanceDeadlineMs: number;
    encodingDeadlineMs: number;
  }>,
): Readonly<{ next: VideoStreamIngestState; copyAllowed: boolean }> {
  validateIdentity(input.identity);
  if (input.current.state !== "not_started") {
    if (!sameIdentity(input.current.identity, input.identity)) {
      throw new Error("Stream ingest identity is immutable");
    }
    return { next: input.current, copyAllowed: false };
  }
  if (
    ![input.nowMs, input.acceptanceDeadlineMs, input.encodingDeadlineMs].every(
      Number.isSafeInteger,
    ) ||
    input.nowMs < 0 ||
    input.acceptanceDeadlineMs <= input.nowMs ||
    input.encodingDeadlineMs < input.acceptanceDeadlineMs
  ) {
    throw new Error("Invalid Stream ingest deadlines");
  }
  return {
    next: {
      state: "sending",
      identity: input.identity,
      acceptanceDeadlineMs: input.acceptanceDeadlineMs,
      encodingDeadlineMs: input.encodingDeadlineMs,
    },
    copyAllowed: true,
  };
}

/** Observations never authorize a second copy, including empty provider lookups. */
export function observeVideoStreamIngest(
  input: Readonly<{
    current: VideoStreamIngestState;
    matches: readonly VideoStreamObservation[];
    nowMs: number;
  }>,
): VideoStreamIngestState {
  const current = input.current;
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0)
    throw new Error("Invalid observation time");
  if (current.state === "not_started") throw new Error("Persist Stream intent before observation");
  if (current.state === "failed" || current.state === "reconciliation_required") return current;
  const pending: PendingAttempt = {
    identity: current.identity,
    acceptanceDeadlineMs: current.acceptanceDeadlineMs,
    encodingDeadlineMs: current.encodingDeadlineMs,
  };
  const reconcile = (
    reason: Extract<VideoStreamIngestState, { state: "reconciliation_required" }>["reason"],
  ): VideoStreamIngestState => ({ ...pending, state: "reconciliation_required", reason });
  if (input.matches.length > 1) return reconcile("multiple_matches");
  const match = input.matches[0];
  if (!match) {
    // A missing previously observed asset is not permission to import again.
    if (current.state !== "sending") return reconcile("identity_mismatch");
    return input.nowMs >= current.acceptanceDeadlineMs ? reconcile("acceptance_unknown") : current;
  }
  if (
    !match.providerVideoId.trim() ||
    match.providerVideoId.trim() !== match.providerVideoId ||
    match.creator !== current.identity.creator ||
    match.sourceSha256 !== current.identity.sourceSha256 ||
    (current.state !== "sending" && match.providerVideoId !== current.providerVideoId)
  ) {
    return reconcile("identity_mismatch");
  }
  if (!match.requireSignedURLs || match.downloadsEnabled) return reconcile("unsafe_delivery");
  const bound = { ...pending, providerVideoId: match.providerVideoId };
  if (match.encoding === "error") return { ...bound, state: "failed", reason: "encoding_failed" };
  if (match.encoding === "ready") return { ...bound, state: "ready" };
  if (input.nowMs >= current.encodingDeadlineMs)
    return { ...bound, state: "failed", reason: "encoding_timeout" };
  return { ...bound, state: "bound" };
}
