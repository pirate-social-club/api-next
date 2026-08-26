import { afterAll, describe, expect, test } from "bun:test";
import { Client } from "pg";
import {
  loadPostgresMigrations,
  runPostgresMigrations,
} from "../../../scripts/postgres-migrations.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;
const sentinelPath =
  process.env.CONTROL_PLANE_POSTGRES_COMMUNITY_MODERATION_TEST_SENTINEL ??
  "/tmp/api-next-control-plane-postgres-community-moderation-suite-complete";
const sentinelContents = "api-next-control-plane-postgres-community-moderation-suite-complete\n";
const testCount = 2;
let completedTestCount = 0;
const migrations = await loadPostgresMigrations();
const migrationVersion = "0059_community_moderation_authority_policy.sql";
const migrationIndex = migrations.findIndex((migration) => migration.version === migrationVersion);

function schemaName(): string {
  return `api_next_community_moderation_${crypto.randomUUID().replaceAll("-", "")}`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function scopedConnection(raw: string, schema: string): string {
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}options=-csearch_path%3D${schema}`;
}

const schemas = new Set<string>();

async function withSchema(
  run: (connection: string, admin: Client) => Promise<void>,
): Promise<void> {
  if (connectionString === undefined) throw new Error("missing PostgreSQL test URL");
  const schema = schemaName();
  schemas.add(schema);
  const root = new Client({ connectionString });
  await root.connect();
  await root.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  await root.end();
  const connection = scopedConnection(connectionString, schema);
  const admin = new Client({ connectionString: connection });
  await admin.connect();
  try {
    await run(connection, admin);
  } finally {
    await admin.end();
  }
}

async function applyMigrationPrefix(connection: string): Promise<void> {
  if (migrationIndex < 1) throw new Error(`${migrationVersion} is not in the migration plan`);
  await runPostgresMigrations({
    connectionString: connection,
    migrations: migrations.slice(0, migrationIndex),
  });
}

async function insertUser(admin: Client, userId: string, status = "active"): Promise<void> {
  await admin.query("INSERT INTO users (user_id, status, account) VALUES ($1, $2, '{}'::jsonb)", [
    userId,
    status,
  ]);
}

async function insertCommunity(
  admin: Client,
  communityId: string,
  creatorId: string,
  status: "active" | "hidden" | "archived" = "active",
): Promise<void> {
  await admin.query(
    `INSERT INTO communities (
       community_id, display_name, status, created_by_user_id, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, clock_timestamp(), clock_timestamp())`,
    [communityId, `Moderation ${communityId}`, status, creatorId],
  );
}

afterAll(async () => {
  if (connectionString === undefined) return;
  const admin = new Client({ connectionString });
  await admin.connect();
  try {
    for (const schema of schemas) {
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    }
  } finally {
    await admin.end();
  }
  if (completedTestCount === testCount) await Bun.write(sentinelPath, sentinelContents);
});

suite("community moderation authority and policy migration", () => {
  test("backfills history and enforces owner and complete immutable policy invariants", async () => {
    await withSchema(async (connection, admin) => {
      await applyMigrationPrefix(connection);
      await insertUser(admin, "moderation-owner-a");
      await insertUser(admin, "moderation-owner-b");
      await insertCommunity(admin, "moderation-active", "moderation-owner-a", "active");
      await insertCommunity(admin, "moderation-hidden", "moderation-owner-a", "hidden");
      await insertCommunity(admin, "moderation-archived", "moderation-owner-b", "archived");

      await admin.query(
        `INSERT INTO text_content_submissions (
           community_id, submission_id, actor_user_id, surface, idempotency_key,
           request_hash, status, moderation_decision, public_reason_code,
           policy_revision_id, policy_hash, input_sha256, internal_reason_codes,
           evidence_ref, published_post_id, published_comment_id, review_ref,
           operation_id, response_snapshot_bytes, response_snapshot_sha256,
           author_persona_id
         ) VALUES (
           'moderation-active', 'moderation-v1-submission', 'moderation-owner-a',
           'text_post', 'moderation-v1-key', $1, 'blocked', 'blocked',
           'policy_violation', 'text-moderation-policy-v1', $2, $3,
           '["sexual_minors"]'::jsonb, NULL, NULL, NULL, NULL,
           'moderation-v1-operation', convert_to('{"version":"legacy"}', 'UTF8'),
           encode(sha256(convert_to('{"version":"legacy"}', 'UTF8')), 'hex'),
           (
             SELECT persona_id FROM personas
              WHERE account_id = 'moderation-owner-a' AND is_first_persona
           )
         )`,
        [
          "1".repeat(64),
          "b0a8fd06312d7f9a99d7100633bc03fafc44b16aae5340899d290f54cb64df9d",
          "2".repeat(64),
        ],
      );
      const providerPointerBefore = await admin.query<{ policy_revision_id: string }>(
        "SELECT policy_revision_id FROM text_moderation_policy_current WHERE singleton",
      );

      await runPostgresMigrations({ connectionString: connection, migrations });
      const replay = await runPostgresMigrations({ connectionString: connection, migrations });
      expect(replay).toEqual({
        dryRun: false,
        result: { applied: [], currentVersion: migrationVersion },
      });

      const owners = await admin.query<{
        community_id: string;
        account_id: string;
        active_owner_count: string;
      }>(
        `SELECT community.community_id, assignment.account_id,
                count(*) FILTER (
                  WHERE assignment.role = 'owner' AND assignment.status = 'active'
                )::text AS active_owner_count
           FROM communities AS community
           JOIN community_role_assignments AS assignment
             ON assignment.community_id = community.community_id
          GROUP BY community.community_id, assignment.account_id
          ORDER BY community.community_id`,
      );
      expect(owners.rows).toEqual([
        {
          community_id: "moderation-active",
          account_id: "moderation-owner-a",
          active_owner_count: "1",
        },
        {
          community_id: "moderation-archived",
          account_id: "moderation-owner-b",
          active_owner_count: "1",
        },
        {
          community_id: "moderation-hidden",
          account_id: "moderation-owner-a",
          active_owner_count: "1",
        },
      ]);

      const policies = await admin.query<{
        community_id: string;
        category_count: string;
        sexual_minors: string;
        non_minor_reviews: string;
        hash_valid: boolean;
      }>(
        `SELECT current.community_id,
                count(decision.category)::text AS category_count,
                min(decision.decision) FILTER (
                  WHERE decision.category = 'sexual/minors'
                ) AS sexual_minors,
                count(*) FILTER (
                  WHERE decision.category <> 'sexual/minors' AND decision.decision = 'review'
                )::text AS non_minor_reviews,
                bool_and(
                  revision.policy_hash = encode(
                    sha256(convert_to(revision.policy_preimage, 'UTF8')), 'hex'
                  )
                ) AS hash_valid
           FROM community_moderation_policy_current AS current
           JOIN community_moderation_policy_revisions AS revision
             ON revision.community_id = current.community_id
            AND revision.policy_revision_id = current.policy_revision_id
            AND revision.policy_hash = current.policy_hash
           JOIN community_moderation_policy_category_decisions AS decision
             ON decision.community_id = revision.community_id
            AND decision.policy_revision_id = revision.policy_revision_id
          GROUP BY current.community_id
          ORDER BY current.community_id`,
      );
      expect(policies.rows).toEqual([
        {
          community_id: "moderation-active",
          category_count: "13",
          sexual_minors: "block",
          non_minor_reviews: "12",
          hash_valid: true,
        },
        {
          community_id: "moderation-archived",
          category_count: "13",
          sexual_minors: "block",
          non_minor_reviews: "12",
          hash_valid: true,
        },
        {
          community_id: "moderation-hidden",
          category_count: "13",
          sexual_minors: "block",
          non_minor_reviews: "12",
          hash_valid: true,
        },
      ]);

      const legacy = await admin.query<{
        status: string;
        policy_revision_id: string;
        policy_hash: string;
        platform_policy_revision_id: string | null;
        community_policy_revision_id: string | null;
      }>(
        `SELECT status, policy_revision_id, policy_hash,
                platform_policy_revision_id, community_policy_revision_id
           FROM text_content_submissions
          WHERE submission_id = 'moderation-v1-submission'`,
      );
      expect(legacy.rows).toEqual([
        {
          status: "blocked",
          policy_revision_id: "text-moderation-policy-v1",
          policy_hash: "b0a8fd06312d7f9a99d7100633bc03fafc44b16aae5340899d290f54cb64df9d",
          platform_policy_revision_id: null,
          community_policy_revision_id: null,
        },
      ]);

      const providerPolicies = await admin.query<{
        current_policy_revision_id: string;
        pinned_count: string;
      }>(
        `SELECT current.policy_revision_id AS current_policy_revision_id,
                count(revision.policy_revision_id) FILTER (
                  WHERE revision.model_identifier = 'omni-moderation-2024-09-26'
                )::text AS pinned_count
           FROM text_moderation_policy_current AS current
           CROSS JOIN text_moderation_policy_revisions AS revision
          WHERE current.singleton
          GROUP BY current.policy_revision_id`,
      );
      expect(providerPolicies.rows).toEqual([
        {
          current_policy_revision_id: "text-moderation-policy-v1",
          pinned_count: "1",
        },
      ]);
      expect(providerPointerBefore.rows).toEqual([
        { policy_revision_id: "text-moderation-policy-v1" },
      ]);

      await insertCommunity(admin, "moderation-triggered", "moderation-owner-b");
      await admin.query(
        `SELECT initialize_community_owner_v1(
                  community_id, created_by_user_id, created_at
                ),
                initialize_community_moderation_policy_v1(community_id, created_at)
           FROM communities
          WHERE community_id = 'moderation-triggered'`,
      );
      const triggered = await admin.query<{
        role_assignment_id: string;
        policy_revision_id: string;
        category_count: string;
      }>(
        `SELECT assignment.role_assignment_id, current.policy_revision_id,
                count(decision.category)::text AS category_count
           FROM community_role_assignments AS assignment
           JOIN community_moderation_policy_current AS current
             ON current.community_id = assignment.community_id
           JOIN community_moderation_policy_category_decisions AS decision
             ON decision.community_id = current.community_id
            AND decision.policy_revision_id = current.policy_revision_id
          WHERE assignment.community_id = 'moderation-triggered'
            AND assignment.role = 'owner' AND assignment.status = 'active'
          GROUP BY assignment.role_assignment_id, current.policy_revision_id`,
      );
      expect(triggered.rows).toEqual([
        {
          role_assignment_id: "community-role:moderation-triggered:owner:v1",
          policy_revision_id: "community-moderation-policy:moderation-triggered:r1",
          category_count: "13",
        },
      ]);

      await expect(
        admin.query(
          "UPDATE community_role_assignments SET status = 'inactive' WHERE community_id = 'moderation-triggered' AND role = 'owner'",
        ),
      ).rejects.toThrow("community cannot be left without an active owner");
      await expect(
        admin.query(
          "DELETE FROM community_role_assignments WHERE community_id = 'moderation-triggered' AND role = 'owner'",
        ),
      ).rejects.toThrow("community cannot be left without an active owner");
      await expect(
        admin.query(
          `INSERT INTO community_role_assignments (
             role_assignment_id, community_id, account_id, role, status
           ) VALUES (
             'community-role:moderation-triggered:owner:duplicate',
             'moderation-triggered', 'moderation-owner-a', 'owner', 'active'
           )`,
        ),
      ).rejects.toThrow("community_role_assignments_one_active_owner_uidx");

      await admin.query("BEGIN");
      await admin.query(
        `INSERT INTO community_moderation_policy_revisions (
           community_id, policy_revision_id, revision, platform_floor_revision_id,
           platform_floor_hash, policy_preimage, policy_hash
         ) SELECT 'moderation-triggered', 'community-moderation-policy:incomplete', 2,
                  policy_revision_id, policy_hash, '[]', $1
             FROM moderation_platform_floor_current WHERE singleton`,
        ["3".repeat(64)],
      );
      await expect(admin.query("COMMIT")).rejects.toThrow(
        "community moderation policy revision must contain exactly thirteen categories",
      );

      await admin.query("BEGIN");
      await admin.query(
        `INSERT INTO community_moderation_policy_revisions (
           community_id, policy_revision_id, revision, platform_floor_revision_id,
           platform_floor_hash, policy_preimage, policy_hash
         ) SELECT 'moderation-triggered', 'community-moderation-policy:weaker', 2,
                  policy_revision_id, policy_hash, '[]', $1
             FROM moderation_platform_floor_current WHERE singleton`,
        ["4".repeat(64)],
      );
      await expect(
        admin.query(
          `INSERT INTO community_moderation_policy_category_decisions (
             community_id, policy_revision_id, category, decision
           ) VALUES (
             'moderation-triggered', 'community-moderation-policy:weaker',
             'harassment/threatening', 'permit'
           )`,
        ),
      ).rejects.toThrow("community moderation policy cannot weaken its platform floor");
      await admin.query("ROLLBACK");

      await expect(
        admin.query(
          "UPDATE moderation_platform_floor_revisions SET revision = 2 WHERE revision = 1",
        ),
      ).rejects.toThrow("moderation_platform_floor_revisions is append-only");
      await expect(
        admin.query("DELETE FROM moderation_platform_floor_current WHERE singleton"),
      ).rejects.toThrow("moderation platform floor current pointer cannot be deleted");
      await expect(
        admin.query(
          `UPDATE moderation_platform_floor_current
              SET updated_at = clock_timestamp()
            WHERE singleton`,
        ),
      ).rejects.toThrow("moderation platform floor current revision must advance");
      await expect(
        admin.query(
          `UPDATE community_moderation_policy_category_decisions
              SET decision = 'block'
            WHERE community_id = 'moderation-triggered' AND category = 'harassment'`,
        ),
      ).rejects.toThrow("community_moderation_policy_category_decisions is append-only");
    });
    completedTestCount += 1;
  }, 60_000);

  test("aborts atomically when an existing community creator is invalid", async () => {
    for (const fixture of ["blank", "missing", "deleted"] as const) {
      await withSchema(async (connection, admin) => {
        await applyMigrationPrefix(connection);
        const creatorId =
          fixture === "blank" ? "" : fixture === "missing" ? "missing-creator" : "deleted-creator";
        if (fixture === "deleted") await insertUser(admin, creatorId, "deleted");
        await insertCommunity(admin, `moderation-invalid-${fixture}`, creatorId);

        await expect(
          runPostgresMigrations({ connectionString: connection, migrations }),
        ).rejects.toThrow();
        const ledger = await admin.query<{ version: string }>(
          "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1",
        );
        expect(ledger.rows[0]?.version).toBe(migrations[migrationIndex - 1]?.version);
        const authorityTable = await admin.query<{ table_name: string | null }>(
          "SELECT to_regclass('community_role_assignments')::text AS table_name",
        );
        expect(authorityTable.rows[0]?.table_name).toBeNull();
      });
    }
    completedTestCount += 1;
  }, 120_000);
});
