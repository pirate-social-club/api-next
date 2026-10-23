import { expect } from "bun:test";
import type { Client } from "pg";

// Reviewed video_detail_access_v1 invoker closure (0272). These are read grants
// only, not producer or private audit/cutover capabilities.
const videoReadTables = [
  "media_immutable_objects",
  "media_post_submissions",
  "media_publication_projections",
  "media_song_video_accepted_masters",
  "media_song_video_masters",
  "media_song_video_render_plans",
  "media_video_analyses",
  "media_video_publication_decisions",
  "media_video_review_holds",
  "media_video_revisions",
  "media_video_rights",
  "media_video_safety_evidence",
  "media_video_song_references",
] as const;
const commonFunctions = [
  "authorized_comment_branch_v1(text,text)",
  "video_detail_access_v1(text,text)",
  "video_detail_id_safe_v1(text)",
  "post_slug_utf16_code_units(text)",
  "can_account_view_content_rating_v1(text,text)",
  "current_account_age_capability_v1(text)",
  "current_account_age_evidence_v2(text)",
];
const privateTables = [
  "video_alias_audit_runs_v1",
  "video_alias_audit_items_v1",
  "video_notification_cutovers_v1",
];
const privateFunctions = [
  "start_video_alias_audit_v1(uuid,text,text)",
  "process_video_alias_audit_batch_v1(uuid,text)",
  "guard_video_alias_audit_run_v1()",
];

export async function grantNotificationVideoReads(admin: Client, roles: readonly string[]) {
  for (const role of roles)
    await admin.query(`GRANT SELECT ON ${videoReadTables.join(",")} TO ${role}`);
}

export async function verifyNotificationRoleAccess(
  client: Client,
  role: string,
  caller: "http" | "jobs" | "deletion" | "forward",
  sourceTables: readonly string[],
) {
  expect(
    (
      await client.query(
        `SELECT current_user AS current_role,session_user AS session_role,
          rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls,rolcanlogin
         FROM pg_roles WHERE rolname=current_user`,
      )
    ).rows,
  ).toEqual([
    {
      current_role: role,
      session_role: role,
      rolsuper: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolreplication: false,
      rolbypassrls: false,
      rolcanlogin: true,
    },
  ]);
  for (const table of new Set([...sourceTables, ...videoReadTables, ...privateTables]))
    expect(
      (
        await client.query(
          `SELECT relowner=current_user::regrole AS owns,
             pg_has_role(current_user,relowner,'MEMBER') AS owner_member
           FROM pg_class WHERE oid=$1::regclass`,
          [table],
        )
      ).rows,
    ).toEqual([{ owns: false, owner_member: false }]);

  if (caller !== "deletion") {
    for (const table of videoReadTables)
      expect(
        (
          await client.query("SELECT has_table_privilege(current_user,$1,'SELECT') AS allowed", [
            table,
          ])
        ).rows,
      ).toEqual([{ allowed: true }]);
    const required = [
      ...commonFunctions,
      ...(caller === "http"
        ? ["readable_notification_source_v1(text,text)"]
        : [
            "deliver_comment_notification_v1(text)",
            "eligible_comment_notification_recipient_v1(text)",
          ]),
    ];
    for (const signature of required) {
      const access = await client.query<{ allowed: boolean }>(
        "SELECT has_function_privilege(current_user,$1,'EXECUTE') AS allowed",
        [signature],
      );
      if (access.rows.length !== 1 || access.rows[0]?.allowed !== true)
        throw new Error(`Missing effective EXECUTE for ${caller}: ${signature}`);
      expect(access.rows).toEqual([{ allowed: true }]);
    }
  }

  for (const [signature, allowed] of [
    [
      "readable_recipient_notification_v2(text,text,text)",
      caller === "http" || caller === "forward",
    ],
    ["pending_recipient_notifications_v2()", caller === "jobs" || caller === "forward"],
    ["deliver_recipient_notification_v2(text)", caller === "jobs" || caller === "forward"],
  ] as const)
    expect(
      (
        await client.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') AS allowed", [
          signature,
        ])
      ).rows,
    ).toEqual([{ allowed }]);
  for (const table of ["dance_moderated_reviews_v1", "dance_moderated_result_events_v1"])
    expect(
      (
        await client.query(
          "SELECT has_table_privilege(current_user,$1,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(current_user,$1,'SELECT,INSERT,UPDATE,REFERENCES') AS allowed",
          [table],
        )
      ).rows,
    ).toEqual([{ allowed: false }]);

  // Real LOGIN denials after the actual migration's ACL cleanup, before any
  // workflow. No fixture REVOKE or operator/evidence grant manufactures this.
  const denied = async (sql: string, values: unknown[] = []) =>
    expect(client.query(sql, values)).rejects.toMatchObject({ code: "42501" });
  for (const table of privateTables) {
    expect(
      (
        await client.query(
          `SELECT has_table_privilege(current_user,$1,
             'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS table_access,
           has_any_column_privilege(current_user,$1,'SELECT,INSERT,UPDATE,REFERENCES') AS column_access`,
          [table],
        )
      ).rows,
    ).toEqual([{ table_access: false, column_access: false }]);
    await denied(`SELECT * FROM ${table}`);
    await denied(`DELETE FROM ${table}`);
    await denied(`TRUNCATE ${table}`);
  }
  for (const signature of privateFunctions)
    expect(
      (
        await client.query(
          `SELECT has_function_privilege(current_user,p.oid,'EXECUTE') AS allowed,
             p.proowner=current_user::regrole AS owns,
             pg_has_role(current_user,p.proowner,'MEMBER') AS owner_member,p.prosecdef
           FROM pg_proc p WHERE p.oid=$1::regprocedure`,
          [signature],
        )
      ).rows,
    ).toEqual([{ allowed: false, owns: false, owner_member: false, prosecdef: false }]);
  const runId = crypto.randomUUID();
  const plan = "a".repeat(64);
  await denied("SELECT start_video_alias_audit_v1($1,$2,'materialize')", [runId, plan]);
  await denied("SELECT process_video_alias_audit_batch_v1($1,$2)", [runId, plan]);
  await denied("SELECT guard_video_alias_audit_run_v1()");
  await denied(
    "INSERT INTO video_alias_audit_runs_v1(run_id,plan_sha256,mode,complete) VALUES($1,$2,'materialize',true)",
    [runId, plan],
  );
  await denied("UPDATE video_alias_audit_runs_v1 SET complete=true");
  await denied(
    "INSERT INTO video_alias_audit_items_v1(run_id,submission_id,operation_id,outcome,before_binding,after_binding,receipt_digests) VALUES($1,'forged','forged','already-exact','[]','[]','{}')",
    [runId],
  );
  await denied("UPDATE video_alias_audit_items_v1 SET outcome='already-exact'");
  await denied(
    "INSERT INTO video_notification_cutovers_v1(plan_sha256,alias_run_id,paired_solid_sha256,cutover_source_sha256) VALUES($1,$2,$1,$1)",
    [plan, runId],
  );
  await denied("UPDATE video_notification_cutovers_v1 SET paired_solid_sha256=$1", [plan]);
}

export async function verifyNotificationFirstDelivery(
  admin: Client,
  eventId: string,
  delivered: boolean,
) {
  expect(
    (
      await admin.query(
        `SELECT fact.inbox_delivery_recorded,
          (SELECT count(*)::int FROM notification_inbox WHERE source_event_id=fact.outbox_event_id) AS inbox_count,
          (SELECT count(*)::int FROM notification_publication_deliveries WHERE source_event_id=fact.outbox_event_id) AS receipt_count,
          (SELECT outcome FROM notification_publication_deliveries WHERE source_event_id=fact.outbox_event_id) AS outcome
         FROM content_publication_outbox fact WHERE fact.outbox_event_id=$1`,
        [eventId],
      )
    ).rows,
  ).toEqual([
    {
      inbox_delivery_recorded: delivered,
      inbox_count: delivered ? 1 : 0,
      receipt_count: delivered ? 1 : 0,
      outcome: delivered ? "delivered" : null,
    },
  ]);
}

export async function notificationRoleImmutableHistory(admin: Client) {
  const result = await admin.query<{ facts: unknown; receipts: unknown }>(
    `SELECT
      (SELECT jsonb_agg(to_jsonb(fact) ORDER BY outbox_event_id)
        FROM content_publication_outbox fact) AS facts,
      (SELECT jsonb_agg(to_jsonb(receipt)-'notification_id' ORDER BY source_event_id)
        FROM notification_publication_deliveries receipt) AS receipts`,
  );
  const row = result.rows[0];
  if (!row) throw new Error("Actual immutable history snapshot required");
  return row;
}
