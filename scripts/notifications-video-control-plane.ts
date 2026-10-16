/** Parent-operated only. No import side effects; never imported by a Worker. */
import { ControlPlaneDb } from "@pirate/application";
import { Effect, Schema } from "effect";
import {
  makeNotificationsVideoAdmissionStore,
  NotificationsVideoAdmissionPlan,
} from "../packages/platform-cf/src/notifications-video-admission.ts";
import { makeDirectPostgresControlPlaneLayer } from "../packages/platform-cf/src/postgres.ts";

export async function runNotificationsVideoControlPlane(
  action: string,
  planPath: string,
  connectionString: string,
) {
  const plan = Schema.decodeUnknownSync(NotificationsVideoAdmissionPlan, {
    onExcessProperty: "error",
  })(await Bun.file(planPath).json());
  if (
    !["start-inventory", "start-materialize", "batch", "status", "drain", "cutover"].includes(
      action,
    )
  )
    throw new Error("Unknown video admission action");
  const source = await Bun.file(
    new URL("../db/postgres/candidates/notifications-video-cutover.sql", import.meta.url),
  ).text();
  return Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* ControlPlaneDb;
      const store = makeNotificationsVideoAdmissionStore(db);
      if (action === "drain") return yield* store.drain();
      if (action === "cutover") return yield* store.cutover(plan, source);
      if (action === "start-inventory" || action === "start-materialize")
        return yield* store.startAudit({
          runId: plan.alias_run_id,
          planSha256: plan.plan_sha256,
          mode: action === "start-inventory" ? "inventory" : "materialize",
        });
      if (action === "batch")
        return yield* store.auditBatch({ runId: plan.alias_run_id, planSha256: plan.plan_sha256 });
      return yield* db.execute({
        label: "notifications.video.audit.status",
        text: `SELECT run.run_id::text,run.mode,run.complete,run.cursor_created_at,run.cursor_post_id,item.outcome,count(item.submission_id)::int AS items
      FROM video_alias_audit_runs_v1 run LEFT JOIN video_alias_audit_items_v1 item ON item.run_id=run.run_id
      WHERE run.run_id=$1::uuid AND run.plan_sha256=$2 GROUP BY run.run_id,item.outcome ORDER BY item.outcome`,
        values: [plan.alias_run_id, plan.plan_sha256],
        readonly: true,
      });
    }).pipe(Effect.provide(makeDirectPostgresControlPlaneLayer(connectionString))),
  );
}

if (import.meta.main) {
  const [action, planPath] = Bun.argv.slice(2);
  const connection = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
  // This handback authorizes disposable proof only. Live execution needs its
  // separately reviewed custody/connection runner; it can reuse this store.
  const url = connection === undefined ? null : new URL(connection);
  const searchPath = url?.searchParams.get("options") ?? "";
  if (
    !action ||
    !planPath ||
    url?.hostname !== "127.0.0.1" ||
    url.port !== "54388" ||
    !/^-c search_path=api_next_notifications_[a-z0-9_]+$/u.test(searchPath)
  )
    throw new Error("Assigned disposable Notifications fixture and explicit plan/action required");
  const result = await runNotificationsVideoControlPlane(action, planPath, connection as string);
  console.log(JSON.stringify(result));
}
