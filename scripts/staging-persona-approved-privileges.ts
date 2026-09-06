import type { Client } from "pg";
import { readResetGrantCatalog, verifyResetForbiddenGrants } from "./staging-persona-grant-catalog";
import type { ResetGrant, ResetGrantPolicy } from "./staging-persona-grant-reconciliation";
import { draftStagingPrivilegeProposal } from "./staging-persona-privilege-proposal";

const called = "append_song_owner_policy_revision_v1(text,text,text,bigint,text,text,text)";
const restricted = [
  "claim_hns_authority_provision_job_v1(text,integer)",
  "finalize_hns_authority_provision_job_v1(text,text,bigint,text,text,bytea,text,bytea,text,text)",
  "claim_hns_root_import_observation_job_v1(text,integer)",
  "finalize_hns_root_import_observation_job_v1(text,text,bigint,text,text,bytea,text,text)",
  "enqueue_hns_root_import_teardown_job_v1()",
  "observe_song_derivative_video_policy_v1(text,text,bigint,text,text,bigint,text)",
] as const;

/** Owner policy ratified 2026-09-06. This compiles the fixed proposal, not live
 * authority: the caller must independently bind runtimeRole to staging.
 * Catalog identities resolve only the exact pinned routine signatures.
 */
export async function compileApprovedStagingPrivileges(
  admin: Pick<Client, "query">,
  runtimeRole: string,
) {
  if (!runtimeRole || runtimeRole === "PUBLIC" || /\p{Cc}/u.test(runtimeRole))
    throw new Error("reset_runtime_identity_invalid");
  const proposal = draftStagingPrivilegeProposal();
  const grant = (
    objectKind: ResetGrant["objectKind"],
    objectIdentity: string,
    privilege: string,
  ): ResetGrant => ({
    schema: "api_next",
    objectKind,
    objectIdentity,
    grantee: runtimeRole,
    privilege,
    grantOption: false,
  });
  const routine = async (signature: string) => {
    const result = await admin.query(
      `SELECT pg_catalog.format('%I.%I(%s)',n.nspname,p.proname,
      pg_catalog.pg_get_function_identity_arguments(p.oid)) AS identity
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE p.oid=pg_catalog.to_regprocedure($1) AND n.nspname='api_next'`,
      [`api_next.${signature}`],
    );
    if (result.rows.length !== 1) throw new Error("reset_policy_routine_missing");
    return grant("routine", result.rows[0].identity, "EXECUTE");
  };
  const reviewed = proposal.entries.flatMap((entry) =>
    entry.privileges.map((privilege) =>
      grant(entry.kind as ResetGrant["objectKind"], entry.object, privilege),
    ),
  );
  const addition = await routine(called);
  reviewed.push(grant("table", "api_next.schema_migrations", "SELECT"), addition);
  const forbidden = ["INSERT", "UPDATE", "DELETE", "TRUNCATE"].map((privilege) =>
    grant("table", "api_next.schema_migrations", privilege),
  );
  forbidden.push(grant("schema", "api_next", "CREATE"));
  for (const signature of restricted) forbidden.push(await routine(signature));
  const policy: ResetGrantPolicy = { explicitNew: [addition], forbidden };
  return { reviewed, policy, sourceSha: proposal.source_sha, execution_authorized: false };
}

/** Fresh effective-role proof, including memberships usable through SET ROLE.
 * No credential values or identity rows are returned. Does not mutate grants.
 */
export async function verifyStagingRuntimeIdentity(
  admin: Pick<Client, "query">,
  runtimeRole: string,
) {
  const result = await admin.query(
    `WITH roles AS (
    SELECT r.* FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_roles target ON target.rolname=$1
    WHERE r.oid=target.oid OR pg_catalog.pg_has_role(target.oid,r.oid,'MEMBER')
  ) SELECT count(*)::int AS count,
    coalesce(bool_or(rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls
      OR left(rolname,3)='pg_' OR pg_catalog.has_database_privilege(oid,current_database(),'CREATE')),true) AS elevated,
    ARRAY(SELECT rolname FROM roles) AS names,
    EXISTS(SELECT 1 FROM roles r JOIN pg_catalog.pg_shdepend d ON d.refobjid=r.oid
      WHERE d.refclassid='pg_catalog.pg_authid'::regclass AND d.deptype='o'
      AND d.dbid=(SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database())) AS owns
    FROM roles`,
    [runtimeRole],
  );
  const row = result.rows[0];
  if (!row || row.count < 1 || row.elevated || row.owns) throw new Error("reset_runtime_elevated");
  return row.names as string[];
}

export async function verifyApprovedStagingRuntime(
  admin: Pick<Client, "query">,
  runtimeRole: string,
) {
  const names = await verifyStagingRuntimeIdentity(admin, runtimeRole);
  const manifest = await compileApprovedStagingPrivileges(admin, runtimeRole);
  const catalog = await readResetGrantCatalog(admin);
  if (
    catalog.grants.some(
      (grant) => grant.grantOption && (names.includes(grant.grantee) || grant.grantee === "PUBLIC"),
    )
  )
    throw new Error("reset_runtime_grant_option");
  const allowed = {
    table: ["SELECT", "INSERT", "UPDATE", "DELETE"],
    schema: ["USAGE"],
    sequence: ["SELECT", "UPDATE", "USAGE"],
    routine: ["EXECUTE"],
    type: ["USAGE"],
  };
  if (
    catalog.grants.some(
      (grant) =>
        (names.includes(grant.grantee) || grant.grantee === "PUBLIC") &&
        !allowed[grant.objectKind].includes(grant.privilege),
    )
  )
    throw new Error("reset_runtime_unapproved_privilege");
  await verifyResetForbiddenGrants(admin, manifest.policy.forbidden);
  const key = (grant: ResetGrant) => JSON.stringify(grant);
  const actual = new Set(catalog.grants.map(key));
  if (manifest.reviewed.some((grant) => !actual.has(key(grant))))
    throw new Error("reset_runtime_required_grant_missing");
  return { runtime_policy_verified: true, execution_authorized: false };
}
