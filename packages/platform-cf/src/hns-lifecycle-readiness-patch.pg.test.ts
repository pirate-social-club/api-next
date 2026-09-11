import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { loadPostgresMigrations } from "../../../scripts/postgres-migrations.ts";

/**
 * Migration 0139's three patch meanings for `readiness_observed_at`, which are
 * deliberately distinct: an omitted field preserves, an explicit clear clears,
 * and a timestamp sets. Before 0139 the first two were indistinguishable,
 * because the patch COALESCEd a null onto the stored value.
 */

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString ? describe : describe.skip;

/**
 * Each case builds its own schema and applies every migration, which is well
 * past bun's five-second default. The budget is explicit so the suite fails on
 * a real hang rather than on the migration set having grown.
 */
const SCHEMA_BUDGET_MS = 120_000;

const quote = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const SESSION = "session-readiness";

const commitDecision = `SELECT * FROM commit_hns_root_import_lifecycle_decision_v1(
  $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)`;

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

async function seedReady(admin: Client): Promise<void> {
  await admin.query(
    `INSERT INTO hns_root_import_lifecycle (
       root_import_session_id, root_label, phase, revision, generation,
       plan_exposed_at, publication_deadline_at, first_current_observation_at,
       finality_deadline_at, readiness_observed_at, policy_name, policy_digest
     ) VALUES ($1,'newroot','ready',1,1,
       clock_timestamp() - interval '3 hours', clock_timestamp() + interval '13 days',
       clock_timestamp() - interval '2 hours', clock_timestamp() + interval '22 hours',
       clock_timestamp() - interval '1 minute','hns_root_import_lifecycle_v1','seed')`,
    [SESSION],
  );
}

const readiness = async (admin: Client): Promise<Date | null> =>
  (
    await admin.query(
      "SELECT readiness_observed_at FROM hns_root_import_lifecycle WHERE root_import_session_id=$1",
      [SESSION],
    )
  ).rows[0]?.readiness_observed_at ?? null;

const revision = async (admin: Client): Promise<number> =>
  Number(
    (
      await admin.query(
        "SELECT revision FROM hns_root_import_lifecycle WHERE root_import_session_id=$1",
        [SESSION],
      )
    ).rows[0]?.revision,
  );

async function commit(
  admin: Client,
  eventId: string,
  phase: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await admin.query(commitDecision, [
    SESSION,
    await revision(admin),
    eventId,
    "current_observation",
    "transition",
    "test",
    phase,
    JSON.stringify(patch),
    "[]",
  ]);
}

suite("readiness patch semantics (migration 0139)", () => {
  test(
    "an omitted field preserves the stored readiness",
    async () => {
      await withSchema("hns_readiness_omit", async (admin) => {
        await seedReady(admin);
        const before = await readiness(admin);
        await commit(admin, "omit-1", "ready", { pending_reason: "unchanged" });
        expect(await readiness(admin)).toEqual(before);
      });
    },
    SCHEMA_BUDGET_MS,
  );

  test(
    "an explicit clear clears it, and the clear survives a reload",
    async () => {
      await withSchema("hns_readiness_clear", async (admin) => {
        await seedReady(admin);
        expect(await readiness(admin)).not.toBeNull();
        await commit(admin, "clear-1", "checking_publication", {
          clear_readiness_observed_at: true,
          pending_reason: "current_authority_conflict",
        });
        expect(await readiness(admin)).toBeNull();

        // Reload through a second connection: the clear is committed state, not
        // an artefact of this session's view.
        const reader = new Client({ connectionString });
        await reader.connect();
        try {
          const searchPath = (await admin.query("SHOW search_path")).rows[0]?.search_path as string;
          await reader.query(`SET search_path TO ${searchPath}`);
          const reloaded = await reader.query(
            "SELECT readiness_observed_at FROM hns_root_import_lifecycle WHERE root_import_session_id=$1",
            [SESSION],
          );
          expect(reloaded.rows[0]?.readiness_observed_at).toBeNull();
        } finally {
          await reader.end().catch(() => undefined);
        }
      });
    },
    SCHEMA_BUDGET_MS,
  );

  test(
    "a timestamp sets it",
    async () => {
      await withSchema("hns_readiness_set", async (admin) => {
        await seedReady(admin);
        await commit(admin, "clear-2", "checking_publication", {
          clear_readiness_observed_at: true,
        });
        expect(await readiness(admin)).toBeNull();

        const observedAt = "2026-09-09T12:00:00.000Z";
        await commit(admin, "set-1", "checking_authority", {
          readiness_observed_at: observedAt,
        });
        expect((await readiness(admin))?.toISOString()).toBe(observedAt);
      });
    },
    SCHEMA_BUDGET_MS,
  );

  test(
    "a replayed or stale event cannot restore invalidated readiness",
    async () => {
      await withSchema("hns_readiness_replay", async (admin) => {
        await seedReady(admin);
        const original = await readiness(admin);
        expect(original).not.toBeNull();

        // The readiness observation that established the evidence, replayed
        // after the invalidation. Its identity is already in history.
        await commit(admin, "readiness-established", "ready", {
          readiness_observed_at: original?.toISOString(),
        });
        await commit(admin, "clear-3", "checking_publication", {
          clear_readiness_observed_at: true,
        });
        expect(await readiness(admin)).toBeNull();

        const staleRevision = 1;
        // A duplicate delivery of the same event identity is recorded as a
        // replay and changes nothing.
        await admin.query(commitDecision, [
          SESSION,
          await revision(admin),
          "readiness-established",
          "readiness_observed",
          "replay",
          "event_identity_replayed",
          null,
          "{}",
          "[]",
        ]);
        expect(await readiness(admin)).toBeNull();

        // A stale revision is refused outright, so a late writer holding an old
        // view cannot reinstate the evidence either.
        await expect(
          admin.query(commitDecision, [
            SESSION,
            staleRevision,
            "readiness-late",
            "readiness_observed",
            "transition",
            "test",
            "ready",
            JSON.stringify({ readiness_observed_at: original?.toISOString() }),
            "[]",
          ]),
        ).rejects.toThrow();
        expect(await readiness(admin)).toBeNull();
      });
    },
    SCHEMA_BUDGET_MS,
  );
});
