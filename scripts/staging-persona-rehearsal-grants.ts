import type { Client } from "pg";
import { readKaraokeRuntimeGrantDigest } from "./staging-karaoke-release-database.ts";
import {
  compileApprovedStagingPrivileges,
  verifyApprovedStagingRuntime,
} from "./staging-persona-approved-privileges.ts";
import { restoreReviewedResetGrants } from "./staging-persona-grant-catalog.ts";

export type RehearsalGrantReceipt = {
  readonly reviewed_grants: number;
  /** Readback fact for the resulting schema. Not an approval: the window's
   * release plan has to carry this digest as a reviewed input. */
  readonly derived_reviewed_grant_digest: string;
  readonly runtime_connect: true;
};

/** Restores the reviewed grant vocabulary against the schema the run just
 * upgraded and returns the resulting runtime-reachable digest. It mirrors the
 * release database surface's restore-and-verify order without asserting a
 * reviewed digest, because no digest exists for the reviewed terminal schema
 * yet — deriving that expectation is this step's purpose. It does not install
 * the maintained fence, grant anything outside the compiled reviewed set, or
 * claim a paired release. */
export async function reconcileRehearsalGrants(
  admin: Client,
  runtimeRole: string,
  repositoryRoot?: string,
): Promise<RehearsalGrantReceipt> {
  await admin.query("BEGIN");
  try {
    await admin.query("SET LOCAL lock_timeout='3s'");
    const approved = await compileApprovedStagingPrivileges(admin, runtimeRole, repositoryRoot);
    await restoreReviewedResetGrants(admin, approved.reviewed, approved.reviewed, approved.policy);
    await verifyApprovedStagingRuntime(admin, runtimeRole, repositoryRoot);
    const statement = (
      await admin.query(
        "SELECT format('GRANT CONNECT ON DATABASE %I TO %I',current_database(),$1::text) AS statement",
        [runtimeRole],
      )
    ).rows[0]?.statement;
    if (typeof statement !== "string") throw new Error("rehearsal_release_connect_unproven");
    await admin.query(statement);
    await admin.query("COMMIT");
    const digest = await readKaraokeRuntimeGrantDigest(admin, runtimeRole);
    const connect = (
      await admin.query(
        "SELECT has_database_privilege($1,current_database(),'CONNECT') AS allowed",
        [runtimeRole],
      )
    ).rows[0]?.allowed;
    if (connect !== true) throw new Error("rehearsal_release_connect_unproven");
    return {
      reviewed_grants: approved.reviewed.length,
      derived_reviewed_grant_digest: digest,
      runtime_connect: true,
    };
  } catch (error) {
    await admin.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}
