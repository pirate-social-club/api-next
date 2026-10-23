import { Schema } from "effect";

/** Effective capabilities only. This module never grants or mutates authority. */
export const NOTIFICATION_ERASURE_BOUNDARIES = [
  ["notification_inbox", "inbox"],
  ["notification_publication_deliveries", "retained"],
  ["telegram_bot_grants", "retained"],
  ["telegram_study_conversations", "retained"],
  ["telegram_interface_preferences", "retained"],
  ["community_purchase_funding_journal", "retained"],
  ["community_purchase_funding_requests", "retained"],
  ["community_purchase_funding_plans", "retained"],
  ["video_alias_audit_runs_v1", "private"],
  ["video_alias_audit_items_v1", "private"],
  ["video_notification_cutovers_v1", "private"],
  ["start_video_alias_audit_v1(uuid,text,text)", "function"],
  ["process_video_alias_audit_batch_v1(uuid,text)", "function"],
  ["guard_video_alias_audit_run_v1()", "function"],
] as const;

export function notificationErasurePrivilegeParameters(schema: string) {
  return [
    schema,
    NOTIFICATION_ERASURE_BOUNDARIES.map(([name]) => name),
    NOTIFICATION_ERASURE_BOUNDARIES.map(([, boundary]) => boundary),
  ] as const;
}

/** One SELECT-only catalog snapshot from the actual connection, not an example
 * role name. MEMBER also detects authority reachable through SET ROLE even when
 * it is not inherited in the current session. No application row is selected. */
export const NOTIFICATION_ERASURE_PRIVILEGES_SQL = `WITH anchor AS (
  SELECT n.oid AS namespace_oid,n.nspname,n.nspowner,u.oid AS users_oid,u.relowner,
    actor.oid AS actor_oid,
    current_user::text AS runtime_role,session_user::text AS session_role,
    actor.rolcanlogin AND NOT(actor.rolsuper OR actor.rolcreaterole OR actor.rolcreatedb OR actor.rolreplication OR actor.rolbypassrls) AS role_safe,
    has_schema_privilege(current_user,n.oid,'USAGE') AS schema_usage,
    has_schema_privilege(current_user,n.oid,'CREATE') AS schema_create,
    has_column_privilege(current_user,u.oid,'status','UPDATE') AS account_status_executor,
    EXISTS(SELECT 1 FROM aclexplode(COALESCE(u.relacl,acldefault('r',u.relowner))) acl
      WHERE acl.grantee=0 AND acl.privilege_type='UPDATE') OR EXISTS(
        SELECT 1 FROM pg_attribute attribute CROSS JOIN LATERAL aclexplode(attribute.attacl) acl
        WHERE attribute.attrelid=u.oid AND attribute.attname='status' AND acl.grantee=0 AND acl.privilege_type='UPDATE') AS public_status_authority,
    has_column_privilege(current_user,u.oid,'user_id','SELECT') AND has_column_privilege(current_user,u.oid,'status','SELECT') AS users_select,
    pg_has_role(current_user,n.nspowner,'MEMBER') OR EXISTS(
      SELECT 1 FROM pg_class owned WHERE owned.relnamespace=n.oid AND pg_has_role(current_user,owned.relowner,'MEMBER'))
      OR EXISTS(SELECT 1 FROM pg_proc owned WHERE owned.pronamespace=n.oid AND pg_has_role(current_user,owned.proowner,'MEMBER')) AS owner_equivalent,
    EXISTS(SELECT 1 FROM pg_roles member WHERE member.oid<>actor.oid AND pg_has_role(current_user,member.oid,'MEMBER')
      AND (member.rolsuper OR member.rolcreaterole OR member.rolcreatedb OR member.rolreplication OR member.rolbypassrls
        OR has_column_privilege(member.oid,u.oid,'status','UPDATE'))) AS inherited_status_authority,
    EXISTS(SELECT 1 FROM pg_default_acl defaults CROSS JOIN LATERAL aclexplode(defaults.defaclacl) acl
      WHERE defaults.defaclrole=u.relowner AND defaults.defaclnamespace IN (0,n.oid) AND defaults.defaclobjtype='r'
        AND acl.privilege_type IN ('DELETE','TRUNCATE','REFERENCES','TRIGGER')
        AND CASE WHEN acl.grantee=0 THEN TRUE ELSE acl.grantee=actor.oid OR pg_has_role(current_user,acl.grantee,'MEMBER') END) AS forward_destructive_default
  FROM pg_namespace n JOIN pg_class u ON u.relnamespace=n.oid AND u.relname='users' AND u.relkind='r'
  JOIN pg_roles actor ON actor.rolname=current_user WHERE n.nspname=$1
), guards AS (
  -- Exact trigger shapes retained from0271. The inbox guard alone became a
  -- trusted-schema definer in0283 to read private Dance provenance. Every other
  -- guard remains invoker; no trigger has WHEN, arguments or transition relations.
  SELECT count(*)=4 AND COALESCE(bool_and(COALESCE(
    t.oid IS NOT NULL AND fn.oid IS NOT NULL
    AND t.tgenabled='O' AND NOT t.tgisinternal
    AND t.tgfoid=fn.oid AND fn.proowner=a.relowner
    AND fn.prosecdef=required.security_definer
    AND (NOT required.security_definer OR fn.proconfig=ARRAY[format('search_path=%I, pg_catalog, pg_temp',a.nspname)])
    AND t.tgtype=required.trigger_type
    AND t.tgnargs=0 AND octet_length(t.tgargs)=0 AND t.tgqual IS NULL
    AND t.tgconstraint=0 AND NOT t.tgdeferrable AND NOT t.tginitdeferred
    AND t.tgparentid=0 AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
    AND cardinality(t.tgattr::smallint[])=cardinality(required.update_columns)
    AND ARRAY(SELECT attribute.attname::text
      FROM unnest(t.tgattr::smallint[]) WITH ORDINALITY updated(attnum,attribute_order)
      JOIN pg_attribute attribute ON attribute.attrelid=t.tgrelid
        AND attribute.attnum=updated.attnum AND NOT attribute.attisdropped
      ORDER BY updated.attribute_order)=required.update_columns
    ,FALSE)),FALSE) AS guards_valid
  FROM anchor a CROSS JOIN (VALUES
    ('users','users_delete_notification_inbox','delete_recipient_notification_inbox_v1()',17,ARRAY['status']::text[],FALSE),
    ('notification_inbox','notification_inbox_guard','guard_notification_inbox_v1()',31,ARRAY[]::text[],TRUE),
    ('notification_publication_deliveries','notification_delivery_guard','guard_notification_delivery_v1()',31,ARRAY[]::text[],FALSE),
    ('content_publication_outbox','comment_notification_fact_guard','guard_comment_notification_fact_v1()',27,ARRAY[]::text[],FALSE)
  ) required(table_name,trigger_name,signature,trigger_type,update_columns,security_definer)
  LEFT JOIN pg_trigger t ON t.tgrelid=to_regclass(format('%I.%I',a.nspname,required.table_name)) AND t.tgname=required.trigger_name
  LEFT JOIN pg_proc fn ON fn.oid=to_regprocedure(format('%I',a.nspname)||'.'||required.signature)
), objects AS (
  SELECT a.*,required.object_name,required.boundary,c.oid AS table_oid,p.oid AS function_oid,
    COALESCE(CASE WHEN required.boundary='function' THEN p.proowner=a.relowner AND NOT p.prosecdef
      ELSE c.relowner=a.relowner AND c.relkind='r' END,FALSE) AS anchored_owner,
    c.relacl,c.relowner AS table_owner
  FROM anchor a CROSS JOIN unnest($2::text[],$3::text[]) required(object_name,boundary)
  LEFT JOIN pg_class c ON required.boundary<>'function' AND c.relnamespace=a.namespace_oid AND c.relname=required.object_name
  LEFT JOIN pg_proc p ON p.oid=CASE WHEN required.boundary='function'
    THEN to_regprocedure(format('%I',a.nspname)||'.'||required.object_name) END
)
SELECT o.runtime_role,o.session_role,o.role_safe,o.schema_usage,o.schema_create,o.owner_equivalent,
  o.account_status_executor,o.public_status_authority,o.users_select,o.inherited_status_authority,o.forward_destructive_default,g.guards_valid,
  o.object_name,o.boundary,o.anchored_owner,
  CASE WHEN o.boundary='function' THEN o.function_oid IS NOT NULL ELSE o.table_oid IS NOT NULL END AS object_exists,
  COALESCE(has_table_privilege(current_user,o.table_oid,'SELECT'),FALSE) AS can_select,
  COALESCE(has_table_privilege(current_user,o.table_oid,'DELETE'),FALSE) AS can_delete,
  COALESCE(has_table_privilege(current_user,o.table_oid,'TRUNCATE,REFERENCES,TRIGGER'),FALSE) AS excessive_table_authority,
  EXISTS(SELECT 1 FROM aclexplode(COALESCE(o.relacl,acldefault('r',o.table_owner))) acl
    WHERE acl.grantee=o.actor_oid AND acl.privilege_type='DELETE' AND NOT acl.is_grantable) AS direct_delete,
  EXISTS(SELECT 1 FROM aclexplode(COALESCE(o.relacl,acldefault('r',o.table_owner))) acl
    WHERE acl.grantee=o.actor_oid AND acl.privilege_type='DELETE' AND acl.is_grantable) AS delete_grant_option,
  EXISTS(SELECT 1 FROM aclexplode(COALESCE(o.relacl,acldefault('r',o.table_owner))) acl
    WHERE acl.grantee=0 AND acl.privilege_type='DELETE') AS public_delete,
  COALESCE(CASE WHEN o.boundary='function' THEN has_function_privilege(current_user,o.function_oid,'EXECUTE')
    WHEN o.boundary='private' THEN has_table_privilege(current_user,o.table_oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege(current_user,o.table_oid,'SELECT,INSERT,UPDATE,REFERENCES') ELSE FALSE END,FALSE) AS private_access,
  EXISTS(SELECT 1 FROM pg_roles member WHERE member.oid<>o.actor_oid AND pg_has_role(current_user,member.oid,'MEMBER')
    AND COALESCE(CASE WHEN o.boundary='function' THEN has_function_privilege(member.oid,o.function_oid,'EXECUTE')
      WHEN o.boundary='private' THEN has_table_privilege(member.oid,o.table_oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR has_any_column_privilege(member.oid,o.table_oid,'SELECT,INSERT,UPDATE,REFERENCES')
      ELSE has_table_privilege(member.oid,o.table_oid,'DELETE,TRUNCATE,REFERENCES,TRIGGER') END,FALSE)) AS inherited_unsafe
FROM objects o CROSS JOIN guards g`;

const Fact = Schema.Struct({
  runtime_role: Schema.String,
  session_role: Schema.String,
  object_name: Schema.String,
  boundary: Schema.String,
  role_safe: Schema.Boolean,
  schema_usage: Schema.Boolean,
  schema_create: Schema.Boolean,
  owner_equivalent: Schema.Boolean,
  account_status_executor: Schema.Boolean,
  public_status_authority: Schema.Boolean,
  users_select: Schema.Boolean,
  inherited_status_authority: Schema.Boolean,
  forward_destructive_default: Schema.Boolean,
  guards_valid: Schema.Boolean,
  anchored_owner: Schema.Boolean,
  object_exists: Schema.Boolean,
  can_select: Schema.Boolean,
  can_delete: Schema.Boolean,
  excessive_table_authority: Schema.Boolean,
  direct_delete: Schema.Boolean,
  delete_grant_option: Schema.Boolean,
  public_delete: Schema.Boolean,
  private_access: Schema.Boolean,
  inherited_unsafe: Schema.Boolean,
});

export class NotificationErasurePrivilegesRefused extends Error {
  constructor(
    readonly failures: readonly string[],
    options?: ErrorOptions,
  ) {
    super("Notification account-erasure privileges refused", options);
  }
}

/** A bounded direct grant is required only for the observed account-status
 * executor. Other principals must not possess inbox DELETE. Existing guarded
 * INSERT/UPDATE remains independent; no raw receipt UPDATE is required here. */
export function assertNotificationErasurePrivileges(input: unknown): string {
  let rows: readonly (typeof Fact.Type)[];
  try {
    rows = Schema.decodeUnknownSync(Schema.Array(Fact))(input);
  } catch (cause) {
    throw new NotificationErasurePrivilegesRefused(["privilege facts malformed"], { cause });
  }
  const role = rows[0]?.runtime_role;
  if (!role || rows.length !== NOTIFICATION_ERASURE_BOUNDARIES.length)
    throw new NotificationErasurePrivilegesRefused(["privilege facts incomplete"]);
  const failures: string[] = [];
  for (const [name, boundary] of NOTIFICATION_ERASURE_BOUNDARIES) {
    const found = rows.filter((row) => row.object_name === name);
    const row = found[0];
    if (found.length !== 1 || !row || row.boundary !== boundary) {
      failures.push(`${name}: binding differs`);
      continue;
    }
    for (const [field, expected] of [
      ["role_safe", true],
      ["schema_usage", true],
      ["schema_create", false],
      ["owner_equivalent", false],
      ["public_status_authority", false],
      ["inherited_status_authority", false],
      ["forward_destructive_default", false],
      ["guards_valid", true],
      ["anchored_owner", true],
      ["object_exists", true],
      ["excessive_table_authority", false],
      ["delete_grant_option", false],
      ["public_delete", false],
      ["private_access", false],
      ["inherited_unsafe", false],
    ] as const)
      if (row[field] !== expected) failures.push(`${name}: ${field} refused`);
    if (
      row.runtime_role !== role ||
      row.session_role !== role ||
      row.account_status_executor !== rows[0]?.account_status_executor
    )
      failures.push(`${name}: observed login differs`);
    const expectedDelete = boundary === "inbox" && row.account_status_executor;
    if (row.can_delete !== expectedDelete)
      failures.push(`${name}: DELETE ${expectedDelete ? "missing" : "excessive"}`);
    if (
      boundary === "inbox" &&
      (row.direct_delete !== expectedDelete ||
        (expectedDelete && (!row.can_select || !row.users_select)))
    )
      failures.push(`${name}: direct bounded account-status authority missing`);
  }
  if (failures.length) throw new NotificationErasurePrivilegesRefused(failures);
  return role;
}
