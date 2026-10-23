/** ACL-only full-migration fixture; repaired initialization is UNRUN.
 * Parent alone executes on its disposable PG fixture. */
import { expect } from "bun:test";
import { Effect } from "effect";
import { Client } from "pg";
import { withInbox } from "./notifications.pg-fixture.ts";
import { makeControlPlaneNotificationStore } from "./notifications-repository.ts";
import { runVideoAdmissionFixture } from "./notifications-video-proof.pg-fixture.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";

type Fixture = Parameters<Parameters<typeof withInbox>[0]>[0];
export async function proveNotificationsVideoPrivateAcl(
  publishVideo: (fixture: Fixture) => Promise<void>,
) {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const runtimeRole = `notifications_acl_${suffix}r`;
  const inheritedRole = `notifications_acl_${suffix}g`;
  const operatorRole = `notifications_acl_${suffix}o`;
  const password = crypto.randomUUID(); // ephemeral LOGIN fixture only; never logged
  const clients: Client[] = [];
  let runtimeUrl = "";
  let operatorUrl = "";
  const privateTables = [
    "video_alias_audit_runs_v1",
    "video_alias_audit_items_v1",
    "video_notification_cutovers_v1",
  ];
  const mutators = [
    "start_video_alias_audit_v1(uuid,text,text)",
    "process_video_alias_audit_batch_v1(uuid,text)",
    "guard_video_alias_audit_run_v1()",
  ];
  await withInbox(
    async (f) => {
      await publishVideo(f);
      const runtime = new Client({ connectionString: runtimeUrl });
      const operator = new Client({ connectionString: operatorUrl });
      clients.push(runtime, operator);
      await runtime.connect();
      await operator.connect();
      expect((await runtime.query("SELECT current_user AS role")).rows[0].role).toBe(runtimeRole);
      expect((await operator.query("SELECT current_user AS role")).rows[0].role).toBe(operatorRole);
      // These are genuinely separately authenticated non-owner connections.
      expect(
        (
          await runtime.query(
            "SELECT rolsuper,rolcreaterole FROM pg_roles WHERE rolname=current_user",
          )
        ).rows[0],
      ).toEqual({ rolsuper: false, rolcreaterole: false });
      expect(
        (
          await runtime.query(
            "SELECT pg_has_role(current_user,relowner,'USAGE') AS owns FROM pg_class WHERE oid='video_alias_audit_runs_v1'::regclass",
          )
        ).rows[0].owns,
      ).toBe(false);
      const denied = async (sql: string, values: unknown[] = []) => {
        await expect(runtime.query(sql, values)).rejects.toMatchObject({ code: "42501" });
      };
      const runId = crypto.randomUUID();
      for (const table of privateTables) {
        for (const privilege of [
          "SELECT",
          "INSERT",
          "UPDATE",
          "DELETE",
          "TRUNCATE",
          "REFERENCES",
          "TRIGGER",
        ])
          expect(
            (
              await runtime.query("SELECT has_table_privilege(current_user,$1,$2) AS allowed", [
                table,
                privilege,
              ])
            ).rows[0].allowed,
          ).toBe(false);
        await denied(`SELECT * FROM ${table}`);
        await denied(`DELETE FROM ${table}`);
        await denied(`TRUNCATE ${table}`);
      }
      for (const fn of mutators)
        expect(
          (
            await runtime.query(
              "SELECT has_function_privilege(current_user,$1,'EXECUTE') AS allowed",
              [fn],
            )
          ).rows[0].allowed,
        ).toBe(false);
      await denied(
        "SELECT start_video_alias_audit_v1($1,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','materialize')",
        [runId],
      );
      await denied(
        "SELECT process_video_alias_audit_batch_v1($1,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')",
        [runId],
      );
      // Real evidence-forgery attempts, not ACL string assertions. Constraint
      // validity is irrelevant: permission denial must precede data access.
      await denied(
        "INSERT INTO video_alias_audit_runs_v1(run_id,plan_sha256,mode,complete) VALUES($1,$2,'materialize',true)",
        [runId, "a".repeat(64)],
      );
      await denied("UPDATE video_alias_audit_runs_v1 SET complete=true");
      await denied(
        "INSERT INTO video_alias_audit_items_v1(run_id,submission_id,operation_id,outcome,before_binding,after_binding,receipt_digests) VALUES($1,'forged','forged','already-exact','[]','[]','{}')",
        [runId],
      );
      await denied("UPDATE video_alias_audit_items_v1 SET outcome='already-exact'");
      await denied(
        "INSERT INTO video_notification_cutovers_v1(plan_sha256,alias_run_id,paired_solid_sha256,cutover_source_sha256) VALUES($1,$2,$1,$1)",
        ["a".repeat(64), runId],
      );
      await denied("UPDATE video_notification_cutovers_v1 SET paired_solid_sha256=$1", [
        "a".repeat(64),
      ]);

      // Explicit, parent-controlled audit operator grants; never runtime grants.
      // Cutover DDL/receipt remain migration-owner-only, not delegated here.
      // Remove this fixture's hostile PUBLIC table grants after proving denial,
      // so the operator's positive proof depends on the narrow grants below.
      const schema = (await f.admin.query("SELECT current_schema() AS schema")).rows[0].schema;
      await f.admin.query(`REVOKE ALL ON ALL TABLES IN SCHEMA "${schema}" FROM PUBLIC`);
      await f.admin.query(
        `GRANT SELECT,INSERT,UPDATE ON video_alias_audit_runs_v1 TO "${operatorRole}"`,
      );
      await f.admin.query(`GRANT SELECT,INSERT ON video_alias_audit_items_v1 TO "${operatorRole}"`);
      await f.admin.query(
        `GRANT SELECT ON media_post_submissions,posts,users,post_slug_aliases,media_submission_command_replays,media_publication_projections TO "${operatorRole}"`,
      );
      await f.admin.query(
        `GRANT UPDATE(updated_at) ON media_post_submissions,posts TO "${operatorRole}"`,
      );
      await f.admin.query(`GRANT INSERT ON post_slug_aliases TO "${operatorRole}"`);
      await f.admin.query(
        `GRANT EXECUTE ON FUNCTION start_video_alias_audit_v1(uuid,text,text),process_video_alias_audit_batch_v1(uuid,text),require_video_publication_identity_v1(text,text,text),ensure_exact_video_receipt_alias_v1(text,text,text) TO "${operatorRole}"`,
      );
      const operatorLayer = makeDirectPostgresControlPlaneLayer(operatorUrl);
      const batch = await runVideoAdmissionFixture(operatorLayer, (audit) =>
        Effect.gen(function* () {
          yield* audit.startAudit({ runId, planSha256: "a".repeat(64), mode: "materialize" });
          return yield* audit.auditBatch({ runId, planSha256: "a".repeat(64) });
        }),
      );
      expect(batch.rows[0]).toEqual({ examined: 1 });
      expect(
        (
          await operator.query("SELECT complete FROM video_alias_audit_runs_v1 WHERE run_id=$1", [
            runId,
          ])
        ).rows[0].complete,
      ).toBe(true);
      expect(
        (
          await operator.query("SELECT outcome FROM video_alias_audit_items_v1 WHERE run_id=$1", [
            runId,
          ])
        ).rows,
      ).toEqual([{ outcome: "already-exact" }]);
      // Even the audit operator cannot forge/admit a cutover receipt or read it.
      await expect(
        operator.query("SELECT * FROM video_notification_cutovers_v1"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        operator.query(
          "INSERT INTO video_notification_cutovers_v1(plan_sha256,alias_run_id,paired_solid_sha256,cutover_source_sha256) VALUES($1,$2,$1,$1)",
          ["a".repeat(64), runId],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await denied("UPDATE video_alias_audit_runs_v1 SET complete=true WHERE run_id=$1", [runId]);
      // The separately trusted fixture migration LOGIN owns the DDL. No
      // membership in that owner is granted to runtime or audit operator.
      const source = await Bun.file(
        new URL("../../../db/postgres/candidates/notifications-video-cutover.sql", import.meta.url),
      ).text();
      const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source)),
      );
      const plan = {
        contract_sha256: "36e74a67ee280677436ff0d7ea7d1fd6243db3dc9432645a23a2402e2d03ec19",
        plan_sha256: "a".repeat(64),
        alias_run_id: runId,
        paired_solid_sha256: "b".repeat(64), // fixture only, not paired runtime acceptance
        cutover_source_sha256: Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join(""),
      };
      const cutover = await runVideoAdmissionFixture(f.runtime, (admission) =>
        Effect.gen(function* () {
          yield* admission.drain();
          const first = yield* admission.cutover(plan, source);
          const replay = yield* admission.cutover(plan, source);
          return { first, replay };
        }),
      );
      expect(cutover.first).toEqual({ alreadyCommitted: false });
      expect(cutover.replay).toEqual({ alreadyCommitted: true });
      await denied("SELECT * FROM video_notification_cutovers_v1");
      await denied("UPDATE video_notification_cutovers_v1 SET paired_solid_sha256=$1", [
        "c".repeat(64),
      ]);
      // These post-Dance notification functions deliberately revoke hostile
      // default/inherited EXECUTE. Bind each actual purpose through the owned
      // migration function; this does not grant access to private Dance rows.
      const notificationFunctions = [
        "readable_recipient_notification_v2(text,text,text)",
        "pending_recipient_notifications_v2()",
        "deliver_recipient_notification_v2(text)",
      ];
      for (const fn of notificationFunctions)
        expect(
          (
            await runtime.query(
              "SELECT has_function_privilege(current_user,$1,'EXECUTE') AS allowed",
              [fn],
            )
          ).rows[0].allowed,
        ).toBe(false);
      await denied("SELECT * FROM dance_moderated_reviews_v1");
      await denied("SELECT grant_dance_result_notification_runtime_v2($1,'account')", [
        runtimeRole,
      ]);
      await f.admin.query("SELECT grant_dance_result_notification_runtime_v2($1,'account')", [
        runtimeRole,
      ]);
      await f.admin.query(
        "SELECT grant_dance_result_notification_runtime_v2($1,'notification_worker')",
        [runtimeRole],
      );
      for (const fn of notificationFunctions)
        expect(
          (
            await runtime.query(
              "SELECT has_function_privilege(current_user,$1,'EXECUTE') AS allowed",
              [fn],
            )
          ).rows[0].allowed,
        ).toBe(true);
      await denied("SELECT * FROM dance_moderated_reviews_v1");
      // Ordinary runtime inbox access survives removal of the private defaults.
      expect(
        await f.run(
          makeControlPlaneNotificationStore(makeDirectPostgresControlPlaneLayer(runtimeUrl)).list({
            recipientUserId: "inbox-owner",
          }),
        ),
      ).toMatchObject({ items: [], unread_count: 0 });
      // Forward defaults are unchanged globally and still apply to unrelated
      // future objects. Only this candidate's private objects were revoked.
      await f.admin.query("CREATE TABLE video_acl_forward_probe(value integer)");
      await f.admin.query(
        "CREATE FUNCTION video_acl_forward_probe_fn() RETURNS integer LANGUAGE sql AS 'SELECT 7'",
      );
      await runtime.query("INSERT INTO video_acl_forward_probe VALUES(7)");
      expect(
        (
          await runtime.query(
            "SELECT value,video_acl_forward_probe_fn() AS function_value FROM video_acl_forward_probe",
          )
        ).rows,
      ).toEqual([{ value: 7, function_value: 7 }]);
      // Real post-cutover video delivery/read/recovery/erasure under this LOGIN,
      // after private table/function revocation and without owner membership.
      const videos = (
        await f.admin.query<{ post_id: string; community_id: string; author_user_id: string }>(
          "SELECT post_id,community_id,author_user_id FROM posts WHERE post_type='video' AND status='published'",
        )
      ).rows;
      expect(videos).toHaveLength(1);
      const video = videos[0];
      if (!video) throw new Error("Published video role fixture required");
      const posted = await f.submit(
        "acl-video-current",
        undefined,
        "inbox-author",
        false,
        video.post_id,
        video.community_id,
      );
      if (posted.kind !== "created" && posted.kind !== "replay")
        throw new Error("Real video comment publication required");
      const fact = (
        await f.admin.query<{ outbox_event_id: string }>(
          "SELECT outbox_event_id FROM content_publication_outbox WHERE submission_id=$1 AND event_type='comment_notification'",
          [posted.snapshot.submission_id],
        )
      ).rows[0];
      if (!fact) throw new Error("Real video notification fact required");
      const serving = makeControlPlaneNotificationStore(
        makeDirectPostgresControlPlaneLayer(runtimeUrl),
      );
      const page = await f.run(serving.list({ recipientUserId: video.author_user_id }));
      expect(page.unread_count).toBe(1);
      expect(page.items).toHaveLength(1);
      const item = page.items[0];
      if (!item) throw new Error("Role-readable video inbox item required");
      const read = await f.run(
        serving.read({
          recipientUserId: video.author_user_id,
          notificationId: item.notification_id,
        }),
      );
      expect(
        await f.run(
          serving.read({
            recipientUserId: video.author_user_id,
            notificationId: item.notification_id,
          }),
        ),
      ).toEqual(read);
      expect(await f.run(serving.recover())).toMatchObject({ examined: 0, processed: 0 });
      expect(await f.run(serving.deliver({ sourceEventId: fact.outbox_event_id }))).toEqual({
        processed: false,
        delivered: true,
      });
      const terminal = (
        await f.admin.query(
          "SELECT to_jsonb(d)-'notification_id' AS retained FROM notification_publication_deliveries d WHERE source_event_id=$1",
          [fact.outbox_event_id],
        )
      ).rows;
      await runtime.query("UPDATE users SET status='deleted' WHERE user_id=$1", [
        video.author_user_id,
      ]);
      expect(
        (
          await f.admin.query(
            "SELECT notification_id,to_jsonb(d)-'notification_id' AS retained FROM notification_publication_deliveries d WHERE source_event_id=$1",
            [fact.outbox_event_id],
          )
        ).rows,
      ).toEqual([{ notification_id: null, retained: terminal[0].retained }]);
      expect(
        (
          await runtime.query(
            "SELECT count(*)::int AS n FROM notification_inbox WHERE recipient_user_id=$1",
            [video.author_user_id],
          )
        ).rows[0].n,
      ).toBe(0);
      expect(await f.run(serving.deliver({ sourceEventId: fact.outbox_event_id }))).toEqual({
        processed: false,
        delivered: true,
      });
      await denied("SELECT * FROM video_notification_cutovers_v1");
    },
    async (admin, schema, scopedUrl) => {
      const loginUrl = (role: string) => {
        const url = new URL(scopedUrl);
        url.username = role;
        url.password = password;
        return url.toString();
      };
      runtimeUrl = loginUrl(runtimeRole);
      operatorUrl = loginUrl(operatorRole);
      return provisionNotificationsVideoAclRoles({
        admin,
        schema,
        runtimeRole,
        inheritedRole,
        operatorRole,
        password,
        clients,
      });
    },
    "full_migrations",
  );
}

// The real pre-DDL callback and offline fault tests use this same provisioning path.
export async function provisionNotificationsVideoAclRoles({
  admin,
  schema,
  runtimeRole,
  inheritedRole,
  operatorRole,
  password,
  clients,
}: {
  admin: { query(sql: string): Promise<unknown> };
  schema: string;
  runtimeRole: string;
  inheritedRole: string;
  operatorRole: string;
  password: string;
  clients: readonly { end(): Promise<void> }[];
}) {
  const created: string[] = [];
  const cleanup = async () => {
    const closes = await Promise.allSettled(clients.map(async (client) => client.end()));
    const failures: unknown[] = closes.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    // Failed closure retains the roles; a failed DDL stops further role removal.
    if (failures.length === 0) {
      try {
        for (const role of [runtimeRole, operatorRole, inheritedRole]) {
          if (!created.includes(role)) continue;
          await admin.query(`DROP OWNED BY "${role}"`);
          await admin.query(`DROP ROLE "${role}"`);
        }
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, "Video ACL cleanup failed", { cause: failures[0] });
  };
  try {
    // BEFORE all application migrations: preserve direct/inherited and PUBLIC defaults.
    await admin.query(`CREATE ROLE "${inheritedRole}" NOLOGIN`);
    created.push(inheritedRole);
    for (const role of [runtimeRole, operatorRole]) {
      await admin.query(
        `CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`,
      );
      created.push(role);
    }
    await admin.query(`GRANT "${inheritedRole}" TO "${runtimeRole}"`);
    await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${runtimeRole}","${operatorRole}"`);
    await admin.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA "${schema}" GRANT ALL ON TABLES TO "${runtimeRole}","${inheritedRole}",PUBLIC`,
    );
    await admin.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA "${schema}" GRANT EXECUTE ON FUNCTIONS TO "${runtimeRole}","${inheritedRole}"`,
    );
    return cleanup;
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Video ACL setup/cleanup failed", {
        cause: error,
      });
    }
    throw error;
  }
}
