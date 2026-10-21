/** Maintained registration only; real SQL/LOGIN proof is UNRUN by this writer. */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import {
  assertNotificationErasurePrivileges,
  NOTIFICATION_ERASURE_PRIVILEGES_SQL,
  notificationErasurePrivilegeParameters,
} from "../../packages/platform-cf/src/notification-erasure-privileges.ts";
import { withInbox } from "../../packages/platform-cf/src/notifications.pg-fixture.ts";
import { emptyTelegramIntegration } from "../../packages/platform-cf/src/telegram-settings-store.ts";
import {
  loadPostgresMigrations,
  runPostgresMigrations,
} from "../../scripts/postgres-migrations.ts";
import {
  notificationRoleImmutableHistory,
  verifyNotificationRoleAccess,
} from "./notifications-role-access.pg-fixture.ts";
import { exerciseNotificationTriggerShapeNegatives } from "./notifications-trigger-shape.pg-fixture.ts";

export async function notificationErasureOperatorGrant(role: string): Promise<string> {
  if (!/^(?:notifications_acl|telegram_runtime)_[0-9a-f]{32}$/u.test(role))
    throw new Error("Disposable erasure executor role required");
  const source = await readFile(
    new URL("../../db/postgres/roles.sql.example", import.meta.url),
    "utf8",
  );
  const grant = source
    .split("-- Notifications account erasure grants begin")[1]
    ?.split("-- Notifications account erasure grants end")[0]
    ?.trim();
  if (grant !== "GRANT DELETE ON notification_inbox TO api_next_app;")
    throw new Error("Bounded operational erasure policy differs");
  return grant.replaceAll("api_next_app", role);
}

/** Historical provisioning happens after0236, before0237, through the actual
 * checksum loader/runner/expected ledger. No baseline or migration SQL replay. */
export async function prepareHistoricalTelegramErasureSchema(input: {
  readonly admin: Client;
  readonly schema: string;
  readonly baseUrl: string;
  readonly runtimeRole: string;
  readonly readerRole: string;
  readonly runtimePassword: string;
  readonly readerPassword: string;
  readonly template: string;
}): Promise<void> {
  const { admin, schema, runtimeRole, readerRole, template } = input;
  if (
    !/^telegram_acl_[0-9a-f]{32}$/u.test(schema) ||
    !/^telegram_runtime_[0-9a-f]{32}$/u.test(runtimeRole) ||
    !/^telegram_reader_[0-9a-f]{32}$/u.test(readerRole) ||
    !/^[0-9a-f]{32}$/u.test(input.runtimePassword) ||
    !/^[0-9a-f]{32}$/u.test(input.readerPassword)
  )
    throw new Error("Historical fixture identifiers differ");
  await admin.query(`SET search_path TO "${schema}"`);
  const initial = await admin.query(
    `SELECT current_user::text AS creator,current_schema() AS selected,
    pg_get_userbyid(n.nspowner) AS owner,
    (SELECT count(*)::int FROM pg_class WHERE relnamespace=n.oid) AS relations,
    (SELECT count(*)::int FROM pg_proc WHERE pronamespace=n.oid) AS functions,
    (SELECT count(*)::int FROM pg_type WHERE typnamespace=n.oid) AS types,
    to_regclass(format('%I.schema_migrations',$1::text))::text AS ledger FROM pg_namespace n WHERE n.nspname=$1`,
    [schema],
  );
  const before = initial.rows[0];
  if (
    initial.rows.length !== 1 ||
    !before ||
    before.creator !== before.owner ||
    before.selected !== schema
  )
    throw new Error("Owned empty historical schema required");
  expect({
    relations: before.relations,
    functions: before.functions,
    types: before.types,
    ledger: before.ledger,
  }).toEqual({ relations: 0, functions: 0, types: 0, ledger: null });
  const migrations = await loadPostgresMigrations();
  const linking = migrations.findIndex(
    (migration) => migration.version === "0237_telegram_learner_linking.sql",
  );
  expect(linking).toBe(236);
  // Keep the historical boundary exact while running the complete current,
  // checksum-verified successor plan below, including later migrations.
  expect(migrations[274]?.version).toBe("0275_video_root_comment_ordering.sql");
  expect(
    migrations.every((migration, index) =>
      migration.version.startsWith(`${String(index + 1).padStart(4, "0")}_`),
    ),
  ).toBe(true);
  const url = new URL(input.baseUrl);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const scoped = new Client({ connectionString: url.toString() });
  try {
    await scoped.connect();
    const identity = await scoped.query(
      `SELECT current_user::text AS creator,current_schema() AS selected,
      (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname=$1::text) AS owner,
      (SELECT count(*)::int FROM pg_class WHERE relnamespace=$1::text::regnamespace) AS relations,
      (SELECT count(*)::int FROM pg_proc WHERE pronamespace=$1::text::regnamespace) AS functions,
      to_regclass(format('%I.schema_migrations',$1::text))::text AS ledger`,
      [schema],
    );
    expect(identity.rows).toEqual([
      {
        creator: before.creator,
        selected: schema,
        owner: before.creator,
        relations: 0,
        functions: 0,
        ledger: null,
      },
    ]);
  } finally {
    await scoped.end();
  }
  const prior = migrations.slice(0, linking);
  const first = await runPostgresMigrations({
    connectionString: url.toString(),
    migrations: prior,
    expectedLedger: [],
  });
  if (first.dryRun) throw new Error("Historical initialization was only a dry run");
  expect(first.result.applied).toEqual(prior.map(({ version }) => version));
  const ledger = prior.map(({ version, checksum }) => ({ version, checksum }));
  expect(
    (await admin.query("SELECT version,checksum FROM schema_migrations ORDER BY version")).rows,
  ).toEqual(ledger);
  const prefix = template.split("-- Canonical M3")[0];
  const retention = template.match(
    /REVOKE DELETE ON\s+community_purchase_funding_journal,\s+community_purchase_funding_requests,\s+community_purchase_funding_plans\s+FROM api_next_app;/u,
  )?.[0];
  if (!prefix || !retention || !prefix.includes("CREATE ROLE api_next_app LOGIN;"))
    throw new Error("Historical operational provisioning source missing");
  await admin.query("BEGIN");
  try {
    await admin.query("SET LOCAL password_encryption='scram-sha-256'");
    await admin.query(
      prefix
        .replace(
          "CREATE ROLE api_next_app LOGIN;",
          `CREATE ROLE api_next_app LOGIN PASSWORD '${input.runtimePassword}';`,
        )
        .replaceAll("api_next_app", runtimeRole)
        .replaceAll("SCHEMA public", `SCHEMA "${schema}"`),
    );
    await admin.query(retention.replaceAll("api_next_app", runtimeRole));
    await admin.query(`CREATE ROLE ${readerRole} LOGIN PASSWORD '${input.readerPassword}'`);
    await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO ${readerRole}`);
    await admin.query(`REVOKE DELETE ON megapot_pool_shares FROM ${runtimeRole}`);
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
  const final = await runPostgresMigrations({
    connectionString: url.toString(),
    migrations,
    expectedLedger: ledger,
  });
  if (final.dryRun) throw new Error("Historical migration successor was only a dry run");
  expect(final.result.applied).toEqual(migrations.slice(linking).map(({ version }) => version));
  expect(
    (await admin.query("SELECT version,checksum FROM schema_migrations ORDER BY version")).rows,
  ).toEqual(migrations.map(({ version, checksum }) => ({ version, checksum })));
  expect(
    (
      await admin.query(
        `SELECT current_user::text AS creator,pg_get_userbyid(nspowner) AS owner,
          (SELECT bool_and(relowner=nspowner) FROM pg_class
            WHERE relnamespace=pg_namespace.oid AND relname IN ('schema_migrations','notification_inbox','notification_publication_deliveries','video_alias_audit_runs_v1')) AS anchored_tables
          FROM pg_namespace WHERE nspname=$1::text`,
        [schema],
      )
    ).rows,
  ).toEqual([{ creator: before.creator, owner: before.creator, anchored_tables: true }]);
  // Do not re-grant SELECT on ALL tables after0273's private ACL cleanup.
  await admin.query(
    `GRANT SELECT ON users,telegram_account_associations,telegram_link_transactions,telegram_link_navigation,telegram_bot_grants TO ${readerRole}`,
  );
}

export function registerNotificationAccountErasureCases(completed: () => void) {
  const suite = process.env.CONTROL_PLANE_POSTGRES_TEST_URL ? describe : describe.skip;
  suite("minimal invoker account erasure and effective runtime authority", () => {
    test("real LOGIN empty/populated erasure is atomic without authority, bounded with the operator policy and cannot resurrect history", async () => {
      const executor = `notifications_acl_${crypto.randomUUID().replaceAll("-", "")}`;
      const carrier = `notifications_acl_${crypto.randomUUID().replaceAll("-", "")}`;
      const forward = `notifications_acl_${crypto.randomUUID().replaceAll("-", "")}`;
      const password = crypto.randomUUID().replaceAll("-", "");
      const clients: Client[] = [];
      await withInbox(
        async (f) => {
          const login = (role: string) => {
            const url = new URL(f.url);
            url.username = role;
            url.password = password;
            return url.toString();
          };
          await f.admin.query(
            `GRANT SELECT ON users,notification_inbox,telegram_bot_grants,telegram_link_transactions,telegram_account_associations TO ${executor}`,
          );
          await f.admin.query(`GRANT UPDATE(status) ON users TO ${executor}`);
          await f.admin.query(`GRANT DELETE ON telegram_account_associations TO ${executor}`);
          await f.admin.query(
            `GRANT UPDATE(active,revision) ON telegram_bot_grants TO ${executor}`,
          );
          await f.admin.query(
            `GRANT UPDATE(state,state_hash,secret_ciphertext) ON telegram_link_transactions TO ${executor}`,
          );
          const runtime = new Client({ connectionString: login(executor) });
          clients.push(runtime);
          await runtime.connect();
          const inherited = new Client({ connectionString: login(forward) });
          clients.push(inherited);
          await inherited.connect();
          await verifyNotificationRoleAccess(runtime, executor, "deletion", [
            "users",
            "notification_inbox",
            "notification_publication_deliveries",
          ]);
          await verifyNotificationRoleAccess(inherited, forward, "deletion", [
            "users",
            "notification_inbox",
            "notification_publication_deliveries",
          ]);
          // f.url, rather than a guessed schema, is the actual initialized owner scope.
          const schema = new URL(f.url).searchParams
            .get("options")
            ?.match(/^-c search_path=(api_next_notifications_[0-9a-f]{32})$/u)?.[1];
          if (!schema) throw new Error("Maintained schema-scoped fixture URL required");
          const privilegeFacts = async () =>
            (
              await runtime.query(NOTIFICATION_ERASURE_PRIVILEGES_SQL, [
                ...notificationErasurePrivilegeParameters(schema),
              ])
            ).rows;
          const sources = [await f.publish("erasure-one"), await f.publish("erasure-two")];
          const receipts = (
            await f.admin.query(
              "SELECT * FROM notification_publication_deliveries ORDER BY source_event_id",
            )
          ).rows;
          const immutable = await notificationRoleImmutableHistory(f.admin);
          const responseBytes = async () =>
            (
              await f.admin.query(
                "SELECT submission_id,encode(response_snapshot_bytes,'hex') AS bytes,response_snapshot_sha256 FROM text_content_submissions ORDER BY submission_id",
              )
            ).rows;
          const responses = await responseBytes();
          const inbox = (
            await f.admin.query("SELECT * FROM notification_inbox ORDER BY delivery_order")
          ).rows;
          expect(inbox).toHaveLength(2);
          await f.admin.query(
            `INSERT INTO community_telegram_integrations(community_id,record,revision,bot_epoch,webhook_id) VALUES('inbox-community',$1::jsonb,1,'epoch','hook')`,
            [JSON.stringify(emptyTelegramIntegration("inbox-community"))],
          );
          for (const [account, telegram, letter] of [
            ["inbox-owner", "654", "d"],
            ["inbox-other", "321", "o"],
          ] as const) {
            const persona = f.personas[account];
            if (!persona) throw new Error("Maintained persona required");
            await f.admin.query(
              "INSERT INTO telegram_account_associations(telegram_user_id,account_id) VALUES($1,$2)",
              [telegram, account],
            );
            await f.admin.query(
              "INSERT INTO telegram_bot_grants(community_id,bot_id,telegram_user_id,account_id,persona_id,revision) VALUES('inbox-community','123',$1,$2,$3,1)",
              [telegram, account, persona],
            );
            await f.admin.query(
              "INSERT INTO telegram_link_transactions(transaction_id,account_id,session_hash,browser_hash,state_hash,secret_ciphertext,community_id,bot_id,bot_epoch,expected_telegram_user_id,post_id,state) VALUES($1,$2,$3,$4,$5,'fixture-ciphertext','inbox-community','123','epoch',$6,'inbox-post','pending')",
              [
                letter.repeat(43),
                account,
                "s".repeat(43),
                "b".repeat(43),
                "h".repeat(43),
                telegram,
              ],
            );
          }
          const telegramState = async () =>
            (
              await f.admin.query(`SELECT
          (SELECT jsonb_agg(to_jsonb(g) ORDER BY telegram_user_id) FROM telegram_bot_grants g) AS grants,
          (SELECT jsonb_agg(to_jsonb(t) ORDER BY transaction_id) FROM telegram_link_transactions t) AS transactions,
          (SELECT jsonb_agg(to_jsonb(a) ORDER BY telegram_user_id) FROM telegram_account_associations a) AS associations`)
            ).rows;
          const beforeTelegram = await telegramState();
          const before = await privilegeFacts();
          expect(() => assertNotificationErasurePrivileges(before)).toThrow();
          for (const account of ["inbox-other", "inbox-owner"]) {
            await expect(
              runtime.query("UPDATE users SET status='deleted' WHERE user_id=$1", [account]),
            ).rejects.toMatchObject({
              code: "42501",
              message: expect.stringContaining("notification_inbox"),
            });
            expect(
              (await f.admin.query("SELECT status FROM users WHERE user_id=$1", [account])).rows,
            ).toEqual([{ status: "active" }]);
            expect(await telegramState()).toEqual(beforeTelegram);
            expect(
              (await f.admin.query("SELECT * FROM notification_inbox ORDER BY delivery_order"))
                .rows,
            ).toEqual(inbox);
            expect(await notificationRoleImmutableHistory(f.admin)).toEqual(immutable);
          }
          const policy = await notificationErasureOperatorGrant(executor);
          await f.admin.query(policy);
          await f.admin.query(policy);
          await exerciseNotificationTriggerShapeNegatives({
            admin: f.admin,
            runtime,
            schema,
            executor,
          });
          expect(assertNotificationErasurePrivileges(await privilegeFacts())).toBe(executor);
          expect(
            (
              await runtime.query(
                "SELECT has_table_privilege(current_user,'notification_publication_deliveries','UPDATE') AS table_update,has_any_column_privilege(current_user,'notification_publication_deliveries','UPDATE') AS column_update",
              )
            ).rows,
          ).toEqual([{ table_update: false, column_update: false }]);
          await expect(runtime.query("DELETE FROM notification_inbox")).rejects.toThrow("erasure");
          await runtime.query("UPDATE users SET status='deleted' WHERE user_id='inbox-other'");
          expect(
            (await f.admin.query("SELECT * FROM notification_inbox ORDER BY delivery_order")).rows,
          ).toEqual(inbox);
          await runtime.query("UPDATE users SET status='deleted' WHERE user_id='inbox-owner'");
          expect((await f.admin.query("SELECT * FROM notification_inbox")).rows).toEqual([]);
          expect(
            (
              await f.admin.query(
                "SELECT * FROM notification_publication_deliveries ORDER BY source_event_id",
              )
            ).rows,
          ).toEqual(receipts.map((receipt) => ({ ...receipt, notification_id: null })));
          expect(await notificationRoleImmutableHistory(f.admin)).toEqual(immutable);
          expect(await responseBytes()).toEqual(responses);
          expect(
            (
              await f.admin.query(
                "SELECT active,revision FROM telegram_bot_grants ORDER BY telegram_user_id",
              )
            ).rows,
          ).toEqual([
            { active: false, revision: "2" },
            { active: false, revision: "2" },
          ]);
          expect(
            (
              await f.admin.query(
                "SELECT state,state_hash,secret_ciphertext FROM telegram_link_transactions ORDER BY transaction_id",
              )
            ).rows,
          ).toEqual([
            { state: "cancelled", state_hash: null, secret_ciphertext: null },
            { state: "cancelled", state_hash: null, secret_ciphertext: null },
          ]);
          expect((await f.admin.query("SELECT * FROM telegram_account_associations")).rows).toEqual(
            [],
          );
          const erasedTelegram = await telegramState();
          await runtime.query(
            "UPDATE users SET status='deleted' WHERE user_id IN ('inbox-owner','inbox-other')",
          );
          for (const source of sources)
            expect(await f.run(f.store.deliver({ sourceEventId: source.eventId }))).toEqual({
              processed: false,
              delivered: true,
            });
          expect(await f.run(f.store.recover())).toMatchObject({ examined: 0, processed: 0 });
          expect(await f.run(f.store.list({ recipientUserId: "inbox-owner" }))).toMatchObject({
            items: [],
            unread_count: 0,
          });
          expect(await telegramState()).toEqual(erasedTelegram);
          expect(await notificationRoleImmutableHistory(f.admin)).toEqual(immutable);
          expect(await responseBytes()).toEqual(responses);
          for (const table of [
            "notification_inbox",
            "notification_publication_deliveries",
            "telegram_bot_grants",
            "megapot_pool_shares",
            "community_purchase_funding_journal",
          ]) {
            if (table !== "notification_inbox")
              await expect(runtime.query(`DELETE FROM ${table} WHERE FALSE`)).rejects.toMatchObject(
                { code: "42501" },
              );
            await expect(runtime.query(`TRUNCATE ${table}`)).rejects.toMatchObject({
              code: "42501",
            });
          }
          await expect(
            runtime.query(
              "UPDATE notification_publication_deliveries SET notification_id=NULL WHERE FALSE",
            ),
          ).rejects.toMatchObject({ code: "42501" });
          await f.admin.query("CREATE TABLE notifications_erasure_forward_probe(id integer)");
          await inherited.query("INSERT INTO notifications_erasure_forward_probe VALUES(1)");
          await inherited.query("UPDATE notifications_erasure_forward_probe SET id=2");
          for (const action of ["DELETE FROM", "TRUNCATE"])
            await expect(
              inherited.query(`${action} notifications_erasure_forward_probe`),
            ).rejects.toMatchObject({ code: "42501" });
          const forwardFacts = (
            await inherited.query(NOTIFICATION_ERASURE_PRIVILEGES_SQL, [
              ...notificationErasurePrivilegeParameters(schema),
            ])
          ).rows;
          expect(forwardFacts[0]?.account_status_executor).toBe(true);
          expect(() => assertNotificationErasurePrivileges(forwardFacts)).toThrow();
          await expect(
            inherited.query("UPDATE users SET status='deleted' WHERE user_id='inbox-author'"),
          ).rejects.toMatchObject({ code: "42501" });
          expect(
            (await f.admin.query("SELECT status FROM users WHERE user_id='inbox-author'")).rows,
          ).toEqual([{ status: "active" }]);
          // Inject and undo only adversarial fixture authority; none of these
          // REVOKEs manufactures the initial0273 private-ACL positive proof.
          await f.admin.query(`GRANT DELETE ON notification_inbox TO ${carrier}`);
          await f.admin.query(`GRANT ${carrier} TO ${executor}`);
          const inheritedAuthority = await privilegeFacts();
          expect(() => assertNotificationErasurePrivileges(inheritedAuthority)).toThrow();
          await f.admin.query(`REVOKE ${carrier} FROM ${executor}`);
          await f.admin.query(
            `ALTER DEFAULT PRIVILEGES IN SCHEMA "${schema}" GRANT DELETE ON TABLES TO ${executor}`,
          );
          const defaultAuthority = await privilegeFacts();
          expect(() => assertNotificationErasurePrivileges(defaultAuthority)).toThrow();
          await f.admin.query(
            `ALTER DEFAULT PRIVILEGES IN SCHEMA "${schema}" REVOKE DELETE ON TABLES FROM ${executor}`,
          );
          expect(assertNotificationErasurePrivileges(await privilegeFacts())).toBe(executor);
        },
        async (admin, schema) => {
          const created: string[] = [];
          const cleanup = async () => {
            const failures: unknown[] = [];
            for (const client of clients) {
              try {
                await client.end();
              } catch (error) {
                failures.push(error);
              }
            }
            for (const role of [...created].reverse()) {
              try {
                const present = await admin.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [
                  role,
                ]);
                if (!present.rowCount) continue;
                await admin.query(`DROP OWNED BY ${role}`);
                await admin.query(`DROP ROLE ${role}`);
              } catch (error) {
                failures.push(error);
              }
            }
            if (failures.length)
              throw new AggregateError(failures, "Account-erasure fixture cleanup failed");
          };
          try {
            await admin.query("BEGIN");
            await admin.query("SET LOCAL password_encryption='scram-sha-256'");
            for (const role of [executor, carrier, forward]) {
              await admin.query(
                `CREATE ROLE ${role} ${role === carrier ? "NOLOGIN" : `LOGIN PASSWORD '${password}'`}`,
              );
              created.push(role);
              await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO ${role}`);
            }
            await admin.query(
              `ALTER DEFAULT PRIVILEGES IN SCHEMA "${schema}" GRANT SELECT,INSERT,UPDATE ON TABLES TO ${forward}`,
            );
            await admin.query("COMMIT");
            return cleanup;
          } catch (error) {
            const failures: unknown[] = [error];
            try {
              await admin.query("ROLLBACK");
            } catch (rollback) {
              failures.push(rollback);
            }
            try {
              await cleanup();
            } catch (dispose) {
              failures.push(dispose);
            }
            if (failures.length > 1)
              throw new AggregateError(
                failures,
                "Account-erasure provisioning and cleanup failed",
                { cause: error },
              );
            throw error;
          }
        },
        "full_migrations",
      );
      completed();
    }, 120000);
  });
}
