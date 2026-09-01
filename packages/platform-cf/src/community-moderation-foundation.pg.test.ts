import { afterAll, describe, expect, test } from "bun:test";
import { MODERATION_PLATFORM_FLOOR_V1, MODERATION_POLICY_CATEGORIES_V1 } from "@pirate/domain";
import { Effect } from "effect";
import { Client } from "pg";
import {
  loadPostgresMigrations,
  runPostgresMigrations,
} from "../../../scripts/postgres-migrations.ts";
import { makeControlPlaneCommunityModerationStore } from "./community-moderation-repository.ts";
import {
  activatePendingPersonaFixtures,
  backfillActivePersonaWalletFixtures,
} from "./persona-wallet.pg-fixture.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";

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
const testCount = 4;
let completedTestCount = 0;
const migrations = await loadPostgresMigrations();
const foundationMigrationVersion = "0059_community_moderation_authority_policy.sql";
const cutoverMigrationVersion = "0061_openai_moderation_driver_cutover.sql";
const runtimeMigrationVersion = "0065_text_ratings_age_access.sql";
const postSlugMigrationVersion = "0103_public_post_slug_aliases.sql";
const heldVisibilityMigrationVersion = "0104_text_held_revision_visibility.sql";
const foundationMigrationIndex = migrations.findIndex(
  (migration) => migration.version === foundationMigrationVersion,
);
const cutoverMigrationIndex = migrations.findIndex(
  (migration) => migration.version === cutoverMigrationVersion,
);
const runtimeMigrationIndex = migrations.findIndex(
  (migration) => migration.version === runtimeMigrationVersion,
);
const postSlugMigrationIndex = migrations.findIndex(
  (migration) => migration.version === postSlugMigrationVersion,
);
const heldVisibilityMigrationIndex = migrations.findIndex(
  (migration) => migration.version === heldVisibilityMigrationVersion,
);
const postSlugMigration = migrations[postSlugMigrationIndex];
const heldVisibilityMigration = migrations[heldVisibilityMigrationIndex];
if (
  foundationMigrationIndex < 0 ||
  cutoverMigrationIndex <= foundationMigrationIndex ||
  runtimeMigrationIndex <= cutoverMigrationIndex ||
  postSlugMigrationIndex <= runtimeMigrationIndex ||
  heldVisibilityMigrationIndex <= postSlugMigrationIndex ||
  postSlugMigration === undefined ||
  heldVisibilityMigration === undefined
) {
  throw new Error(
    "community moderation migrations must exist in foundation, cutover, runtime, and post-slug order",
  );
}
const foundationMigrations = migrations.slice(0, foundationMigrationIndex + 1);
const cutoverMigrations = migrations.slice(0, cutoverMigrationIndex + 1);
const runtimeMigrations = [
  ...migrations.slice(0, runtimeMigrationIndex + 1),
  postSlugMigration,
  heldVisibilityMigration,
];

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
  if (foundationMigrationIndex < 1)
    throw new Error(`${foundationMigrationVersion} is not in the migration plan`);
  await runPostgresMigrations({
    connectionString: connection,
    migrations: migrations.slice(0, foundationMigrationIndex),
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

      await runPostgresMigrations({
        connectionString: connection,
        migrations: foundationMigrations,
      });
      const replay = await runPostgresMigrations({
        connectionString: connection,
        migrations: foundationMigrations,
      });
      expect(replay).toEqual({
        dryRun: false,
        result: { applied: [], currentVersion: foundationMigrationVersion },
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
          runPostgresMigrations({ connectionString: connection, migrations: foundationMigrations }),
        ).rejects.toThrow();
        const ledger = await admin.query<{ version: string }>(
          "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1",
        );
        expect(ledger.rows[0]?.version).toBe(migrations[foundationMigrationIndex - 1]?.version);
        const authorityTable = await admin.query<{ table_name: string | null }>(
          "SELECT to_regclass('community_role_assignments')::text AS table_name",
        );
        expect(authorityTable.rows[0]?.table_name).toBeNull();
      });
    }
    completedTestCount += 1;
  }, 120_000);

  test("cuts over to the pinned provider and fences new writes to complete V2 evidence", async () => {
    if (cutoverMigrationIndex <= foundationMigrationIndex) {
      throw new Error(`${cutoverMigrationVersion} must follow the moderation foundation`);
    }
    await withSchema(async (connection, admin) => {
      await applyMigrationPrefix(connection);
      await insertUser(admin, "moderation-cutover-owner");
      await insertCommunity(admin, "moderation-cutover", "moderation-cutover-owner");
      await backfillActivePersonaWalletFixtures(admin);
      await runPostgresMigrations({
        connectionString: connection,
        migrations: foundationMigrations,
      });

      await runPostgresMigrations({ connectionString: connection, migrations: cutoverMigrations });
      const replay = await runPostgresMigrations({
        connectionString: connection,
        migrations: cutoverMigrations,
      });
      expect(replay).toEqual({
        dryRun: false,
        result: { applied: [], currentVersion: cutoverMigrationVersion },
      });

      const pointer = await admin.query<{
        policy_revision_id: string;
        model_identifier: string;
      }>(
        `SELECT current.policy_revision_id, revision.model_identifier
           FROM text_moderation_policy_current AS current
           JOIN text_moderation_policy_revisions AS revision
             ON revision.policy_revision_id = current.policy_revision_id
          WHERE current.singleton`,
      );
      expect(pointer.rows).toEqual([
        {
          policy_revision_id: "text-moderation-policy-openai-omni-2024-09-26-v1",
          model_identifier: "omni-moderation-2024-09-26",
        },
      ]);

      await expect(
        admin.query(
          `INSERT INTO text_content_submissions (
             community_id, submission_id, actor_user_id, surface, idempotency_key,
             request_hash, status, moderation_decision, public_reason_code,
             policy_revision_id, policy_hash, input_sha256, internal_reason_codes,
             evidence_ref, published_post_id, published_comment_id, review_ref,
             operation_id, response_snapshot_bytes, response_snapshot_sha256,
             author_persona_id
           ) SELECT
             'moderation-cutover', 'moderation-cutover-v1', 'moderation-cutover-owner',
             'text_post', 'moderation-cutover-v1-key', $1, 'blocked', 'blocked',
             'policy_violation', current.policy_revision_id, revision.policy_hash, $2,
             '["other_policy"]'::jsonb, NULL, NULL, NULL, NULL,
             'moderation-cutover-v1-operation', convert_to('{}', 'UTF8'),
             encode(sha256(convert_to('{}', 'UTF8')), 'hex'), persona.persona_id
           FROM text_moderation_policy_current AS current
           JOIN text_moderation_policy_revisions AS revision
             ON revision.policy_revision_id = current.policy_revision_id
           JOIN personas AS persona
             ON persona.account_id = 'moderation-cutover-owner' AND persona.is_first_persona
          WHERE current.singleton`,
          ["5".repeat(64), "6".repeat(64)],
        ),
      ).rejects.toThrow("new text moderation submissions require complete V2 policy evidence");

      await admin.query(
        `INSERT INTO text_moderation_evidence (
           evidence_ref, provider_id, requested_model_identifier,
           response_model_identifier, outcome, normalized_categories,
           normalized_scores, response_sha256, applied_input_types,
           input_sha256, input_hashes, evidence_hash, community_id,
           policy_revision_id, policy_hash,
           platform_policy_revision_id, platform_policy_hash,
           community_policy_revision_id, community_policy_hash
         ) SELECT
           'moderation-cutover-evidence', 'openai', provider.model_identifier,
           provider.model_identifier, 'evaluated', '{}'::jsonb, '{}'::jsonb, $1,
           '{}'::jsonb, $2, to_jsonb(ARRAY[$2]::text[]), $1, 'moderation-cutover',
           provider.policy_revision_id, provider.policy_hash,
           platform.policy_revision_id, platform.policy_hash,
           community.policy_revision_id, community.policy_hash
         FROM text_moderation_policy_current AS provider_current
         JOIN text_moderation_policy_revisions AS provider
           ON provider.policy_revision_id = provider_current.policy_revision_id
         CROSS JOIN moderation_platform_floor_current AS platform_current
         JOIN moderation_platform_floor_revisions AS platform
           ON platform.policy_revision_id = platform_current.policy_revision_id
          AND platform.policy_hash = platform_current.policy_hash
         JOIN community_moderation_policy_current AS community_current
           ON community_current.community_id = 'moderation-cutover'
         JOIN community_moderation_policy_revisions AS community
           ON community.community_id = community_current.community_id
          AND community.policy_revision_id = community_current.policy_revision_id
          AND community.policy_hash = community_current.policy_hash
        WHERE provider_current.singleton AND platform_current.singleton`,
        ["7".repeat(64), "8".repeat(64)],
      );

      await admin.query(
        `INSERT INTO text_content_submissions (
           community_id, submission_id, actor_user_id, surface, idempotency_key,
           request_hash, status, moderation_decision, public_reason_code,
           policy_revision_id, policy_hash, input_sha256, internal_reason_codes,
           evidence_ref, published_post_id, published_comment_id, review_ref,
           operation_id, response_snapshot_bytes, response_snapshot_sha256,
           author_persona_id, platform_policy_revision_id, platform_policy_hash,
           community_policy_revision_id, community_policy_hash
         ) SELECT
           'moderation-cutover', 'moderation-cutover-v2', 'moderation-cutover-owner',
           'text_post', 'moderation-cutover-v2-key', $1, 'blocked', 'blocked',
           'policy_violation', provider.policy_revision_id, provider.policy_hash, $2,
           '["other_policy"]'::jsonb, 'moderation-cutover-evidence', NULL, NULL, NULL,
           'moderation-cutover-v2-operation', convert_to('{}', 'UTF8'),
           encode(sha256(convert_to('{}', 'UTF8')), 'hex'), persona.persona_id,
           platform.policy_revision_id, platform.policy_hash,
           community.policy_revision_id, community.policy_hash
         FROM text_moderation_policy_current AS provider_current
         JOIN text_moderation_policy_revisions AS provider
           ON provider.policy_revision_id = provider_current.policy_revision_id
         CROSS JOIN moderation_platform_floor_current AS platform_current
         JOIN moderation_platform_floor_revisions AS platform
           ON platform.policy_revision_id = platform_current.policy_revision_id
          AND platform.policy_hash = platform_current.policy_hash
         JOIN community_moderation_policy_current AS community_current
           ON community_current.community_id = 'moderation-cutover'
         JOIN community_moderation_policy_revisions AS community
           ON community.community_id = community_current.community_id
          AND community.policy_revision_id = community_current.policy_revision_id
          AND community.policy_hash = community_current.policy_hash
         JOIN personas AS persona
           ON persona.account_id = 'moderation-cutover-owner' AND persona.is_first_persona
        WHERE provider_current.singleton AND platform_current.singleton`,
        ["9".repeat(64), "8".repeat(64)],
      );

      const persisted = await admin.query<{
        submission_id: string;
        evidence_ref: string;
        provider_policy: string;
        platform_policy: string;
        community_policy: string;
      }>(
        `SELECT submission_id, evidence_ref,
                policy_revision_id AS provider_policy,
                platform_policy_revision_id AS platform_policy,
                community_policy_revision_id AS community_policy
           FROM text_content_submissions
          WHERE submission_id = 'moderation-cutover-v2'`,
      );
      expect(persisted.rows).toEqual([
        {
          submission_id: "moderation-cutover-v2",
          evidence_ref: "moderation-cutover-evidence",
          provider_policy: "text-moderation-policy-openai-omni-2024-09-26-v1",
          platform_policy: "moderation-platform-floor-v1",
          community_policy: "community-moderation-policy:moderation-cutover:r1",
        },
      ]);
    });
    completedTestCount += 1;
  }, 120_000);

  test("enforces owner-only runtime authority, policy, reports, actions, and platform holds", async () => {
    await withSchema(async (connection, admin) => {
      await runPostgresMigrations({ connectionString: connection, migrations: runtimeMigrations });
      const floor = await admin.query<{ category: string; decision: string }>(
        `SELECT decision.category, decision.decision
           FROM moderation_platform_floor_current AS current
           JOIN moderation_platform_floor_category_decisions AS decision
             ON decision.policy_revision_id = current.policy_revision_id
          WHERE current.singleton
          ORDER BY moderation_policy_category_ordinal_v1(decision.category)`,
      );
      expect(floor.rows.map(({ category }) => category)).toEqual([
        ...MODERATION_POLICY_CATEGORIES_V1,
      ]);
      expect(
        Object.fromEntries(floor.rows.map(({ category, decision }) => [category, decision])),
      ).toEqual(MODERATION_PLATFORM_FLOOR_V1);
      await insertUser(admin, "moderation-runtime-owner");
      await insertUser(admin, "moderation-runtime-foreign");
      await insertUser(admin, "moderation-runtime-member");
      await activatePendingPersonaFixtures(admin);
      await insertCommunity(admin, "moderation-runtime", "moderation-runtime-owner");
      await admin.query(
        `INSERT INTO community_memberships (
           community_id, membership_id, user_id, status, joined_at, created_at, updated_at
         ) VALUES
           ('moderation-runtime', 'moderation-runtime-owner-membership',
            'moderation-runtime-owner', 'member', now(), now(), now()),
           ('moderation-runtime', 'moderation-runtime-member-membership',
            'moderation-runtime-member', 'member', now(), now(), now())`,
      );
      await admin.query(
        `INSERT INTO text_moderation_evidence (
           evidence_ref, provider_id, requested_model_identifier,
           response_model_identifier, outcome, normalized_categories,
           normalized_scores, response_sha256, applied_input_types,
           input_sha256, input_hashes, evidence_hash, community_id,
           policy_revision_id, policy_hash, platform_policy_revision_id,
           platform_policy_hash, community_policy_revision_id,
           community_policy_hash
         ) SELECT
           'moderation-runtime-evidence', 'openai', provider.model_identifier,
           provider.model_identifier, 'evaluated', '{}'::jsonb, '{}'::jsonb,
           repeat('1', 64), '{}'::jsonb, repeat('2', 64),
           to_jsonb(ARRAY[repeat('2', 64)]::text[]), repeat('1', 64),
           'moderation-runtime', provider.policy_revision_id, provider.policy_hash,
           platform.policy_revision_id, platform.policy_hash,
           community.policy_revision_id, community.policy_hash
         FROM text_moderation_policy_current AS provider_current
         JOIN text_moderation_policy_revisions AS provider
           ON provider.policy_revision_id = provider_current.policy_revision_id
         CROSS JOIN moderation_platform_floor_current AS platform_current
         JOIN moderation_platform_floor_revisions AS platform
           ON platform.policy_revision_id = platform_current.policy_revision_id
          AND platform.policy_hash = platform_current.policy_hash
         JOIN community_moderation_policy_current AS community_current
           ON community_current.community_id = 'moderation-runtime'
         JOIN community_moderation_policy_revisions AS community
           ON community.community_id = community_current.community_id
          AND community.policy_revision_id = community_current.policy_revision_id
          AND community.policy_hash = community_current.policy_hash
        WHERE provider_current.singleton AND platform_current.singleton`,
      );

      const insertSubmission = async (input: {
        readonly submissionId: string;
        readonly caseRef: string;
        readonly rating: "general" | "adult_18";
        readonly status: "manual_review" | "blocked";
        readonly source: "automatic" | "platform_held";
        readonly visibility?: "public" | "members_only";
      }) => {
        await admin.query("BEGIN");
        try {
          await admin.query(
            `INSERT INTO text_content_submissions (
             community_id, submission_id, actor_user_id, author_persona_id,
             surface, idempotency_key, request_hash, status,
             moderation_decision, public_reason_code, policy_revision_id,
             policy_hash, platform_policy_revision_id, platform_policy_hash,
             community_policy_revision_id, community_policy_hash, input_sha256,
             internal_reason_codes, evidence_ref, review_ref, operation_id,
             response_snapshot_bytes, response_snapshot_sha256,
             author_declared_rating, resulting_content_rating,
             matched_categories, category_decisions, effective_policy_decision
           ) SELECT
             'moderation-runtime', $1, 'moderation-runtime-member', persona.persona_id,
             'text_post', $1 || '-key', repeat('3', 64), $2,
             CASE WHEN $2 = 'manual_review' THEN 'manual_review' ELSE 'blocked' END,
             CASE WHEN $2 = 'manual_review' THEN 'review_required' ELSE 'policy_violation' END,
             provider.policy_revision_id, provider.policy_hash,
             platform.policy_revision_id, platform.policy_hash,
             community.policy_revision_id, community.policy_hash, repeat('4', 64),
             CASE WHEN $5 = 'platform_held'
               THEN '["sexual_minors"]'::jsonb ELSE '["harassment"]'::jsonb END,
             'moderation-runtime-evidence',
             CASE WHEN $2 = 'manual_review' THEN $3 ELSE NULL END,
             $1 || '-operation', convert_to('{}', 'UTF8'),
             encode(sha256(convert_to('{}', 'UTF8')), 'hex'),
             $4, $4,
             CASE WHEN $5 = 'platform_held'
               THEN '["sexual/minors"]'::jsonb ELSE '["harassment"]'::jsonb END,
             CASE WHEN $5 = 'platform_held'
               THEN '{"sexual/minors":"block"}'::jsonb
               ELSE '{"harassment":"review"}'::jsonb END,
             CASE WHEN $2 = 'manual_review' THEN 'review' ELSE 'block' END
           FROM text_moderation_policy_current AS provider_current
           JOIN text_moderation_policy_revisions AS provider
             ON provider.policy_revision_id = provider_current.policy_revision_id
           CROSS JOIN moderation_platform_floor_current AS platform_current
           JOIN moderation_platform_floor_revisions AS platform
             ON platform.policy_revision_id = platform_current.policy_revision_id
            AND platform.policy_hash = platform_current.policy_hash
           JOIN community_moderation_policy_current AS community_current
             ON community_current.community_id = 'moderation-runtime'
           JOIN community_moderation_policy_revisions AS community
             ON community.community_id = community_current.community_id
            AND community.policy_revision_id = community_current.policy_revision_id
            AND community.policy_hash = community_current.policy_hash
           JOIN personas AS persona
             ON persona.account_id = 'moderation-runtime-member' AND persona.is_first_persona
          WHERE provider_current.singleton AND platform_current.singleton`,
            [input.submissionId, input.status, input.caseRef, input.rating, input.source],
          );
          if (input.status === "manual_review") {
            await admin.query(
              `INSERT INTO text_content_held_revisions (
               community_id, held_revision_id, submission_id, title, body, visibility, content_sha256
             ) VALUES ('moderation-runtime', $1, $2, 'Held title', 'Held body', $3, repeat('5', 64))`,
              [`${input.submissionId}-held`, input.submissionId, input.visibility ?? "public"],
            );
            await admin.query(
              `INSERT INTO text_moderation_cases (
                 community_id, case_id, submission_id,
                 platform_policy_revision_id, platform_policy_hash,
                 community_policy_revision_id, community_policy_hash
               ) SELECT 'moderation-runtime', $1, submission_id,
                        platform_policy_revision_id, platform_policy_hash,
                        community_policy_revision_id, community_policy_hash
                   FROM text_content_submissions
                  WHERE community_id = 'moderation-runtime' AND submission_id = $2`,
              [input.caseRef, input.submissionId],
            );
          }
          await admin.query(
            `INSERT INTO community_moderation_cases_v2 (
             case_ref, community_id, submission_id, target_type, source,
             visibility, view_state, target_status
           ) VALUES (
             $1, 'moderation-runtime', $2, 'text_post', $3,
             CASE WHEN $3 = 'platform_held' THEN 'platform' ELSE 'owner' END,
             CASE WHEN $3 = 'platform_held' THEN 'platform_held' ELSE 'open' END,
             CASE WHEN $3 = 'platform_held' THEN 'blocked' ELSE 'held' END
           )`,
            [input.caseRef, input.submissionId, input.source],
          );
          await admin.query("COMMIT");
        } catch (error) {
          await admin.query("ROLLBACK");
          throw error;
        }
      };

      await insertSubmission({
        submissionId: "moderation-runtime-general",
        caseRef: "moderation-runtime-case-general",
        rating: "general",
        status: "manual_review",
        source: "automatic",
        visibility: "public",
      });
      await insertSubmission({
        submissionId: "moderation-runtime-members",
        caseRef: "moderation-runtime-case-members",
        rating: "general",
        status: "manual_review",
        source: "automatic",
        visibility: "members_only",
      });
      await insertSubmission({
        submissionId: "moderation-runtime-adult",
        caseRef: "moderation-runtime-case-adult",
        rating: "adult_18",
        status: "manual_review",
        source: "automatic",
        visibility: "public",
      });
      await insertSubmission({
        submissionId: "moderation-runtime-platform",
        caseRef: "moderation-runtime-case-platform",
        rating: "adult_18",
        status: "blocked",
        source: "platform_held",
      });

      const store = makeControlPlaneCommunityModerationStore(
        makeDirectPostgresControlPlaneLayer(connection),
      );
      const owner = { kind: "user" as const, userId: "moderation-runtime-owner" };
      const foreign = { kind: "user" as const, userId: "moderation-runtime-foreign" };
      const capabilities = await Effect.runPromise(
        store.getCapabilities({ communityId: "moderation-runtime", actor: owner }),
      );
      expect(capabilities.capabilities).toEqual(["moderation.view", "moderation.act"]);
      await expect(
        Effect.runPromise(
          store.listCases({ communityId: "moderation-runtime", actor: foreign, view: "open" }),
        ),
      ).rejects.toMatchObject({ reason: "not-found" });

      const adultDetail = await Effect.runPromise(
        store.getCase({
          communityId: "moderation-runtime",
          caseRef: "moderation-runtime-case-adult",
          actor: owner,
        }),
      );
      expect(adultDetail.preview).toEqual({ kind: "locked", reason: "adult_rating" });
      await expect(
        Effect.runPromise(
          store.getCase({
            communityId: "moderation-runtime",
            caseRef: "moderation-runtime-case-platform",
            actor: owner,
          }),
        ),
      ).rejects.toMatchObject({ reason: "not-found" });
      await expect(
        Effect.runPromise(
          store.actOnCase({
            caseRef: "moderation-runtime-case-adult",
            actor: owner,
            idempotencyKey: "adult-approval",
            expectedCaseRevision: 1,
            action: "approve_as_adult_18",
            requestHash: "6".repeat(64),
          }),
        ),
      ).rejects.toMatchObject({ reason: "conflict" });

      const approved = await Effect.runPromise(
        store.actOnCase({
          caseRef: "moderation-runtime-case-general",
          actor: owner,
          idempotencyKey: "general-approval",
          expectedCaseRevision: 1,
          action: "approve_as_general",
          requestHash: "7".repeat(64),
        }),
      );
      expect(approved).toMatchObject({
        version: "moderation-case-action-result-v2",
        action: "approve_as_general",
        target_status: "published",
      });
      const replayed = await Effect.runPromise(
        store.actOnCase({
          caseRef: "moderation-runtime-case-general",
          actor: owner,
          idempotencyKey: "general-approval",
          expectedCaseRevision: 1,
          action: "approve_as_general",
          requestHash: "7".repeat(64),
        }),
      );
      expect(replayed).toEqual(approved);
      const approvedMembersOnly = await Effect.runPromise(
        store.actOnCase({
          caseRef: "moderation-runtime-case-members",
          actor: owner,
          idempotencyKey: "members-approval",
          expectedCaseRevision: 1,
          action: "approve_as_general",
          requestHash: "a".repeat(64),
        }),
      );
      expect(approvedMembersOnly).toMatchObject({
        version: "moderation-case-action-result-v2",
        action: "approve_as_general",
        target_status: "published",
      });
      const published = await admin.query<{ published_post_id: string }>(
        `SELECT published_post_id FROM text_content_submissions
          WHERE submission_id = 'moderation-runtime-general'`,
      );
      const postId = published.rows[0]?.published_post_id;
      expect(postId).toBeString();
      if (postId === undefined) throw new Error("approved post was not persisted");
      await expect(
        admin.query(
          "SELECT author_declared_rating, content_rating FROM posts WHERE community_id = $1 AND post_id = $2",
          ["moderation-runtime", postId],
        ),
      ).resolves.toMatchObject({
        rows: [{ author_declared_rating: "general", content_rating: "general" }],
      });
      const membersPublished = await admin.query<{ published_post_id: string }>(
        `SELECT published_post_id FROM text_content_submissions
          WHERE submission_id = 'moderation-runtime-members'`,
      );
      const membersPostId = membersPublished.rows[0]?.published_post_id;
      expect(membersPostId).toBeString();
      if (membersPostId === undefined) throw new Error("members-only post was not persisted");
      const aliases = await admin.query<{
        post_id: string;
        slug: string;
        slug_policy_version: string;
        visibility: string;
        content_rating: string;
      }>(
        `SELECT alias.post_id, alias.slug, alias.slug_policy_version,
                post.visibility, post.content_rating
           FROM post_slug_aliases AS alias
           JOIN posts AS post ON post.post_id = alias.post_id
          WHERE alias.post_id IN ($1, $2)`,
        [postId, membersPostId],
      );
      expect(aliases.rows).toHaveLength(2);
      const generalAlias = aliases.rows.find((alias) => alias.post_id === postId);
      expect(generalAlias).toMatchObject({
        slug: "held-title",
        slug_policy_version: "post-slug-v1",
        visibility: "public",
        content_rating: "general",
      });
      const membersAlias = aliases.rows.find((alias) => alias.post_id === membersPostId);
      expect(membersAlias).toMatchObject({
        slug_policy_version: "post-slug-v1",
        visibility: "members_only",
        content_rating: "general",
      });
      expect(membersAlias?.slug).toMatch(/^post-[0-9abcdefghjkmnpqrstvwxyz]{10}$/u);
      expect(membersAlias?.slug).not.toBe("held-title");

      const firstReport = await Effect.runPromise(
        store.reportTarget({
          targetType: "post",
          targetId: postId,
          actor: { kind: "user", userId: "moderation-runtime-member" },
          idempotencyKey: "report-one",
          reasonCode: "spam",
          requestHash: "8".repeat(64),
        }),
      );
      expect(firstReport.status).toBe("open");
      const coalesced = await Effect.runPromise(
        store.reportTarget({
          targetType: "post",
          targetId: postId,
          actor: { kind: "user", userId: "moderation-runtime-member" },
          idempotencyKey: "report-two",
          reasonCode: "misleading",
          requestHash: "9".repeat(64),
        }),
      );
      expect(coalesced).toMatchObject({ case_ref: firstReport.case_ref, status: "coalesced" });

      const policy = await Effect.runPromise(
        store.getPolicy({ communityId: "moderation-runtime", actor: owner }),
      );
      const decisions = Object.fromEntries(
        policy.categories.map((category) => [category.category, category.community_decision]),
      ) as Parameters<typeof store.updatePolicy>[0]["update"]["decisions"];
      const updated = await Effect.runPromise(
        store.updatePolicy({
          communityId: "moderation-runtime",
          actor: owner,
          update: {
            expected_policy_revision: policy.policy_revision_id,
            decisions: { ...decisions, harassment: "block" },
          },
        }),
      );
      expect(updated.revision).toBe(policy.revision + 1);
      expect(
        updated.categories.find((category) => category.category === "harassment"),
      ).toMatchObject({ community_decision: "block", effective_decision: "block" });

      const audit = await admin.query<{
        presenting_persona_id: string;
        owner_role_assignment_id: string;
        platform_policy_revision_id: string;
        community_policy_revision_id: string;
        resolved_age_capability: string;
      }>(
        `SELECT presenting_persona_id, owner_role_assignment_id,
                platform_policy_revision_id, community_policy_revision_id,
                resolved_age_capability
           FROM community_moderation_actions_v2
          WHERE action_id = $1`,
        [approved.action_id],
      );
      expect(audit.rows[0]).toMatchObject({
        resolved_age_capability: "general",
      });
      expect(audit.rows[0]?.presenting_persona_id).toBeString();
      expect(audit.rows[0]?.owner_role_assignment_id).toBeString();
      expect(audit.rows[0]?.platform_policy_revision_id).toBeString();
      expect(audit.rows[0]?.community_policy_revision_id).toBeString();
    });
    completedTestCount += 1;
  }, 120_000);
});
