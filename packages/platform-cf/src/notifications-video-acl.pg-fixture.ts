/** Parent's predecessor LOGIN workflow failed; repaired successor is UNRUN here.
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
    },
    async (admin, schema, scopedUrl) => {
      // BEFORE baseline and BOTH candidates: exercise direct plus inherited
      // named table/function defaults, and PUBLIC table defaults.
      await admin.query(`CREATE ROLE "${inheritedRole}" NOLOGIN`);
      for (const role of [runtimeRole, operatorRole])
        await admin.query(
          `CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`,
        );
      await admin.query(`GRANT "${inheritedRole}" TO "${runtimeRole}"`);
      await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${runtimeRole}","${operatorRole}"`);
      await admin.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA "${schema}" GRANT ALL ON TABLES TO "${runtimeRole}","${inheritedRole}",PUBLIC`,
      );
      await admin.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA "${schema}" GRANT EXECUTE ON FUNCTIONS TO "${runtimeRole}","${inheritedRole}"`,
      );
      const loginUrl = (role: string) => {
        const url = new URL(scopedUrl);
        url.username = role;
        url.password = password;
        return url.toString();
      };
      runtimeUrl = loginUrl(runtimeRole);
      operatorUrl = loginUrl(operatorRole);
      return async () => {
        for (const client of clients) await client.end();
        for (const role of [runtimeRole, operatorRole, inheritedRole]) {
          await admin.query(`DROP OWNED BY "${role}"`);
          await admin.query(`DROP ROLE "${role}"`);
        }
      };
    },
  );
}
