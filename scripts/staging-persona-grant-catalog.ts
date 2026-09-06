import { createHash } from "node:crypto";
import type { Client } from "pg";
import {
  type ResetGrant,
  type ResetGrantPolicy,
  reconcileResetGrants,
} from "./staging-persona-grant-reconciliation";

const objects = `WITH objects AS (
  SELECT 'schema' AS kind, 'SCHEMA' AS keyword, oid, nspowner AS owner,
    pg_catalog.format('%I',nspname) AS identity, coalesce(nspacl,acldefault('n',nspowner)) AS acl
    FROM pg_catalog.pg_namespace WHERE nspname='api_next'
  UNION ALL SELECT CASE WHEN relkind='S' THEN 'sequence' ELSE 'table' END,
    CASE WHEN relkind='S' THEN 'SEQUENCE' ELSE 'TABLE' END, oid,relowner,
    pg_catalog.format('%I.%I','api_next',relname),
    coalesce(relacl,acldefault(CASE WHEN relkind='S' THEN 'S'::"char" ELSE 'r'::"char" END,relowner))
    FROM pg_catalog.pg_class WHERE relnamespace='api_next'::regnamespace AND relkind IN ('r','p','v','m','f','S')
  UNION ALL SELECT 'routine','ROUTINE',oid,proowner,
    pg_catalog.format('%I.%I(%s)','api_next',proname,pg_catalog.pg_get_function_identity_arguments(oid)),
    coalesce(proacl,acldefault('f',proowner)) FROM pg_catalog.pg_proc WHERE pronamespace='api_next'::regnamespace
  UNION ALL SELECT 'type','TYPE',oid,typowner,pg_catalog.format('%I.%I','api_next',typname),
    coalesce(typacl,acldefault('T',typowner)) FROM pg_catalog.pg_type WHERE typnamespace='api_next'::regnamespace
)`;

const key = (grant: ResetGrant) =>
  JSON.stringify([
    grant.objectKind,
    grant.objectIdentity,
    grant.grantee,
    grant.privilege,
    grant.grantOption,
  ]);

/** Catalog facts, never approval. Explicit column ACLs are unsupported and refused. */
export async function readResetGrantCatalog(admin: Pick<Client, "query">) {
  const columns = await admin.query(`SELECT count(*)::int AS count FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class r ON r.oid=a.attrelid
    WHERE r.relnamespace='api_next'::regnamespace AND a.attacl IS NOT NULL`);
  if (columns.rows[0]?.count !== 0) throw new Error("reset_column_grants_unsupported");
  const result = await admin.query(`${objects}
    SELECT kind, identity, CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE r.rolname END AS grantee,
      a.privilege_type AS privilege, a.is_grantable AS grant_option
    FROM objects o CROSS JOIN LATERAL pg_catalog.aclexplode(o.acl) a
      LEFT JOIN pg_catalog.pg_roles r ON r.oid=a.grantee
    ORDER BY kind,identity,grantee,privilege,grant_option`);
  const grants: ResetGrant[] = result.rows.map((row) => ({
    schema: "api_next",
    objectKind: row.kind,
    objectIdentity: row.identity,
    grantee: row.grantee,
    privilege: row.privilege,
    grantOption: row.grant_option,
  }));
  // Reuse the pure validator; even catalog facts must fit the supported vocabulary.
  reconcileResetGrants({ before: grants, replay: [], reviewed: [] });
  const defaults = await admin.query(`SELECT defaclrole::text,defaclnamespace::text,
    defaclobjtype,defaclacl::text FROM pg_catalog.pg_default_acl
    WHERE defaclnamespace IN (0,'api_next'::regnamespace)
    ORDER BY defaclrole,defaclnamespace,defaclobjtype`);
  return {
    grants,
    defaults_sha256: createHash("sha256").update(JSON.stringify(defaults.rows)).digest("hex"),
  };
}

/** Reconstruct executable SQL from the current catalog, never supplied object SQL. */
export async function restoreReviewedResetGrants(
  admin: Pick<Client, "query">,
  before: readonly ResetGrant[],
  reviewed: readonly ResetGrant[],
  policy?: ResetGrantPolicy,
) {
  const replay = await readResetGrantCatalog(admin);
  const plan = reconcileResetGrants({ before, replay: replay.grants, reviewed, policy });
  if (plan.unfulfilledReviewed.length) throw new Error("reset_reviewed_grants_unfulfilled");
  for (const grant of [...plan.reapply, ...plan.newGrants]) {
    const result = await admin.query(
      `${objects} SELECT pg_catalog.format(
      'GRANT %s ON %s %s TO %s%s', $3::text, o.keyword, o.identity,
      CASE WHEN $4='PUBLIC' THEN 'PUBLIC' ELSE pg_catalog.quote_ident($4) END,
      CASE WHEN $5::boolean THEN ' WITH GRANT OPTION' ELSE '' END) AS statement
      FROM objects o WHERE kind=$1 AND identity=$2 AND pg_catalog.pg_has_role(o.owner,'USAGE')
      AND ($4='PUBLIC' OR EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname=$4))`,
      [grant.objectKind, grant.objectIdentity, grant.privilege, grant.grantee, grant.grantOption],
    );
    if (result.rows.length !== 1) throw new Error("reset_grant_authority_unproven");
    await admin.query(result.rows[0].statement);
  }
  // REVOKE without CASCADE refuses an unexpected downstream grant graph.
  for (const grant of policy?.forbidden ?? []) {
    const result = await admin.query(
      `${objects} SELECT pg_catalog.format(
      'REVOKE %s ON %s %s FROM %s', $3::text, o.keyword, o.identity,
      CASE WHEN $4='PUBLIC' THEN 'PUBLIC' ELSE pg_catalog.quote_ident($4) END) AS statement
      FROM objects o WHERE kind=$1 AND identity=$2 AND pg_catalog.pg_has_role(o.owner,'USAGE')
      AND ($4='PUBLIC' OR EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname=$4))`,
      [grant.objectKind, grant.objectIdentity, grant.privilege, grant.grantee],
    );
    if (result.rows.length !== 1) throw new Error("reset_revoke_authority_unproven");
    await admin.query(result.rows[0].statement);
  }
  const after = await readResetGrantCatalog(admin);
  const actual = new Set(after.grants.map(key));
  if (reviewed.some((grant) => !actual.has(key(grant)))) {
    throw new Error("reset_grant_verification_failed");
  }
  await verifyResetForbiddenGrants(admin, policy?.forbidden ?? []);
  return {
    reapplied: plan.reapply.length,
    added: plan.newGrants.length,
    revoked: plan.revoke.length,
    replay_created: plan.replayCreated.length,
  };
}

/** Effective denial includes PUBLIC and every role the runtime can become.
 * Catalog-only direct REVOKE is insufficient when authority is inherited.
 */
export async function verifyResetForbiddenGrants(
  admin: Pick<Client, "query">,
  forbidden: readonly ResetGrant[],
) {
  reconcileResetGrants({
    before: [],
    replay: [],
    reviewed: [],
    policy: { explicitNew: [], forbidden },
  });
  for (const grant of forbidden) {
    const functions = {
      table: "has_table_privilege",
      sequence: "has_sequence_privilege",
      routine: "has_function_privilege",
      type: "has_type_privilege",
      schema: "has_schema_privilege",
    };
    const result = await admin.query(
      `${objects}, candidates AS (
      SELECT r.oid FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_roles target ON target.rolname=$3
      WHERE r.oid=target.oid OR pg_catalog.pg_has_role(target.oid,r.oid,'MEMBER')
    ) SELECT count(DISTINCT o.oid)::int AS objects, count(DISTINCT c.oid)::int AS roles,
      coalesce(bool_or(pg_catalog.${functions[grant.objectKind]}(c.oid,o.oid,$4)),true) AS allowed
      FROM objects o CROSS JOIN candidates c WHERE kind=$1 AND identity=$2`,
      [grant.objectKind, grant.objectIdentity, grant.grantee, grant.privilege],
    );
    const row = result.rows[0];
    if (row?.objects !== 1 || row.roles < 1 || row.allowed !== false)
      throw new Error("reset_forbidden_privilege_effective");
  }
}
