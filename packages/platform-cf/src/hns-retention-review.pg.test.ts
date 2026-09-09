import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { loadPostgresMigrations } from "../../../scripts/postgres-migrations.ts";

/**
 * Retirement authorization against real PostgreSQL (migration 0140).
 *
 * The property under test is that deletion becomes reachable only through
 * recorded evidence about the exact authority generation, and that everything
 * else — no review, a review of a superseded generation, stale evidence, a
 * retain decision — produces no authorization and therefore retention.
 */

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString ? describe : describe.skip;
const quote = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const SESSION = "session-retention";
const FRESHNESS = 1_800;

async function withSchema<A>(prefix: string, use: (admin: Client) => Promise<A>): Promise<A> {
  const schema = `${prefix}_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString });
  await admin.connect();
  try {
    await admin.query(`CREATE SCHEMA ${quote(schema)}`);
    await admin.query(`SET search_path TO ${quote(schema)}`);
    for (const migration of await loadPostgresMigrations()) await admin.query(migration.sql);
    await admin.query(
      `INSERT INTO hns_root_import_lifecycle (
         root_import_session_id, root_label, phase, revision, generation,
         pending_reason, policy_name, policy_digest
       ) VALUES ($1,'newroot','preparing',1,1,'seed','hns_root_import_lifecycle_v1','seed')`,
      [SESSION],
    );
    return await use(admin);
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
}

async function recordReview(
  admin: Client,
  options: {
    readonly generation: number;
    readonly decision: "retain" | "retire_authorized" | "superseded";
    readonly evidenceRef: string;
    readonly reviewedInterval?: string;
    readonly inspected?: boolean;
  },
): Promise<void> {
  const inspected = options.inspected ?? true;
  await admin.query(
    `INSERT INTO hns_root_import_retention_reviews (
       root_import_session_id, authority_generation, reviewed_at,
       current_observed_at, safe_observed_at,
       current_resource_sha256, safe_resource_sha256,
       decision, reason, evidence_ref
     ) VALUES ($1,$2,
       clock_timestamp() + COALESCE($3::interval, interval '0'),
       CASE WHEN $4 THEN clock_timestamp() END,
       CASE WHEN $4 THEN clock_timestamp() END,
       CASE WHEN $4 THEN repeat('a',64) END,
       CASE WHEN $4 THEN repeat('b',64) END,
       $5,'test',$6)`,
    [
      SESSION,
      options.generation,
      options.reviewedInterval ?? null,
      inspected,
      options.decision,
      options.evidenceRef,
    ],
  );
}

const authorization = async (admin: Client) =>
  (
    await admin.query("SELECT * FROM authorize_hns_root_import_retirement_v1($1,$2)", [
      SESSION,
      FRESHNESS,
    ])
  ).rows;

suite("HNS retirement authorization (migration 0140)", () => {
  test("no review means no authorization, which the gate reads as retain", async () => {
    await withSchema("hns_retention_none", async (admin) => {
      expect(await authorization(admin)).toEqual([]);
    });
  });

  test("a retain decision never authorizes deletion", async () => {
    await withSchema("hns_retention_retain", async (admin) => {
      await recordReview(admin, { generation: 1, decision: "retain", evidenceRef: "retain-1" });
      expect(await authorization(admin)).toEqual([]);
    });
  });

  test("a recorded review of the current generation authorizes retirement", async () => {
    await withSchema("hns_retention_ok", async (admin) => {
      await recordReview(admin, {
        generation: 1,
        decision: "retire_authorized",
        evidenceRef: "review-1",
      });
      const rows = await authorization(admin);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: "retention_review",
        evidence_ref: "review-1",
        authority_generation: "1",
      });
    });
  });

  test("a review of a superseded generation authorizes nothing", async () => {
    await withSchema("hns_retention_generation", async (admin) => {
      await recordReview(admin, {
        generation: 1,
        decision: "retire_authorized",
        evidenceRef: "review-old",
      });
      // The operation is regenerated: it now holds different infrastructure,
      // and nobody has inspected that.
      await admin.query(
        "UPDATE hns_root_import_lifecycle SET generation=2 WHERE root_import_session_id=$1",
        [SESSION],
      );
      expect(await authorization(admin)).toEqual([]);

      await recordReview(admin, {
        generation: 2,
        decision: "retire_authorized",
        evidenceRef: "review-new",
      });
      expect((await authorization(admin))[0]).toMatchObject({ evidence_ref: "review-new" });
    });
  });

  test("evidence older than the freshness bound authorizes nothing", async () => {
    await withSchema("hns_retention_stale", async (admin) => {
      await recordReview(admin, {
        generation: 1,
        decision: "retire_authorized",
        evidenceRef: "review-stale",
        reviewedInterval: "-2 hours",
      });
      expect(await authorization(admin)).toEqual([]);
    });
  });

  test("an explicit supersession authorizes retirement and is labelled as such", async () => {
    await withSchema("hns_retention_superseded", async (admin) => {
      await recordReview(admin, {
        generation: 1,
        decision: "superseded",
        evidenceRef: "supersession-1",
      });
      expect((await authorization(admin))[0]).toMatchObject({ kind: "supersession" });
    });
  });

  test("authorizing retirement without inspecting both views is refused by the database", async () => {
    await withSchema("hns_retention_uninspected", async (admin) => {
      await expect(
        recordReview(admin, {
          generation: 1,
          decision: "retire_authorized",
          evidenceRef: "review-uninspected",
          inspected: false,
        }),
      ).rejects.toThrow();
      expect(await authorization(admin)).toEqual([]);
    });
  });

  test("reviews are append-only", async () => {
    await withSchema("hns_retention_immutable", async (admin) => {
      await recordReview(admin, { generation: 1, decision: "retain", evidenceRef: "retain-2" });
      await expect(
        admin.query(
          "UPDATE hns_root_import_retention_reviews SET decision='retire_authorized' WHERE root_import_session_id=$1",
          [SESSION],
        ),
      ).rejects.toThrow();
      await expect(
        admin.query(
          "DELETE FROM hns_root_import_retention_reviews WHERE root_import_session_id=$1",
          [SESSION],
        ),
      ).rejects.toThrow();
      expect(await authorization(admin)).toEqual([]);
    });
  });
});
