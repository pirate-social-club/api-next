// Private jobs composition. One registry writer, bounded serial source stages.
import { Effect } from "effect";

type AccountClosedRecoverySummary = Readonly<{
  claimed: number;
  recovered: number;
  storageFailures: number;
  fenced: number;
}>;
type GuestClosedRecoverySummary = Readonly<{
  examined: number;
  completed: number;
  pending: number;
  skipped: number;
}>;
type ResourceRemainderRelease =
  | Readonly<{ state: "idle" }>
  | Readonly<{ state: "released"; terminalState: "completed" | "expired" }>;
export interface StudySourceRecoveryStages {
  readonly account: Effect.Effect<AccountClosedRecoverySummary, unknown>;
  /** Financial composition only; actual original Account marker reconciliation,
   * no grade production. Failure/unknown stops before Guest/expiry/settlement. */
  readonly accountOriginalAdmissionReconciliation?: Effect.Effect<unknown, unknown>;
  readonly guest?: Readonly<{
    closed: Effect.Effect<GuestClosedRecoverySummary, unknown>;
    /** Required in the dedicated financial composition; absent retains learning
     * practice-only graph behavior. No uncertainty is caught as successful. */
    capturedChoices?: Effect.Effect<readonly unknown[], unknown>;
    releaseNext: () => Effect.Effect<ResourceRemainderRelease, unknown>;
    maximumReleases: number;
    ephemeralCleanup: Effect.Effect<void, unknown>;
  }>;
}
/** No provider, browser credential, current learning lease or clock is
 * supplied here. Cleanup is an explicitly composed bounded exact-key DELETE
 * effect. SQL or storage uncertainty stops this tick without an immediate retry.
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
  if (stages.accountOriginalAdmissionReconciliation !== undefined)
    yield* stages.accountOriginalAdmissionReconciliation;
  if (stages.guest === undefined) return { account, guest: null, released: 0 };
  const guest = yield* stages.guest.closed;
  if (stages.guest.capturedChoices !== undefined) yield* stages.guest.capturedChoices;
  let released = 0;
  for (let i = 0; i < stages.guest.maximumReleases; i++) {
    const result = yield* stages.guest.releaseNext();
    if (result.state === "idle") break;
    released++;
  }
  yield* stages.guest.ephemeralCleanup;
  return { account, guest, released };
});
