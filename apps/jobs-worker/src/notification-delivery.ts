import { type AlertCollector, ControlPlaneDb } from "@pirate/application";
import type { AlertSink } from "@pirate/platform-cf";
import { makeNotificationDeliveryStoreFromDb } from "@pirate/platform-cf/notification-delivery-repository";
import { Effect } from "effect";
import { defaultRetrySchedule, type JobDeclaration } from "./registry.ts";

export function makeNotificationDeliveryJob(
  sink: AlertSink,
): JobDeclaration<unknown, ControlPlaneDb | AlertCollector> {
  return {
    name: "notifications.recover-publications",
    lane: "notification-delivery",
    schedule: "* * * * *",
    timeout: "45 seconds",
    retry: defaultRetrySchedule,
    expectedFailures: [
      "InternalError",
      "ControlPlaneAcquireFailed",
      "ControlPlaneOperationTimedOut",
      "ControlPlaneStatementFailed",
    ],
    severity: {
      expectedFailure: {
        InternalError: "medium",
        ControlPlaneAcquireFailed: "medium",
        ControlPlaneOperationTimedOut: "medium",
        ControlPlaneStatementFailed: "medium",
      },
      timeout: "high",
      transactionOutcomeUnknown: "high",
      defect: "high",
    },
    reads: [
      "postgres:content_publication_outbox",
      "postgres:text_content_submissions",
      "postgres:notification_publication_deliveries",
      "postgres:users",
      "postgres:comments",
      "postgres:posts",
      "postgres:communities",
      "postgres:community_memberships",
      "postgres:account_age_verification_current",
      "postgres:age_verification_requirement_states",
      "postgres:age_verification_ceremony_attempts",
      "postgres:proof_sessions",
      "postgres:assertions",
      "postgres:evidence_receipts",
      "postgres:assertion_bindings",
      "postgres:active_subject_key_bindings",
      "postgres:assertion_revalidation_events",
    ],
    writes: [
      "postgres:notification_inbox",
      "postgres:notification_publication_deliveries",
      "postgres:content_publication_outbox",
    ],
    alertSink: sink,
    run: Effect.gen(function* () {
      yield* makeNotificationDeliveryStoreFromDb(yield* ControlPlaneDb).recover();
    }),
  };
}
