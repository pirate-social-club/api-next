/** The isolated rehearsal target, bound once and read by everything that
 * touches it.
 *
 * Approval names the intended source backup, the isolated branch and the
 * limits; it cannot name the branch identifier, because the provider assigns
 * that at creation. So the identifier is bound after creation and before any
 * destructive step, from one place, rather than being written separately into
 * each script and drifting. Hardcoding it in two files is how a run comes to
 * assert against a branch nobody created for it.
 *
 * This narrows nothing that was checked before. The provider identity checks
 * stay exactly as they were; they now compare against a bound target instead of
 * a literal.
 */
const ID = /^[a-z0-9]{6,32}$/u;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;

/** Live staging. The rehearsal target is never this branch, and saying so here
 * means the refusal does not depend on a provider round trip. */
export const STAGING_MAIN_BRANCH_ID = "syu03e00w3ux";
export const STAGING_MAIN_BRANCH_NAME = "main";

export const REHEARSAL_TARGET_VARIABLES = Object.freeze({
  branchId: "STAGING_REHEARSAL_BRANCH_ID",
  branchName: "STAGING_REHEARSAL_BRANCH_NAME",
  backupId: "STAGING_REHEARSAL_BACKUP_ID",
  dataDigest: "STAGING_REHEARSAL_DATA_SHA256",
});

export type RehearsalTarget = Readonly<{
  branchId: string;
  branchName: string;
  backupId: string;
  dataDigest: string;
}>;

/** Refuses rather than defaulting. An unbound target must stop the run, not
 * silently select the last branch someone happened to use. */
export function readRehearsalTarget(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RehearsalTarget {
  const read = (key: string, pattern: RegExp) => {
    const value = env[key]?.trim();
    if (!value) throw new Error(`rehearsal_target_unbound:${key}`);
    if (!pattern.test(value)) throw new Error(`rehearsal_target_invalid:${key}`);
    return value;
  };
  const target = {
    branchId: read(REHEARSAL_TARGET_VARIABLES.branchId, ID),
    branchName: read(REHEARSAL_TARGET_VARIABLES.branchName, NAME),
    backupId: read(REHEARSAL_TARGET_VARIABLES.backupId, ID),
    dataDigest: read(REHEARSAL_TARGET_VARIABLES.dataDigest, DIGEST),
  };
  if (target.branchId === target.backupId) throw new Error("rehearsal_target_identifiers_collide");
  // The exercise is destructive. Binding it to live staging is the one mistake
  // that cannot be undone by deleting a branch afterwards.
  if (target.branchId === STAGING_MAIN_BRANCH_ID || target.branchName === STAGING_MAIN_BRANCH_NAME)
    throw new Error("rehearsal_target_is_live_staging");
  return Object.freeze(target);
}

let snapshot: RehearsalTarget | undefined;
/** The one snapshot every consumer shares. Two independent reads would let the
 * runner and the inventory disagree about which branch they are exercising,
 * which is the defect this module exists to remove. */
export function rehearsalTarget(): RehearsalTarget {
  snapshot ??= readRehearsalTarget();
  return snapshot;
}

/** Ties the bound branch to the approved backup, using the provider's own
 * account of what that backup restored. A branch that agrees about its source
 * branch may still have come from a different backup. */
export function assertRestoredFromApprovedBackup(
  target: RehearsalTarget,
  observation: {
    readonly backup_id: string;
    readonly source_branch_id: string;
    readonly restored_branch_ids: readonly string[];
  },
) {
  if (observation.backup_id !== target.backupId)
    throw new Error("rehearsal_target_backup_mismatch");
  if (observation.source_branch_id !== STAGING_MAIN_BRANCH_ID)
    throw new Error("rehearsal_target_backup_source_mismatch");
  if (!observation.restored_branch_ids.includes(target.branchId))
    throw new Error("rehearsal_target_not_restored_from_backup");
}

/** The provider's own account of the branch, compared against the bound target.
 * Every field that was compared before is still compared; the named failures
 * exist so a refusal says which fact disagreed. */
export function assertRehearsalBranchIdentity(
  target: RehearsalTarget,
  databaseId: string,
  sourceId: string,
  observed: {
    readonly database: { id?: unknown; kind?: unknown };
    readonly branch: {
      id?: unknown;
      name?: unknown;
      ready?: unknown;
      state?: unknown;
      restored_from_branch?: { id?: unknown } | null;
    };
    readonly access: {
      branch?: { id?: unknown } | null;
      default?: unknown;
      access_host_url?: unknown;
    };
  },
) {
  const { database, branch, access } = observed;
  if (database.id !== databaseId || database.kind !== "postgresql")
    throw new Error("rehearsal_target_database_mismatch");
  if (branch.id !== target.branchId || branch.name !== target.branchName)
    throw new Error("rehearsal_target_branch_mismatch");
  if (branch.ready !== true || branch.state !== "ready")
    throw new Error("rehearsal_target_branch_not_ready");
  if (branch.restored_from_branch?.id !== sourceId)
    throw new Error("rehearsal_target_source_mismatch");
  if (
    access.branch?.id !== target.branchId ||
    access.default !== true ||
    typeof access.access_host_url !== "string"
  )
    throw new Error("rehearsal_target_access_mismatch");
  return access.access_host_url;
}
