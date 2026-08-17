import { planPublicProfileBackfill } from "./public-profile-backfill-planner";
import { makePublicProfileTargetSnapshot } from "./public-profile-backfill-target";
import type {
  PublicProfileBackfillDatabase,
  PublicProfileBackfillPlan,
  PublicProfileBackfillReport,
  PublicProfileBackfillRunResult,
  PublicProfileBackfillTransaction,
  PublicProfileTargetHandle,
  PublicProfileTargetSnapshot,
  PublicProfileTargetUser,
} from "./public-profile-backfill-types";

const setSerializableSql = "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE";
const insertSql = `INSERT INTO public_handle_index
  (handle_id, label_normalized, label_display, status, owner_user_id, redirect_target_handle_id)
  VALUES ($1, $2, $3, $4, $5, $6)`;

export async function readPublicProfileBackfillTargetSnapshot(
  transaction: PublicProfileBackfillTransaction,
  capturedAt = new Date().toISOString(),
): Promise<PublicProfileTargetSnapshot> {
  const users = await transaction.query<PublicProfileTargetUser>(
    "SELECT user_id, status FROM users ORDER BY user_id ASC FOR UPDATE",
  );
  const handles = await transaction.query<PublicProfileTargetHandle>(
    "SELECT handle_id, label_normalized, label_display, status, owner_user_id, redirect_target_handle_id FROM public_handle_index ORDER BY handle_id ASC FOR UPDATE",
  );
  return makePublicProfileTargetSnapshot({
    captured_at: capturedAt,
    users: users.rows,
    handles: handles.rows,
  });
}

const writeBackfillPlan = async (
  plan: PublicProfileBackfillPlan,
  transaction: PublicProfileBackfillTransaction,
): Promise<number> => {
  for (const operation of plan.operations) {
    await transaction.query(insertSql, [
      operation.api_next_handle_id,
      operation.row.label_normalized,
      operation.row.label_display,
      operation.row.status,
      operation.api_next_owner_user_id,
      operation.api_next_redirect_target_handle_id,
    ]);
  }
  return plan.operations.length;
};

export async function applyPublicProfileBackfillPlan(
  plan: PublicProfileBackfillPlan,
  transaction: PublicProfileBackfillTransaction,
): Promise<Readonly<{ readonly applied: number; readonly report: PublicProfileBackfillReport }>> {
  if (plan.report.counts.errors !== 0) throw new Error("public-profile-backfill-plan-has-errors");
  await transaction.query(setSerializableSql);
  const lockedTarget = await readPublicProfileBackfillTargetSnapshot(transaction);
  const lockedPlan = planPublicProfileBackfill(plan.manifest, lockedTarget);
  if (lockedPlan.report.counts.errors !== 0)
    throw new Error("public-profile-backfill-target-changed");
  if (lockedPlan.report.plan_sha256 !== plan.report.plan_sha256)
    throw new Error("public-profile-backfill-plan-stale");
  const applied = await writeBackfillPlan(lockedPlan, transaction);
  return { applied, report: lockedPlan.report };
}

export async function runPublicProfileBackfill(
  input:
    | { readonly manifest: unknown; readonly mode: "dry-run"; readonly target: unknown }
    | {
        readonly manifest: unknown;
        readonly mode: "apply";
        readonly database: PublicProfileBackfillDatabase;
      },
): Promise<PublicProfileBackfillRunResult> {
  if (input.mode === "dry-run") {
    const plan = planPublicProfileBackfill(input.manifest, input.target);
    return { mode: "dry-run", report: plan.report, applied: 0 };
  }
  return input.database.withTransaction(async (transaction) => {
    await transaction.query(setSerializableSql);
    const target = await readPublicProfileBackfillTargetSnapshot(transaction);
    const plan = planPublicProfileBackfill(input.manifest, target);
    if (plan.report.counts.errors !== 0) throw new Error("public-profile-backfill-plan-has-errors");
    const applied = await writeBackfillPlan(plan, transaction);
    return { mode: "apply", report: plan.report, applied };
  });
}
