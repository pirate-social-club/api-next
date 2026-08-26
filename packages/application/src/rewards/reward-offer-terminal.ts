import { Data, type Effect } from "effect";

export class RewardOfferTerminalStorageFailed extends Data.TaggedError(
  "RewardOfferTerminalStorageFailed",
)<{
  readonly reason: "constraint" | "invalid-row" | "outcome-unknown" | "unavailable";
}> {}

export type RewardOfferTerminalResult = Readonly<{
  offerId: string;
  status: "expired" | "ended";
  legIds: readonly string[];
  terminalAt: string;
}>;

export interface RewardOfferTerminalStore {
  readonly closeExpired: (
    limit: number,
  ) => Effect.Effect<readonly RewardOfferTerminalResult[], RewardOfferTerminalStorageFailed>;
}
