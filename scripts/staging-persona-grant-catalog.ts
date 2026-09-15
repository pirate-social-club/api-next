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

/** One explicit `pg_default_acl` grant as a portable fact. Implicit owner
 * rights are not ACL entries and are therefore not facts. The namespace is
 * carried by name rather than OID so the digest survives the schema being
 * dropped and recreated. */
export type ResetDefaultAclGrant = Readonly<{
  namespace: string | null;
  role: string;
  objectType: "table" | "sequence";
  grantee: string;
  privilege: string;
  grantOption: boolean;
}>;

const defaultAclPrivileges = {
  table: new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]),
  sequence: new Set(["SELECT", "UPDATE", "USAGE"]),
} as const;

function assertDefaultAclFact(fact: ResetDefaultAclGrant): void {
  if (
    !defaultAclPrivileges[fact.objectType]?.has(fact.privilege) ||
    !fact.role ||
    !fact.grantee ||
    (fact.namespace !== null && fact.namespace !== "api_next") ||
    /\p{Cc}/u.test(fact.role + fact.grantee + fact.privilege)
  )
    throw new Error("reset_default_acl_fact_invalid");
}

/** Explicit default ACL grants for the reset schema and the global default
 * set, keyed by role and namespace name. This is a reset-scoped digest, not a
 * portable recovery fingerprint. */
export async function readResetDefaultAcls(admin: Pick<Client, "query">) {
  const result = await admin.query(`SELECT
    CASE WHEN d.defaclnamespace=0 THEN NULL ELSE n.nspname END AS namespace,
    r.rolname AS role,
    d.defaclobjtype AS object_type,
    CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE g.rolname END AS grantee,
    a.privilege_type AS privilege,
    a.is_grantable AS grant_option
    FROM pg_catalog.pg_default_acl d
    JOIN pg_catalog.pg_roles r ON r.oid=d.defaclrole
    LEFT JOIN pg_catalog.pg_namespace n ON n.oid=d.defaclnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a
    LEFT JOIN pg_catalog.pg_roles g ON g.oid=a.grantee
    WHERE d.defaclnamespace=0 OR d.defaclnamespace='api_next'::regnamespace
    ORDER BY namespace NULLS FIRST,role,object_type,grantee,privilege,grant_option`);
  const facts: ResetDefaultAclGrant[] = result.rows.map((row) => {
    if (row.object_type !== "r" && row.object_type !== "S")
      throw new Error("reset_default_acl_unsupported");
    return {
      namespace: row.namespace,
      role: row.role,
      objectType: row.object_type === "r" ? "table" : "sequence",
      grantee: row.grantee,
      privilege: row.privilege,
      grantOption: row.grant_option,
    };
  });
  for (const fact of facts) assertDefaultAclFact(fact);
  return Object.freeze({
    facts: Object.freeze(facts),
    sha256: createHash("sha256").update(JSON.stringify(facts)).digest("hex"),
  });
}

/** Recreate the reset schema's default ACL grants from captured catalog facts.
 * Global defaults survive a schema drop and are deliberately skipped; the
 * caller still verifies them through the digest. Statements are rendered from
 * validated facts with server-side identifier quoting, never supplied SQL. */
export async function restoreResetDefaultAcls(
  admin: Pick<Client, "query">,
  facts: readonly ResetDefaultAclGrant[],
) {
  for (const fact of facts) {
    if (fact.namespace !== "api_next") continue;
    assertDefaultAclFact(fact);
    const target = fact.objectType === "table" ? "TABLES" : "SEQUENCES";
    const built = await admin.query(
      `SELECT pg_catalog.format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA api_next GRANT ${fact.privilege} ON ${target} TO %s${fact.grantOption ? " WITH GRANT OPTION" : ""}',
      $1::text, CASE WHEN $2::text='PUBLIC' THEN 'PUBLIC' ELSE pg_catalog.quote_ident($2::text) END)
      AS statement`,
      [fact.role, fact.grantee],
    );
    if (built.rows.length !== 1 || typeof built.rows[0].statement !== "string")
      throw new Error("reset_default_acl_restore_unproven");
    await admin.query(built.rows[0].statement);
  }
}

/** Exact catalog-owned revocation. No CASCADE, supplied SQL or grantor switch. */
export async function revokeResetCatalogGrant(admin: Pick<Client, "query">, grant: ResetGrant) {
  reconcileResetGrants({ before: [grant], replay: [], reviewed: [] });
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
  const defaults = await readResetDefaultAcls(admin);
  return {
    grants,
    defaults_sha256: defaults.sha256,
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
  const plan = reconcileResetGrants({
    before,
    replay: replay.grants,
    reviewed,
    ...(policy === undefined ? {} : { policy }),
  });
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
    await revokeResetCatalogGrant(admin, grant);
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
