import { expect } from "bun:test";
import { AlertCollector } from "@pirate/application";
import { Effect } from "effect";
import { Client } from "pg";
import { makeNotificationHandlers } from "../../apps/http-worker/src/notification-handlers.ts";
import { createHttpWorker } from "../../apps/http-worker/src/transport.ts";
import { makeNotificationDeliveryJob } from "../../apps/jobs-worker/src/notification-delivery.ts";
import { JobContext } from "../../apps/jobs-worker/src/registry.ts";
import { withInbox } from "../../packages/platform-cf/src/notifications.pg-fixture.ts";
import { makeControlPlaneNotificationStore } from "../../packages/platform-cf/src/notifications-repository.ts";
import { makeDirectPostgresControlPlaneLayer } from "../../packages/platform-cf/src/postgres.ts";
import {
  grantNotificationVideoReads,
  notificationRoleImmutableHistory,
  verifyNotificationFirstDelivery,
  verifyNotificationRoleAccess,
} from "./notifications-role-access.pg-fixture.ts";

const sourceReads = [
  "users",
  "communities",
  "community_memberships",
  "posts",
  "comments",
  "text_content_submissions",
  "content_publication_outbox",
  "notification_inbox",
  "account_age_verification_current",
  "age_verification_requirement_states",
  "age_verification_ceremony_attempts",
  "assertions",
  "evidence_receipts",
  "proof_sessions",
  "assertion_bindings",
  "active_subject_key_bindings",
  "assertion_revalidation_events",
];
const navigationReads = [
  "personas",
  "persona_profiles",
  "public_handle_index",
  "post_slug_aliases",
];
export async function exerciseNotificationRoles() {
  const roles = Array.from(
    { length: 4 },
    () => `notifications_acl_${crypto.randomUUID().replaceAll("-", "")}`,
  );
  const [http, jobs, deletion, forward] = roles as [string, string, string, string];
  // CI uses password authentication. These belong only to the disposable test
  // logins, stay in memory, and disappear with the roles; never reuse the
  // fixture administrator's password or emit a connection URL/password.
  const passwords = Object.fromEntries(
    roles.map((role) => [role, crypto.randomUUID().replaceAll("-", "")]),
  );
  const connected: Client[] = [];
  await withInbox(
    async (f) => {
      const login = (role: string) => {
        const url = new URL(f.url);
        url.username = role;
        url.password = passwords[role] ?? "";
        return url.toString();
      };
      const grant = async (sql: string) => f.admin.query(sql);
      for (const role of [http, jobs, forward]) {
        // Forward inbox SELECT/INSERT/UPDATE must come from its pre-DDL
        // defaults, not an explicit replacement grant in this callback.
        const reads =
          role === forward
            ? sourceReads.filter((table) => table !== "notification_inbox")
            : sourceReads;
        await grant(`GRANT SELECT ON ${reads.join(",")} TO ${role}`);
      }
      await grantNotificationVideoReads(f.admin, [http, jobs, forward]);
      for (const role of [http, forward])
        await grant(`GRANT SELECT ON ${navigationReads.join(",")} TO ${role}`);
      await grant(`GRANT UPDATE(read_at) ON notification_inbox TO ${http}`);
      await grant(`GRANT SELECT ON notification_publication_deliveries TO ${jobs}`);
      for (const role of [jobs, forward]) {
        // SELECT FOR SHARE requires UPDATE on at least one users column. The
        // existing production shared runtime has UPDATE; this dedicated Jobs
        // fixture confines that grant to status rather than all columns.
        await grant(`GRANT UPDATE(status) ON users TO ${role}`);
        await grant(
          `GRANT UPDATE(state,published_at,inbox_delivery_recorded) ON content_publication_outbox TO ${role}`,
        );
      }
      await grant(
        `GRANT INSERT ON notification_inbox,notification_publication_deliveries TO ${jobs}`,
      );
      await grant(
        `GRANT SELECT ON users,notification_inbox,notification_publication_deliveries,telegram_bot_grants,telegram_link_transactions,telegram_account_associations TO ${deletion}`,
      );
      await grant(`GRANT UPDATE(status) ON users TO ${deletion}`);
      await grant(
        `GRANT DELETE ON notification_inbox,telegram_account_associations TO ${deletion}`,
      );
      await grant(
        `GRANT UPDATE(notification_id) ON notification_publication_deliveries TO ${deletion}`,
      );
      await grant(`GRANT UPDATE(active,revision) ON telegram_bot_grants TO ${deletion}`);
      await grant(
        `GRANT UPDATE(state,state_hash,secret_ciphertext) ON telegram_link_transactions TO ${deletion}`,
      );
      const clients = new Map<string, Client>();
      for (const [role, caller] of [
        [http, "http"],
        [jobs, "jobs"],
        [deletion, "deletion"],
        [forward, "forward"],
      ] as const) {
        const client = new Client({ connectionString: login(role) });
        await client.connect();
        connected.push(client);
        clients.set(role, client);
        await verifyNotificationRoleAccess(client, role, caller, [
          ...sourceReads,
          ...navigationReads,
          "notification_publication_deliveries",
        ]);
      }
      const clientFor = (role: string) => {
        const client = clients.get(role);
        if (!client) throw new Error("authenticated fixture client missing");
        return client;
      };
      const runtimes = Object.fromEntries(
        roles.map((role) => [role, makeDirectPostgresControlPlaneLayer(login(role))]),
      );
      const runtimeFor = (role: string) => {
        const runtime = runtimes[role];
        if (!runtime) throw new Error("role runtime missing");
        return runtime;
      };
      const runJob = async (role: string) =>
        f.run(
          makeNotificationDeliveryJob({}).run.pipe(
            Effect.provide(runtimeFor(role)),
            Effect.provideService(AlertCollector, { emit: () => Effect.void }),
            Effect.provideService(JobContext, {
              owner: "acl-fixture",
              attemptId: "acl",
              lease: () => {
                throw new Error("unused lease");
              },
              adapterSafety: { isProven: () => true, markAbortedOrFenced: () => undefined },
            }),
          ),
        );
      const store = makeControlPlaneNotificationStore(runtimeFor(http));
      const worker = createHttpWorker({
        config: { corsOrigin: "https://solid.test" },
        authenticate: () => ({ kind: "user", subject: "inbox-owner" }),
        authorize: () => undefined,
        handlers: makeNotificationHandlers(store),
      });
      const headers = { cookie: "__Host-pirate_session=inbox-owner; __Host-pirate_csrf=proof" };
      await f.publish("acl-published");
      const first = await worker.request("https://worker.test/me/notifications", { headers });
      expect(first.status).toBe(200);
      const page = (await first.json()) as {
        items: { notification_id: string }[];
        unread_count: number;
      };
      expect(page.unread_count).toBe(1);
      const item = page.items[0];
      if (!item) throw new Error("HTTP inbox item required");
      const read = await worker.request(
        `https://worker.test/me/notifications/${item.notification_id}/read`,
        {
          method: "POST",
          headers: { ...headers, origin: "https://solid.test", "x-csrf-token": "proof" },
        },
      );
      expect(read.status).toBe(200);
      await f.admin.query(
        "ALTER TABLE content_publication_outbox DISABLE TRIGGER comment_notification_inbox_publication",
      );
      const missed = await f.publish("acl-missed");
      await f.admin.query(
        "ALTER TABLE content_publication_outbox ENABLE TRIGGER comment_notification_inbox_publication",
      );
      await verifyNotificationFirstDelivery(f.admin, missed.eventId, false);
      await runJob(jobs);
      await verifyNotificationFirstDelivery(f.admin, missed.eventId, true);
      const after = await worker.request("https://worker.test/me/notifications", { headers });
      expect(after.status).toBe(200);
      expect(((await after.json()) as { unread_count: number }).unread_count).toBe(1);
      await f.admin.query(
        "ALTER TABLE content_publication_outbox DISABLE TRIGGER comment_notification_inbox_publication",
      );
      const inherited = await f.publish("acl-defaults");
      await f.admin.query(
        "ALTER TABLE content_publication_outbox ENABLE TRIGGER comment_notification_inbox_publication",
      );
      await verifyNotificationFirstDelivery(f.admin, inherited.eventId, false);
      await runJob(forward); // INSERT/UPDATE on new tables inherited before migration
      await verifyNotificationFirstDelivery(f.admin, inherited.eventId, true);
      const afterForward = await worker.request("https://worker.test/me/notifications", {
        headers,
      });
      expect(afterForward.status).toBe(200);
      expect(await afterForward.json()).toMatchObject({ unread_count: 2 });
      const immutableHistory = await notificationRoleImmutableHistory(f.admin);
      const evidence = (
        await f.admin.query(
          `SELECT has_table_privilege($1,'notification_inbox','SELECT') AS inbox_select,
      has_table_privilege($1,'notification_inbox','INSERT') AS inbox_insert,
      has_table_privilege($1,'notification_inbox','UPDATE') AS inbox_update,
      has_table_privilege($1,'notification_publication_deliveries','SELECT') AS receipt_select,
      has_table_privilege($1,'notification_publication_deliveries','INSERT') AS receipt_insert,
      has_table_privilege($1,'notification_publication_deliveries','UPDATE') AS receipt_update,
      has_table_privilege($1,'notification_publication_deliveries','DELETE') AS receipt_delete`,
          [forward],
        )
      ).rows[0];
      expect(evidence).toEqual({
        inbox_select: true,
        inbox_insert: true,
        inbox_update: true,
        receipt_select: true,
        receipt_insert: true,
        receipt_update: true,
        receipt_delete: false,
      });
      const forwardClient = clientFor(forward);
      await expect(
        forwardClient.query(
          "UPDATE notification_publication_deliveries SET outcome='suppressed' WHERE source_event_id=$1",
          [missed.eventId],
        ),
      ).rejects.toThrow("immutable");
      await expect(
        forwardClient.query(
          "UPDATE content_publication_outbox SET created_at=created_at+interval '1 second' WHERE outbox_event_id=$1",
          [missed.eventId],
        ),
      ).rejects.toThrow("immutable");
      await f.admin.query("CREATE TABLE notifications_acl_forward_probe(id int)");
      await forwardClient.query("INSERT INTO notifications_acl_forward_probe VALUES (1)");
      await forwardClient.query("UPDATE notifications_acl_forward_probe SET id=2");
      await expect(
        forwardClient.query("DELETE FROM notifications_acl_forward_probe"),
      ).rejects.toThrow("permission denied");
      const httpClient = clientFor(http);
      await expect(
        httpClient.query(
          "UPDATE content_publication_outbox SET state='failed' WHERE outbox_event_id=$1",
          [missed.eventId],
        ),
      ).rejects.toThrow("permission denied");
      await expect(httpClient.query("DELETE FROM notification_inbox")).rejects.toThrow(
        "permission denied",
      );
      const deleteClient = clientFor(deletion);
      await expect(deleteClient.query("DELETE FROM notification_inbox")).rejects.toThrow("erasure");
      await deleteClient.query("UPDATE users SET status='deleted' WHERE user_id='inbox-owner'");
      expect(
        (
          await f.admin.query(
            "SELECT bool_and(notification_id IS NULL) AS cleared FROM notification_publication_deliveries",
          )
        ).rows[0].cleared,
      ).toBe(true);
      const erased = await worker.request("https://worker.test/me/notifications", { headers });
      expect(erased.status).toBe(200);
      expect(await erased.json()).toMatchObject({ items: [], unread_count: 0 });
      expect(await notificationRoleImmutableHistory(f.admin)).toEqual(immutableHistory);
      await runJob(jobs);
      expect(await notificationRoleImmutableHistory(f.admin)).toEqual(immutableHistory);
      await Bun.write(
        `.wrangler/adopted-source-agent/review-fixes-acl-${crypto.randomUUID()}.json`,
        JSON.stringify(
          {
            template: "db/postgres/roles.sql.example",
            forwardDefaultTables: "SELECT, INSERT, UPDATE",
            inherited: evidence,
            actualHttpListRead: true,
            actualJobsRecovery: true,
            actualJobsFirstDelivery: true,
            actualForwardFirstDelivery: true,
            initialization: "full_migrations",
            allFourPrivateEvidenceDenials: true,
            actualDeletedAccountTrigger: true,
            roleClasses: ["http", "jobs", "deletion", "forward-default-shared-runtime"],
            rolesAreDisposable: true,
            defaultSequenceGrantAdded: false,
          },
          null,
          2,
        ),
      );
    },
    async (admin, schema) => {
      const created: string[] = [];
      const cleanup = async () => {
        for (const client of connected) await client.end();
        for (const role of created.reverse()) {
          await admin.query(`DROP OWNED BY ${role}`);
          await admin.query(`DROP ROLE ${role}`);
        }
      };
      try {
        for (const role of roles) {
          await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${passwords[role]}'`);
          created.push(role);
          await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO ${role}`);
        }
        // Same table default as the accepted operational example, applied BEFORE
        // application DDL0001..0273. No production role or global/public default ACL is touched.
        await admin.query(
          `ALTER DEFAULT PRIVILEGES IN SCHEMA "${schema}" GRANT SELECT,INSERT,UPDATE ON TABLES TO ${forward}`,
        );
        return cleanup;
      } catch (error) {
        await cleanup();
        throw error;
      }
    },
    "full_migrations",
  );
}
