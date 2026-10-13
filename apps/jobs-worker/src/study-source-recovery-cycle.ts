// Private jobs composition. One registry writer, bounded serial source stages.
import { Effect } from "effect";
export type AccountClosedRecoverySummary = Readonly<{
  claimed: number;
  recovered: number;
  storageFailures: number;
  fenced: number;
}>;
export type GuestClosedRecoverySummary = Readonly<{
  examined: number;
  completed: number;
  pending: number;
  skipped: number;
}>;
export type ResourceRemainderRelease =
  | Readonly<{ state: "idle" }>
  | Readonly<{ state: "released"; terminalState: "completed" | "expired" }>;
export interface StudySourceRecoveryStages {
  readonly account: Effect.Effect<AccountClosedRecoverySummary, unknown>;
  readonly guest?: Readonly<{
    closed: Effect.Effect<GuestClosedRecoverySummary, unknown>;
    releaseNext: () => Effect.Effect<ResourceRemainderRelease, unknown>;
    maximumReleases: number;
  }>;
}
/** No provider, bucket, browser credential, current learning lease or clock is
 * supplied here. Unknown SQL stops this tick; the runner does not retry it.
 * Every SDK leaf finishes its own bounded native transaction before returning.
 */
export const runStudySourceRecoveryCycle = Effect.fn("StudySourceRecoveryCycle.run")(function* (
  stages: StudySourceRecoveryStages,
) {
  if (
    stages.guest !== undefined &&
    (!Number.isInteger(stages.guest.maximumReleases) ||
      stages.guest.maximumReleases < 1 ||
      stages.guest.maximumReleases > 8)
  )
    throw new Error("Reviewed expiry maximum1..8 required");
  const account = yield* stages.account;
  if (stages.guest === undefined) return { account, guest: null, released: 0 };
  const guest = yield* stages.guest.closed;
  let released = 0;
  for (let i = 0; i < stages.guest.maximumReleases; i++) {
    const result = yield* stages.guest.releaseNext();
    if (result.state === "idle") break;
    released++;
  }
  return { account, guest, released };
});
