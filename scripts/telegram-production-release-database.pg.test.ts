import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { migrationPlan } from "./postgres-migrations.ts";
import {
  assertTelegramLedger,
  assertTelegramMatrix,
  TELEGRAM_GRANTS,
  TELEGRAM_MATRIX_SQL,
  telegramMigrations,
} from "./telegram-production-release-database.ts";
import { requireTelegram } from "./telegram-production-release-policy.ts";

const raw = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (!raw && process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1")
  throw Error("local test URL required");
const suite = raw ? describe : describe.skip;

suite("fixed Telegram migration and exact privilege envelope on disposable PostgreSQL", () => {
  test("334 strips ambient authority; nine grants admit only the reviewed envelope and immutable decision", async () => {
    if (!raw) throw Error("local test URL required");
    // This production-schema fixture is not a staging-persona recovery suite.
    // Keep its destructive target admission local instead of entering that separate CI shard.
    const base = new URL(raw);
    requireTelegram(
      ["postgres:", "postgresql:"].includes(base.protocol) &&
        base.hostname === "127.0.0.1" &&
        base.username.length > 0 &&
        base.pathname === "/postgres" &&
        base.hash === "" &&
        [...base.searchParams].every(([key, value]) => key === "sslmode" && value === "disable"),
      "telegram-local-fixture-target-required",
    );
    const name = `telegram_release_${randomUUID().replaceAll("-", "")}`;
    const root = new Client({ connectionString: base.toString() });
    const target = new URL(base);
    target.pathname = `/${name}`;
    const db = new Client({ connectionString: target.toString() });
    await root.connect();
    try {
      await root.query(`CREATE DATABASE "${name}"`);
      await root.query(`CREATE ROLE "${name}"`);
      await db.connect();
      await db.query(`CREATE SCHEMA api_next; SET search_path=api_next,pg_catalog;
        CREATE TABLE communities(community_id text PRIMARY KEY);
        CREATE TABLE posts(community_id text,post_id text,PRIMARY KEY(community_id,post_id));
        CREATE TABLE schema_migrations(version text PRIMARY KEY,checksum text NOT NULL)`);
      const migrations = await telegramMigrations();
      const last = migrations.at(-1);
      if (!last) throw Error("fixture migration missing");
      // Minimal dependency fixture. These ledger rows test exact-prefix guards, not historical schema installation.
      for (const row of migrationPlan(migrations).slice(0, 333))
        await db.query("INSERT INTO schema_migrations VALUES($1,$2)", [row.version, row.checksum]);
      expect((await assertTelegramLedger(db, 333)).count).toBe(333);
      await db.query("UPDATE schema_migrations SET checksum='wrong' WHERE version=$1", [
        migrations[0]?.version,
      ]);
      await expect(assertTelegramLedger(db, 333)).rejects.toThrow("full-contiguous");
      await db.query("UPDATE schema_migrations SET checksum=$2 WHERE version=$1", [
        migrations[0]?.version,
        migrations[0]?.checksum,
      ]);
      for (const [table] of TELEGRAM_GRANTS.filter(
        ([table]) => table !== "study_learner_catalogue_decisions",
      ))
        await db.query(`CREATE TABLE api_next.${table}(id integer PRIMARY KEY)`);
      await db.query("CREATE TABLE api_next.telegram_restricted_bot_affirmations(id integer)");
      await db.query(`GRANT USAGE ON SCHEMA api_next TO "${name}";
        ALTER DEFAULT PRIVILEGES IN SCHEMA api_next GRANT ALL ON TABLES TO "${name}";
        ALTER DEFAULT PRIVILEGES IN SCHEMA api_next GRANT EXECUTE ON FUNCTIONS TO "${name}"`);
      await db.query(last.sql);
      await db.query("INSERT INTO schema_migrations VALUES($1,$2)", [
        migrations.at(-1)?.version,
        migrations.at(-1)?.checksum,
      ]);
      expect((await assertTelegramLedger(db, 334)).count).toBe(334);
      const names = [
        ...TELEGRAM_GRANTS.map(([table]) => table),
        "telegram_restricted_bot_affirmations",
      ];
      const matrix = async () => (await db.query(TELEGRAM_MATRIX_SQL, [name, names])).rows;
      const newTable = (await matrix()).find(
        (r) => r.table_name === "study_learner_catalogue_decisions",
      );
      expect(newTable?.table_privileges).toEqual(Array(8).fill(false));
      expect(
        (
          await db.query(
            "SELECT has_function_privilege($1,'api_next.guard_study_learner_catalogue_decision()','EXECUTE') AS allowed",
            [name],
          )
        ).rows[0]?.allowed,
      ).toBe(false);
      for (const [table, missing, final] of TELEGRAM_GRANTS) {
        const existing = ["SELECT", "INSERT", "UPDATE", "DELETE"].filter(
          (p, i) => final[i] && !missing.some((m) => m === p),
        );
        if (existing.length)
          await db.query(`GRANT ${existing.join(",")} ON api_next.${table} TO "${name}"`);
      }
      async function grant() {
        for (const [table, additions] of TELEGRAM_GRANTS)
          await db.query(`GRANT ${additions.join(",")} ON api_next.${table} TO "${name}"`);
      }
      const awaitedBefore = await matrix();
      await grant();
      expect(() => assertTelegramMatrix(awaitedBefore, false)).not.toThrow();
      expect(() => assertTelegramMatrix(awaitedBefore, true)).toThrow();
      const after = await matrix();
      expect(() => assertTelegramMatrix(after, true)).not.toThrow();
      await db.query(`GRANT UPDATE(id) ON api_next.telegram_restricted_learners TO "${name}"`);
      const forbiddenColumn = await matrix();
      expect(() => assertTelegramMatrix(forbiddenColumn, true)).toThrow();
      await db.query(`REVOKE UPDATE(id) ON api_next.telegram_restricted_learners FROM "${name}"`);
      await db.query(
        "INSERT INTO communities VALUES('fixture-community'); INSERT INTO posts VALUES('fixture-community','fixture-post')",
      );
      const decision = `INSERT INTO study_learner_catalogue_decisions VALUES('fixture-community','fixture-post',1,'fixture-policy','eligible',1,1,1,'general',NULL,'en','say_it_back','reviewer',$1,clock_timestamp(),clock_timestamp())`;
      await db.query(decision, ["a".repeat(64)]);
      await expect(
        db.query("UPDATE study_learner_catalogue_decisions SET disposition='ineligible'"),
      ).rejects.toThrow("immutable");
      await expect(db.query("TRUNCATE study_learner_catalogue_decisions")).rejects.toThrow(
        "immutable",
      );
      await db.query(`SET ROLE "${name}"`);
      expect(
        (await db.query("SELECT count(*)::integer AS count FROM study_learner_catalogue_decisions"))
          .rows[0]?.count,
      ).toBe(1);
      for (const sql of [
        decision.replace("$1", "repeat('a',64)"),
        "DELETE FROM study_learner_catalogue_decisions",
        "UPDATE telegram_restricted_learners SET id=2",
        "DELETE FROM telegram_restricted_study_personas",
        "SELECT * FROM telegram_restricted_bot_affirmations",
        "TRUNCATE telegram_account_associations",
      ])
        await expect(db.query(sql)).rejects.toThrow("permission denied");
    } finally {
      await db.query("RESET ROLE").catch(() => undefined);
      await db.end().catch(() => undefined);
      await root.query(`DROP DATABASE IF EXISTS "${name}"`);
      await root.query(`DROP ROLE IF EXISTS "${name}"`);
      await root.end();
    }
  }, 120_000);
});
