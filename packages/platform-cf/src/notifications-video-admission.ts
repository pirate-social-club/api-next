import type { ControlPlaneDb } from "@pirate/application";
import { Effect, Schema } from "effect";
import { makeNotificationDeliveryStoreFromDb } from "./notification-delivery-repository.ts";

const sha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
export const NotificationsVideoAdmissionPlan = Schema.Struct({
  contract_sha256: Schema.Literal(
    "36e74a67ee280677436ff0d7ea7d1fd6243db3dc9432645a23a2402e2d03ec19",
  ),
  plan_sha256: sha,
  alias_run_id: Schema.String.check(
    Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u),
  ),
  paired_solid_sha256: sha,
  cutover_source_sha256: sha,
});
export type NotificationsVideoAdmissionPlan = typeof NotificationsVideoAdmissionPlan.Type;

export function makeNotificationsVideoAdmissionStore(db: ControlPlaneDb["Service"]) {
  return {
    // One existing 50-fact recovery pass. Repeated invocations are explicit;
    // this tool must not drain or create aliases while holding cutover locks.
    drain: makeNotificationDeliveryStoreFromDb(db).recover,
    startAudit: Effect.fn("NotificationsVideoAdmission.startAudit")(function* (input: {
      runId: string;
      planSha256: string;
      mode: "inventory" | "materialize";
    }) {
      return yield* db.withTransaction((tx) =>
        tx.execute<Record<string, unknown>>({
          label: "notifications.video.audit.start",
          text: "SELECT start_video_alias_audit_v1($1::uuid,$2,$3)",
          values: [input.runId, input.planSha256, input.mode],
          readonly: false,
        }),
      );
    }),
    auditBatch: Effect.fn("NotificationsVideoAdmission.auditBatch")(function* (input: {
      runId: string;
      planSha256: string;
    }) {
      return yield* db.withTransaction((tx) =>
        Effect.gen(function* () {
          yield* tx.execute<Record<string, unknown>>({
            label: "notifications.video.audit.deadline",
            text: "SET LOCAL lock_timeout='250ms'",
            values: [],
            readonly: false,
          });
          return yield* tx.execute<Record<string, unknown>>({
            label: "notifications.video.audit.batch",
            text: "SELECT process_video_alias_audit_batch_v1($1::uuid,$2) AS examined",
            values: [input.runId, input.planSha256],
            readonly: false,
          });
        }),
      );
    }),
    cutover: Effect.fn("NotificationsVideoAdmission.cutover")(function* (
      untrusted: unknown,
      source: string,
    ) {
      const plan = yield* Schema.decodeUnknownEffect(NotificationsVideoAdmissionPlan, {
        onExcessProperty: "error",
      })(untrusted);
      const bytes = new Uint8Array(
        yield* Effect.tryPromise(() =>
          crypto.subtle.digest("SHA-256", new TextEncoder().encode(source)),
        ),
      );
      const actual = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
      if (actual !== plan.cutover_source_sha256)
        throw new Error("Reviewed cutover source mismatch");
      return yield* db.withTransaction((tx) =>
        Effect.gen(function* () {
          yield* tx.execute<Record<string, unknown>>({
            label: "notifications.video.cutover.deadlines",
            text: "SET LOCAL lock_timeout='250ms'; SET LOCAL statement_timeout='5s'",
            values: [],
            readonly: false,
          });
          // FIRST relation lock; no fact/recipient/source locks precede it.
          yield* tx.execute<Record<string, unknown>>({
            label: "notifications.video.cutover.exclude",
            text: "LOCK TABLE content_publication_outbox IN EXCLUSIVE MODE NOWAIT",
            values: [],
            readonly: false,
          });
          yield* tx.execute<Record<string, unknown>>({
            label: "notifications.video.cutover.namespace",
            text: "LOCK TABLE post_slug_aliases IN SHARE ROW EXCLUSIVE MODE NOWAIT",
            values: [],
            readonly: false,
          });
          const prior = yield* tx.execute<Record<string, unknown>>({
            label: "notifications.video.cutover.reconcile",
            text: "SELECT plan_sha256,alias_run_id::text,paired_solid_sha256,cutover_source_sha256 FROM video_notification_cutovers_v1 WHERE singleton",
            values: [],
            readonly: true,
          });
          if (prior.rows.length > 0) {
            const row = prior.rows[0];
            if (
              prior.rows.length !== 1 ||
              row?.plan_sha256 !== plan.plan_sha256 ||
              row?.alias_run_id !== plan.alias_run_id ||
              row?.paired_solid_sha256 !== plan.paired_solid_sha256 ||
              row?.cutover_source_sha256 !== actual
            )
              throw new Error("Existing video cutover receipt differs; reconciliation required");
            return { alreadyCommitted: true };
          }
          const ready = yield* tx.execute<Record<string, unknown>>({
            label: "notifications.video.cutover.ready",
            text: `SELECT
          NOT EXISTS(SELECT 1 FROM content_publication_outbox WHERE event_type='comment_notification' AND NOT inbox_delivery_recorded) AS drained,
          EXISTS(SELECT 1 FROM video_alias_audit_runs_v1 run WHERE run_id=$1::uuid AND plan_sha256=$2 AND mode='materialize' AND complete
            AND NOT EXISTS(SELECT 1 FROM video_alias_audit_items_v1 item WHERE item.run_id=run.run_id AND outcome NOT IN('inserted','already-exact'))) AS aliases_ready,
          (SELECT count(*)=2 FROM pg_trigger WHERE tgrelid='media_post_submissions'::regclass AND tgenabled='O'
            AND tgname IN('media_video_terminal_exact_alias','media_video_fixed_publication_identity')) AS producer_fenced`,
            values: [plan.alias_run_id, plan.plan_sha256],
            readonly: true,
          });
          const row = ready.rows[0];
          if (
            ready.rows.length !== 1 ||
            row?.drained !== true ||
            row?.aliases_ready !== true ||
            row?.producer_fenced !== true
          )
            throw new Error(
              "Video cutover prerequisites incomplete; resume bounded work outside exclusion",
            );
          yield* tx.execute<Record<string, unknown>>({
            label: "notifications.video.cutover.install",
            text: source,
            values: [],
            readonly: false,
          });
          yield* tx.execute<Record<string, unknown>>({
            label: "notifications.video.cutover.receipt",
            text: `INSERT INTO video_notification_cutovers_v1(plan_sha256,alias_run_id,paired_solid_sha256,cutover_source_sha256) VALUES($1,$2::uuid,$3,$4)`,
            values: [plan.plan_sha256, plan.alias_run_id, plan.paired_solid_sha256, actual],
            readonly: false,
          });
          return { alreadyCommitted: false };
        }),
      );
      // Unknown commit errors deliberately propagate unchanged. No blind retry.
    }),
  };
}
