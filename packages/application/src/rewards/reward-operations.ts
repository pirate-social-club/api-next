import { Data } from "effect";

/** A deliberate admission hold, not a storage incident or a reverted transaction. */
export class RewardOperationsPaused extends Data.TaggedError("RewardOperationsPaused")<{
  readonly reason: "paused";
}> {}
