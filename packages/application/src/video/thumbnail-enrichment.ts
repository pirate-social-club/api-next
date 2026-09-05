/** Exact publication/poster facts loaded by the store, never from queue payload. */
export interface VideoThumbnailClaim {
  readonly effectIdentity: string;
  /** Fresh for each acquisition, including reacquisition by the same worker. */
  readonly leaseToken: string;
  readonly postId: string;
  readonly communityId: string;
  readonly artifactRef: string;
  readonly sha256: string;
  readonly sourceSha256: string;
  readonly policyRevision: string;
}

export interface VideoThumbnailServices {
  readonly store: {
    claim(effectIdentity: string): Promise<VideoThumbnailClaim | null>;
    complete(claim: VideoThumbnailClaim, state: "ready" | "failed"): Promise<boolean>;
  };
  /** Observe the existing sealed JPEG. This operation never writes another copy. */
  verify(claim: VideoThumbnailClaim): Promise<"available" | "missing" | "invalid">;
}

/** One bounded observation; orchestration owns retry timing and expired-lease recovery. */
export async function consumeVideoThumbnail(
  effectIdentity: string,
  services: VideoThumbnailServices,
): Promise<"unclaimed" | "retry" | "stale" | "ready" | "failed"> {
  const claim = await services.store.claim(effectIdentity);
  if (claim === null) return "unclaimed";
  let observation: Awaited<ReturnType<VideoThumbnailServices["verify"]>>;
  try {
    observation = await services.verify(claim);
  } catch {
    // Unavailable storage is not evidence of a missing artifact. Keep the lease
    // for expiry recovery; do not persist an invented terminal observation.
    return "retry";
  }
  const state = observation === "available" ? "ready" : "failed";
  if (!(await services.store.complete(claim, state))) return "stale";
  return state;
}
