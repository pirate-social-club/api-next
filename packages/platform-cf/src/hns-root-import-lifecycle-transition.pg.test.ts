import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { commitLifecycleEventInTransaction } from "../../../apps/hns-authority-provisioner/src/lifecycle-transition.ts";
import { loadPostgresMigrations } from "../../../scripts/postgres-migrations.ts";

/**
 * The transition helper against a real database, through the same client and
 * transaction the callers use. These assert the properties the wiring exists
 * for: the fact and its transition commit together or not at all, a replay
 * changes nothing, concurrent callers serialize, and a session with no
 * lifecycle produces explicit evidence rather than an invented phase.
 */

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString ? describe : describe.skip;

const quote = (value: string): string => `"${value.replaceAll('"', '""')}"`;

async function withSchema<A>(prefix: string, use: (admin: Client) => Promise<A>): Promise<A> {
  const schema = `${prefix}_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString });
  await admin.connect();
  try {
    await admin.query(`CREATE SCHEMA ${quote(schema)}`);
    await admin.query(`SET search_path TO ${quote(schema)}`);
    for (const migration of await loadPostgresMigrations()) await admin.query(migration.sql);
    return await use(admin);
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
}

async function seedPreparing(admin: Client, sessionId: string): Promise<void> {
  await admin.query(
    `INSERT INTO hns_root_import_lifecycle (
       root_import_session_id, root_label, phase, revision, generation,
       pending_reason, policy_name, policy_digest
     ) VALUES ($1,'newroot','preparing',1,1,'preparing_retained_authority',
       'hns_root_import_lifecycle_v1','seed')`,
    [sessionId],
  );
}

const preparationCompleted = (eventId: string) =>
  ({
    event: "preparation_completed",
    event_id: eventId,
    occurred_at_epoch_ms: Date.now(),
  }) as const;

suite("HNS lifecycle transition helper against PostgreSQL", () => {
  test("rolls the transition back with the transaction that contained it", async () => {
    await withSchema("hns_lifecycle_rollback", async (admin) => {
      await seedPreparing(admin, "session-rollback");
      await admin.query("BEGIN");
      const applied = await commitLifecycleEventInTransaction(
        admin,
        "session-rollback",
        preparationCompleted("evt-rollback"),
      );
      expect(applied).toMatchObject({ applied: true });
      await admin.query("ROLLBACK");

      // The transition is not a separate commit: rolling back the surrounding
      // work must leave the lifecycle exactly where it was.
      const after = await admin.query(
        "SELECT phase, revision FROM hns_root_import_lifecycle WHERE root_import_session_id='session-rollback'",
      );
      expect(after.rows[0]).toEqual({ phase: "preparing", revision: "1" });
      const history = await admin.query(
        "SELECT count(*)::int AS entries FROM hns_root_import_lifecycle_history WHERE root_import_session_id='session-rollback'",
      );
      expect(history.rows[0]).toEqual({ entries: 0 });
    });
  });

  test("establishes exposure and the publication deadline exactly once across replays", async () => {
    await withSchema("hns_lifecycle_replay", async (admin) => {
      await seedPreparing(admin, "session-replay");
      await admin.query("BEGIN");
      expect(
        await commitLifecycleEventInTransaction(
          admin,
          "session-replay",
          preparationCompleted("evt-once"),
        ),
      ).toMatchObject({ applied: true });
      await admin.query("COMMIT");
      const first = await admin.query(
        `SELECT phase, plan_exposed_at, publication_deadline_at
           FROM hns_root_import_lifecycle WHERE root_import_session_id='session-replay'`,
      );
      expect(first.rows[0]?.phase).toBe("awaiting_publication");
      expect(first.rows[0]?.plan_exposed_at).not.toBeNull();
      expect(first.rows[0]?.publication_deadline_at).not.toBeNull();

      await admin.query("BEGIN");
      const replayed = await commitLifecycleEventInTransaction(
        admin,
        "session-replay",
        preparationCompleted("evt-once"),
      );
      await admin.query("COMMIT");
      expect(replayed.applied).toBe(false);

      const second = await admin.query(
        `SELECT phase, plan_exposed_at, publication_deadline_at
           FROM hns_root_import_lifecycle WHERE root_import_session_id='session-replay'`,
      );
      // A replay preserves the deadlines: re-exposing must never extend the
      // owner's publication window or move its start.
      expect(second.rows[0]).toEqual(first.rows[0]);
      const jobs = await admin.query(
        "SELECT count(*)::int AS queued FROM hns_root_import_lifecycle_jobs WHERE root_import_session_id='session-replay'",
      );
      expect(jobs.rows[0]?.queued).toBeLessThanOrEqual(1);
    });
  });

  test("serializes concurrent transitions on one operation", async () => {
    await withSchema("hns_lifecycle_concurrent", async (admin) => {
      await seedPreparing(admin, "session-concurrent");
      const searchPath = (await admin.query("SHOW search_path")).rows[0]?.search_path as string;
      const other = new Client({ connectionString });
      await other.connect();
      try {
        await other.query(`SET search_path TO ${searchPath}`);
        await admin.query("BEGIN");
        await commitLifecycleEventInTransaction(
          admin,
          "session-concurrent",
          preparationCompleted("evt-a"),
        );
        await other.query("BEGIN");
        // The second caller blocks on the row lock until the first commits,
        // then decides against the state the first produced.
        const contended = commitLifecycleEventInTransaction(
          other,
          "session-concurrent",
          preparationCompleted("evt-b"),
        );
        await admin.query("COMMIT");
        const second = await contended;
        await other.query("COMMIT");

        // Only one transition happened; the second saw awaiting_publication.
        expect(second.applied).toBe(false);
        const phases = await admin.query(
          `SELECT phase, revision FROM hns_root_import_lifecycle
            WHERE root_import_session_id='session-concurrent'`,
        );
        expect(phases.rows[0]).toMatchObject({ phase: "awaiting_publication" });
      } finally {
        await other.end().catch(() => undefined);
      }
    });
  });

  test("reports lifecycle_absent instead of inventing a phase", async () => {
    await withSchema("hns_lifecycle_absent", async (admin) => {
      await admin.query("BEGIN");
      const result = await commitLifecycleEventInTransaction(
        admin,
        "session-that-predates-this",
        preparationCompleted("evt-absent"),
      );
      await admin.query("COMMIT");

      expect(result).toEqual({ applied: false, reason: "lifecycle_absent" });
      const rows = await admin.query("SELECT count(*)::int AS rows FROM hns_root_import_lifecycle");
      expect(rows.rows[0]).toEqual({ rows: 0 });
    });
  });
});
