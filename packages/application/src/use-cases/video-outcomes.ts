import { InternalError, type VideoOutcomeClaimV1, type VideoOutcomeV1 } from "@pirate/contracts";
import { Effect } from "effect";
import type { ControlPlaneError } from "../ports.ts";

export interface VideoOutcomeStore {
  /** A read never grants permission. No successful claim may be replayed. */
  readonly claim: (accountId: string) => Effect.Effect<VideoOutcomeV1 | null, ControlPlaneError>;
}

export const claimVideoOutcome = Effect.fn("claimVideoOutcome")(function* (
  accountId: string,
  store: VideoOutcomeStore,
): Effect.fn.Return<VideoOutcomeClaimV1, InternalError> {
  const outcome = yield* store
    .claim(accountId)
    .pipe(Effect.mapError(() => new InternalError({ message: "Video outcome claim unavailable" })));
  return outcome === null
    ? { object: "video_outcome_claim", display_permission: false, outcome: null }
    : { object: "video_outcome_claim", display_permission: true, outcome };
});
