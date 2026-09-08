import { describe, expect, test } from "bun:test";
import { Client } from "pg";
import {
  observeSessionDrain,
  observeSessionDrainInTransaction,
} from "./staging-persona-session-drain";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (!url && process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1") {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
}
const suite = url ? describe : describe.skip;

// A dedicated database prevents unrelated suites from affecting session counts.
async function fixture(use: (admin: Client, scoped: string, role: string) => Promise<void>) {
  if (!url) throw new Error("test URL required");
  const name = `drain_${crypto.randomUUID().replaceAll("-", "")}`;
  const root = new Client({ connectionString: url });
  await root.connect();
  const scoped = new URL(url);
  scoped.pathname = `/${name}`;
  const admin = new Client({ connectionString: scoped.toString() });
  try {
    await root.query(`CREATE DATABASE "${name}"`);
    await admin.connect();
    const identity = await admin.query("SELECT current_user::text AS role");
    await use(admin, scoped.toString(), identity.rows[0].role);
  } finally {
    await admin.end();
    // Only this test's UUID-named database; never force-drop connected sessions.
    await root.query(`DROP DATABASE IF EXISTS "${name}"`);
    await root.end();
  }
}

suite("staging reset session-drain observation", () => {
  test("executor observation preserves its transaction and refuses every other session", async () => {
    await fixture(async (admin, scoped, role) => {
      await admin.query("BEGIN");
      await admin.query("CREATE TABLE executor_retained (id int)");
      const xid = (await admin.query("SELECT pg_current_xact_id()::text AS xid")).rows[0].xid;
      try {
        expect((await observeSessionDrainInTransaction(admin, role, xid)).other_sessions).toBe(0);
        await expect(observeSessionDrainInTransaction(admin, role, "0")).rejects.toThrow(
          "session_drain_unproven",
        );
        const peer = new Client({ connectionString: scoped });
        await peer.connect();
        try {
          await expect(observeSessionDrainInTransaction(admin, role, xid)).rejects.toThrow(
            "session_drain_unproven",
          );
        } finally {
          await peer.end();
        }
        expect((await admin.query("SELECT pg_current_xact_id()::text AS xid")).rows[0].xid).toBe(
          xid,
        );
        expect(
          (await admin.query("SELECT to_regclass('executor_retained') IS NOT NULL AS retained"))
            .rows[0].retained,
        ).toBe(true);
      } finally {
        await admin.query("ROLLBACK");
      }
      expect(
        (await admin.query("SELECT to_regclass('executor_retained') AS retained")).rows[0].retained,
      ).toBeNull();
      await expect(observeSessionDrainInTransaction(admin, role, xid)).rejects.toThrow(
        "session_drain_unproven",
      );
    });
  });

  test("a ledger lock can succeed while a different table remains write-locked", async () => {
    await fixture(async (admin, scoped) => {
      await admin.query("CREATE TABLE schema_migrations (version text PRIMARY KEY)");
      await admin.query("CREATE TABLE member_fixture (id int PRIMARY KEY)");
      const peer = new Client({ connectionString: scoped });
      await peer.connect();
      try {
        await peer.query("BEGIN");
        await peer.query("INSERT INTO member_fixture VALUES (1)");
        await admin.query("BEGIN");
        await admin.query("SET LOCAL lock_timeout = '100ms'");
        await admin.query("LOCK TABLE schema_migrations IN ACCESS EXCLUSIVE MODE");
        await expect(
          admin.query("LOCK TABLE member_fixture IN ACCESS EXCLUSIVE MODE"),
        ).rejects.toMatchObject({ code: "55P03" });
        await admin.query("ROLLBACK");
        await peer.query("COMMIT");
        expect((await admin.query("SELECT id FROM member_fixture")).rows).toEqual([{ id: 1 }]);
      } finally {
        await admin.query("ROLLBACK");
        await peer.query("ROLLBACK");
        await peer.end();
      }
    });
  });

  test("accepts only its own connection and refuses an idle peer", async () => {
    await fixture(async (admin, scoped, role) => {
      expect(await observeSessionDrain(admin, role)).toEqual({
        scan_version: 1,
        other_sessions: 0,
        prepared_transactions: 0,
        execution_authorized: false,
      });
      const peer = new Client({ connectionString: scoped });
      await peer.connect();
      try {
        await expect(observeSessionDrain(admin, role)).rejects.toThrow("session_drain_unproven");
      } finally {
        await peer.end();
      }
      expect((await observeSessionDrain(admin, role)).other_sessions).toBe(0);
    });
  });

  test("refuses an idle-in-transaction peer without terminating or rolling it back", async () => {
    await fixture(async (admin, scoped, role) => {
      const peer = new Client({ connectionString: scoped });
      await peer.connect();
      try {
        await peer.query("BEGIN");
        await peer.query("CREATE TABLE retained (id int)");
        await expect(observeSessionDrain(admin, role)).rejects.toThrow("session_drain_unproven");
        await peer.query("COMMIT");
        expect(
          (await admin.query("SELECT to_regclass('retained') IS NOT NULL AS retained")).rows,
        ).toEqual([{ retained: true }]);
      } finally {
        await peer.end();
      }
    });
  });

  test("refuses a prepared transaction after its owning session disconnects", async () => {
    await fixture(async (admin, scoped, role) => {
      const capacity = await admin.query("SHOW max_prepared_transactions");
      if (Number(capacity.rows[0].max_prepared_transactions) === 0) {
        // Default CI services disable two-phase transactions. The dedicated local
        // PG17 run enables them and must exercise the positive branch below.
        await admin.query("BEGIN");
        await admin.query("CREATE TABLE disabled_prepare_fixture (id int)");
        await expect(
          admin.query("PREPARE TRANSACTION 'disabled_drain_fixture'"),
        ).rejects.toMatchObject({ code: "55000" });
        await admin.query("ROLLBACK");
        return;
      }
      const gid = `drain_${crypto.randomUUID().replaceAll("-", "")}`;
      const peer = new Client({ connectionString: scoped });
      await peer.connect();
      try {
        await peer.query("BEGIN");
        await peer.query("CREATE TABLE prepared_fixture (id int)");
        await peer.query(`PREPARE TRANSACTION '${gid}'`);
      } finally {
        await peer.end();
      }
      try {
        await expect(observeSessionDrain(admin, role)).rejects.toThrow("session_drain_unproven");
        expect(
          (
            await admin.query("SELECT count(*)::int AS count FROM pg_prepared_xacts WHERE gid=$1", [
              gid,
            ])
          ).rows,
        ).toEqual([{ count: 1 }]);
      } finally {
        await admin.query(`ROLLBACK PREPARED '${gid}'`);
      }
      expect((await observeSessionDrain(admin, role)).prepared_transactions).toBe(0);
    });
  });

  test("refuses an observer without full statistics visibility", async () => {
    await fixture(async (admin, scoped) => {
      const role = `drain_reader_${crypto.randomUUID().replaceAll("-", "")}`;
      const password = crypto.randomUUID();
      await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
      const limitedUrl = new URL(scoped);
      limitedUrl.username = role;
      limitedUrl.password = password;
      const limited = new Client({ connectionString: limitedUrl.toString() });
      try {
        await limited.connect();
        await expect(observeSessionDrain(limited, role)).rejects.toThrow("session_drain_unproven");
      } finally {
        await limited.end();
        await admin.query(`DROP ROLE "${role}"`);
      }
    });
  });
});
