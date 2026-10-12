// Jobs-worker private factory only: NOT registered, scheduled or enabled here.
import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import type { AlertSink } from "@pirate/platform-cf";
import { makeControlPlaneGuestStudyResourceExpiry } from "@pirate/platform-cf/guest-study-resource-expiry";
import { type Duration, Effect, Layer, Schedule } from "effect";
import { JobContext, type JobDeclaration } from "./registry.ts";
export function makeGuestStudyResourceExpiryJob(
  input: Readonly<{
    alertSink: AlertSink;
    schedule: string;
    timeout: Duration.Input;
    maximumReleases: number;
  }>,
): JobDeclaration<ControlPlaneError, ControlPlaneDb> {
  if (
    !Number.isInteger(input.maximumReleases) ||
    input.maximumReleases < 1 ||
    input.maximumReleases > 8
  )
    throw new Error("Reviewed bounded expiry batch required");
  const run = Effect.fn("GuestStudyResourceExpiryJob.run")(function* () {
    const db = yield* ControlPlaneDb;
    const store = makeControlPlaneGuestStudyResourceExpiry(Layer.succeed(ControlPlaneDb, db));
    for (let released = 0; released < input.maximumReleases; released++) {
      // EACH call owns/acknowledges ONE short transaction. No multi-owner lock
      // inversion, retained global transaction, provider/R2 IO or unknown retry.
      const result = yield* store.releaseNext();
      if (result.state === "idle") break;
    }
  })().pipe(
    Effect.onInterrupt(() =>
      JobContext.use((context) => Effect.sync(context.adapterSafety.markAbortedOrFenced)),
    ),
  );
  return {
    name: "guest-study.release-expired-resource-remainders",
    lane: "learner-audio-maintenance",
    schedule: input.schedule,
    timeout: input.timeout,
    retry: Schedule.recurs(0),
    expectedFailures: [
      "ControlPlaneAcquireFailed",
      "ControlPlaneOperationTimedOut",
      "ControlPlaneStatementFailed",
      "ControlPlaneTransactionOutcomeUnknown",
    ],
    severity: {
      expectedFailure: {
        ControlPlaneAcquireFailed: "medium",
        ControlPlaneOperationTimedOut: "medium",
        ControlPlaneStatementFailed: "high",
        ControlPlaneTransactionOutcomeUnknown: "high",
      },
      timeout: "high",
      transactionOutcomeUnknown: "high",
      defect: "high",
    },
    reads: [
      "postgres:study_sessions_v2",
      "postgres:guest_participation_operations",
      "postgres:guest_resource_session_reservations",
      "postgres:guest_resource_release_receipts",
      "postgres:guest_resource_edge_locks",
      "postgres:participation_owners",
      "postgres:guest_empty_owner_aliases",
    ],
    writes: [
      "postgres:guest_resource_session_reservations",
      "postgres:guest_resource_release_receipts",
    ],
    alertSink: input.alertSink,
    requiresAdapterSafety: true,
    run,
  };
}
