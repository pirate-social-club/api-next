import { Data } from "effect";

/** A deliberate admission hold, not a storage incident or a reverted transaction. */
export class RewardOperationsPaused extends Data.TaggedError("RewardOperationsPaused")<{
  readonly reason: "paused";
}> {}

/**
 * The database could not say whether a signature or a send is still authorized.
 * Nothing is signed or sent, and unlike a deliberate hold it is an incident.
 */
export class RewardRunAuthorityUnavailable extends Data.TaggedError(
  "RewardRunAuthorityUnavailable",
)<{
  readonly reason: "unavailable";
}> {}
