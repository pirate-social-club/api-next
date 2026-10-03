import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { emptyTelegramStudyState } from "@pirate/application/telegram-study";
import { Client } from "pg";
import { loadPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import {
  assertTelegramActivationPrivileges,
  TELEGRAM_ACTIVATION_PRIVILEGES_SQL,
} from "./telegram-activation-privileges.ts";
import { makeTelegramDatabase } from "./telegram-database.ts";
import { makeTelegramInboxStore } from "./telegram-inbox-store.ts";
import { makeControlPlaneTelegramLinkStore } from "./telegram-linking-repository.ts";
import { emptyTelegramIntegration } from "./telegram-settings-store.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !connectionString)
  throw new Error("Postgres test URL required");
const suite = connectionString ? describe : describe.skip;
const tables = [
  "telegram_account_associations",
  "telegram_link_transactions",
  "telegram_link_navigation",
];

suite("Telegram linking runtime privileges", () => {
  test("bounded grants repair unlink, both cleanup paths and account deletion without granting consent deletion", async () => {
    if (!connectionString) throw new Error("Postgres test URL required");
    const suffix = randomUUID().replaceAll("-", "");
    const schema = `telegram_acl_${suffix}`;
    const runtimeRole = `telegram_runtime_${suffix}`;
    const readerRole = `telegram_reader_${suffix}`;
    const admin = new Client({ connectionString });
    await admin.connect();
    const scoped = (role: string) => {
      const url = new URL(connectionString);
      url.searchParams.set("options", `-c search_path=${schema},pg_temp -c role=${role}`);
      return url.toString();
    };
    const runtime = new Client({ connectionString: scoped(runtimeRole) });
    const reader = new Client({ connectionString: scoped(readerRole) });
    try {
      await admin.query("BEGIN");
      await admin.query(`CREATE SCHEMA ${schema}`);
      await admin.query(`SET search_path TO ${schema}, pg_temp`);
      const migrations = await loadPostgresMigrations();
      const linking = migrations.findIndex(
        (m) => m.version === "0237_telegram_learner_linking.sql",
      );
      expect(linking).toBeGreaterThan(0);
      for (const migration of migrations.slice(0, linking)) await admin.query(migration.sql);
      const template = await readFile(
        new URL("../../../db/postgres/roles.sql.example", import.meta.url),
        "utf8",
      );
      // Execute the documented provisioning prefix before new linking tables exist.
      // It grants DELETE on existing tables but only SELECT/INSERT/UPDATE by default.
      const provisioning = template.split("-- Canonical M3")[0];
      if (!provisioning) throw new Error("Runtime role provisioning is missing");
      await admin.query(
        provisioning
          .replaceAll("api_next_app", runtimeRole)
          .replaceAll("SCHEMA public", `SCHEMA ${schema}`),
      );
      await admin.query(`CREATE ROLE ${readerRole} NOLOGIN`);
      await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${readerRole}`);
      // Retain an unrelated money-table denial through the bounded repair.
      await admin.query(`REVOKE DELETE ON megapot_pool_shares FROM ${runtimeRole}`);
      for (const migration of migrations.slice(linking)) await admin.query(migration.sql);
      await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${readerRole}`);
      await admin.query("COMMIT");
      await runtime.connect();
      await reader.connect();
      expect((await runtime.query("SELECT current_user AS role")).rows).toEqual([
        { role: runtimeRole },
      ]);
      await admin.query("SET session_replication_role=replica");
      try {
        await admin.query(
          "INSERT INTO users(user_id) VALUES('unlink-learner'),('deleted-learner')",
        );
        await admin.query(`INSERT INTO communities(community_id,display_name,status,created_by_user_id,created_at,updated_at)
          VALUES('music','Music fixture','active','unlink-learner',clock_timestamp(),clock_timestamp())`);
        await admin.query(
          "INSERT INTO personas(persona_id,account_id,status) VALUES('persona','unlink-learner','active')",
        );
      } finally {
        await admin.query("SET session_replication_role=origin");
      }
      await admin.query(
        `INSERT INTO community_telegram_integrations(community_id,record,revision,bot_epoch,webhook_id)
        VALUES('music',$1::jsonb,1,'epoch','hook')`,
        [JSON.stringify(emptyTelegramIntegration("music"))],
      );
      for (const [account, telegram, letter] of [
        ["unlink-learner", "321", "u"],
        ["deleted-learner", "654", "d"],
      ] as const) {
        await admin.query(
          "INSERT INTO telegram_account_associations(telegram_user_id,account_id) VALUES($1,$2)",
          [telegram, account],
        );
        await admin.query(
          `INSERT INTO telegram_bot_grants(community_id,bot_id,telegram_user_id,account_id,persona_id,revision)
          VALUES('music','123',$1,$2,'persona',1)`,
          [telegram, account],
        );
        await admin.query(
          `INSERT INTO telegram_link_transactions(transaction_id,account_id,session_hash,browser_hash,state_hash,secret_ciphertext,
          community_id,bot_id,bot_epoch,expected_telegram_user_id,post_id,state)
          VALUES($1,$2,$3,$4,$5,'encrypted-fixture','music','123','epoch',$6,'song','pending')`,
          [letter.repeat(43), account, "s".repeat(43), "b".repeat(43), "h".repeat(43), telegram],
        );
        await admin.query(
          `INSERT INTO telegram_link_navigation(reference_hash,community_id,bot_id,bot_epoch,telegram_user_id,post_id)
          VALUES($1,'music','123','epoch',$2,'song')`,
          [letter.repeat(43), telegram],
        );
      }
      await admin.query(`INSERT INTO community_telegram_conversations(community_id,telegram_user_id,input_id,prompt,answer,created_at)
        VALUES('music','321','old-input','fixture prompt','fixture answer',clock_timestamp()-interval '2 days')`);
      const store = makeControlPlaneTelegramLinkStore(
        makeDirectPostgresControlPlaneLayer(scoped(runtimeRole)),
      );
      const inbox = makeTelegramInboxStore(
        makeTelegramDatabase(makeDirectPostgresControlPlaneLayer(scoped(runtimeRole))),
      );
      const browser = {
        accountId: "unlink-learner",
        sessionHash: "s".repeat(43),
        browserHash: "b".repeat(43),
      };
      for (const table of tables)
        await expect(runtime.query(`DELETE FROM ${table} WHERE FALSE`)).rejects.toMatchObject({
          code: "42501",
        });
      await expect(store.unlink(browser, "321")).rejects.toBeDefined();
      await expect(store.cleanup()).rejects.toMatchObject({ sqlState: "42501" });
      await expect(inbox.cleanup()).rejects.toMatchObject({ sqlState: "42501" });
      await expect(
        runtime.query("UPDATE users SET status='deleted' WHERE user_id='deleted-learner'"),
      ).rejects.toMatchObject({ code: "42501" });
      expect(
        (await admin.query("SELECT count(*)::int AS count FROM telegram_account_associations"))
          .rows,
      ).toEqual([{ count: 2 }]);
      expect(
        (
          await admin.query(
            "SELECT active,revision FROM telegram_bot_grants ORDER BY telegram_user_id",
          )
        ).rows,
      ).toEqual([
        { active: true, revision: "1" },
        { active: true, revision: "1" },
      ]);
      // This is the exact bounded grant shipped in the operator role template.
      const privilegeFacts = async () =>
        (
          await runtime.query(
            TELEGRAM_ACTIVATION_PRIVILEGES_SQL.replace(
              "n.nspname='api_next'",
              `n.nspname='${schema}'`,
            ),
          )
        ).rows;
      const before = await privilegeFacts();
      expect(() => assertTelegramActivationPrivileges(before)).toThrow();
      // Shared staging's broad default DELETE is unsafe even after link-table grants.
      await admin.query(
        `GRANT DELETE ON telegram_bot_grants,telegram_study_conversations TO ${runtimeRole}`,
      );
      const grant = template
        .split("-- Telegram linking deletion grants begin")[1]
        ?.split("-- Telegram linking deletion grants end")[0];
      if (!grant) throw new Error("Telegram linking runtime grants are missing");
      await admin.query(grant.replaceAll("api_next_app", runtimeRole));
      await admin.query(grant.replaceAll("api_next_app", runtimeRole)); // Idempotent operator replay.
      expect(assertTelegramActivationPrivileges(await privilegeFacts())).toBe(runtimeRole);
      for (const [table, permission] of [
        ["telegram_bot_grants", "DELETE"],
        ["telegram_study_conversations", "DELETE"],
        ["telegram_link_navigation", "TRUNCATE"],
      ] as const) {
        await admin.query(`GRANT ${permission} ON ${table} TO ${runtimeRole}`);
        const excessive = await privilegeFacts();
        expect(() => assertTelegramActivationPrivileges(excessive)).toThrow();
        await admin.query(`REVOKE ${permission} ON ${table} FROM ${runtimeRole}`);
      }
      for (const table of tables) {
        expect(
          (
            await admin.query(
              `SELECT has_table_privilege($1,$3,'DELETE') AS runtime,
          has_table_privilege($2,$3,'DELETE') AS reader, has_table_privilege($1,$3,'TRUNCATE') AS truncate`,
              [runtimeRole, readerRole, table],
            )
          ).rows,
        ).toEqual([{ runtime: true, reader: false, truncate: false }]);
        await expect(reader.query(`DELETE FROM ${table} WHERE FALSE`)).rejects.toMatchObject({
          code: "42501",
        });
      }
      for (const table of [
        "telegram_bot_grants",
        "telegram_study_conversations",
        "megapot_pool_shares",
      ])
        await expect(runtime.query(`DELETE FROM ${table} WHERE FALSE`)).rejects.toMatchObject({
          code: "42501",
        });
      await store.unlink(browser, "321");
      await runtime.query("UPDATE users SET status='deleted' WHERE user_id='deleted-learner'");
      expect((await admin.query("SELECT * FROM telegram_account_associations")).rows).toHaveLength(
        0,
      );
      expect(
        (
          await admin.query(
            "SELECT active,revision FROM telegram_bot_grants ORDER BY telegram_user_id",
          )
        ).rows,
      ).toEqual([
        { active: false, revision: "2" },
        { active: false, revision: "2" },
      ]);
      expect(
        (
          await admin.query(
            "SELECT state,state_hash,secret_ciphertext FROM telegram_link_transactions",
          )
        ).rows,
      ).toEqual([
        { state: "cancelled", state_hash: null, secret_ciphertext: null },
        { state: "cancelled", state_hash: null, secret_ciphertext: null },
      ]);
      await admin.query(
        "UPDATE telegram_link_transactions SET expires_at=clock_timestamp()-interval '1 second'",
      );
      await admin.query(
        "UPDATE telegram_link_navigation SET expires_at=clock_timestamp()-interval '1 second'",
      );
      await store.cleanup();
      expect((await admin.query("SELECT * FROM telegram_link_transactions")).rows).toHaveLength(0);
      expect((await admin.query("SELECT * FROM telegram_link_navigation")).rows).toHaveLength(0);
      // Repopulate expired rows so the existing inbox maintenance path also
      // has work to delete, then prove it reaches its original retention work.
      await admin.query(
        `INSERT INTO telegram_link_navigation(reference_hash,community_id,bot_id,bot_epoch,telegram_user_id,post_id,expires_at)
        VALUES($1,'music','123','epoch','321','song',clock_timestamp()-interval '1 second')`,
        ["n".repeat(43)],
      );
      await admin.query(
        `INSERT INTO telegram_link_transactions(transaction_id,account_id,session_hash,browser_hash,
        community_id,bot_id,bot_epoch,expected_telegram_user_id,post_id,state,expires_at)
        VALUES($1,'unlink-learner',$2,$3,'music','123','epoch','321','song','cancelled',clock_timestamp()-interval '1 second')`,
        ["t".repeat(43), "s".repeat(43), "b".repeat(43)],
      );
      await admin.query(
        `INSERT INTO telegram_study_conversations(community_id,bot_id,telegram_user_id,bot_epoch,state,updated_at) VALUES('music','123','321','epoch',$1::jsonb,clock_timestamp()-interval '25 hours')`,
        [JSON.stringify({ ...emptyTelegramStudyState(), selectedPostId: "song" })],
      );
      await inbox.cleanup();
      expect((await admin.query("SELECT state FROM telegram_study_conversations")).rows).toEqual([
        { state: emptyTelegramStudyState() },
      ]);
      for (const table of [
        "telegram_link_transactions",
        "telegram_link_navigation",
        "community_telegram_conversations",
      ])
        expect((await admin.query(`SELECT * FROM ${table}`)).rows).toHaveLength(0);
      expect(
        (await admin.query("SELECT count(*)::int AS count FROM telegram_bot_grants")).rows,
      ).toEqual([{ count: 2 }]);
    } finally {
      await runtime.end();
      await reader.end();
      await admin.query("ROLLBACK");
      await admin.query("RESET ROLE");
      await admin.query("RESET session_replication_role");
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS ${runtimeRole}`);
      await admin.query(`DROP ROLE IF EXISTS ${readerRole}`);
      await admin.end();
    }
  }, 120_000);
});
