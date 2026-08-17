import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ControlPlaneDb } from "@pirate/application";
import { Effect } from "effect";
import { Client } from "pg";

import { makeDirectPostgresControlPlaneLayer } from "./postgres";
import {
  applyPostgresMigrations,
  MigrationDefinitionInvalid,
  MigrationLedgerMismatch,
  type PostgresMigration,
} from "./postgres-migrations";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";

if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}

const suite = connectionString === undefined ? describe.skip : describe;
const foundationTestCount = 7;
const sentinelPath =
  process.env.CONTROL_PLANE_POSTGRES_FOUNDATION_TEST_SENTINEL ??
  "/tmp/api-next-control-plane-postgres-foundation-suite-complete";
const sentinelContents = "api-next-control-plane-postgres-foundation-suite-complete\n";
let completedTestCount = 0;
const baselineSql = await Bun.file(
  new URL("../../../db/postgres/schema.sql", import.meta.url),
).text();
const migrationSql = await Bun.file(
  new URL("../../../db/postgres/migrations/0001_v1_product_slice.sql", import.meta.url),
).text();
const identityMigrationSql = await Bun.file(
  new URL("../../../db/postgres/migrations/0002_identity.sql", import.meta.url),
).text();
const m2MigrationSql = await Bun.file(
  new URL("../../../db/postgres/migrations/0003_m2_community_content.sql", import.meta.url),
).text();
const commentLockMigrationSql = await Bun.file(
  new URL("../../../db/postgres/migrations/0004_post_comment_lock.sql", import.meta.url),
).text();
const m2BehaviorMigrationSql = await Bun.file(
  new URL("../../../db/postgres/migrations/0005_m2_behavior_invariants.sql", import.meta.url),
).text();
const publicProfileMigrationSql = await Bun.file(
  new URL("../../../db/postgres/migrations/0006_public_profile_handle_index.sql", import.meta.url),
).text();
const publicProfileInvariantMigrationSql = await Bun.file(
  new URL(
    "../../../db/postgres/migrations/0007_public_profile_handle_invariants.sql",
    import.meta.url,
  ),
).text();
const communityRouteSlugMigrationSql = await Bun.file(
  new URL("../../../db/postgres/migrations/0008_community_route_slug.sql", import.meta.url),
).text();
const gatesV2MigrationSql = await Bun.file(
  new URL("../../../db/postgres/migrations/0009_gates_v2_foundation.sql", import.meta.url),
).text();
const proofSessionProvenanceMigrationSql = await Bun.file(
  new URL("../../../db/postgres/migrations/0010_proof_session_provenance.sql", import.meta.url),
).text();
const verificationStartReservationsMigrationSql = await Bun.file(
  new URL(
    "../../../db/postgres/migrations/0011_verification_start_reservations.sql",
    import.meta.url,
  ),
).text();
const verificationCompletionAttemptsMigrationSql = await Bun.file(
  new URL(
    "../../../db/postgres/migrations/0012_verification_completion_attempts.sql",
    import.meta.url,
  ),
).text();
const checksumManifest = (await Bun.file(
  new URL("../../../db/postgres/migrations/checksums.json", import.meta.url),
).json()) as { readonly migrations: Readonly<Record<string, string>> };

const migration: PostgresMigration = {
  version: "0001_v1_product_slice.sql",
  checksum: checksumManifest.migrations["0001_v1_product_slice.sql"] ?? "",
  sql: migrationSql,
};
const identityMigration: PostgresMigration = {
  version: "0002_identity.sql",
  checksum: checksumManifest.migrations["0002_identity.sql"] ?? "",
  sql: identityMigrationSql,
};
const m2Migration: PostgresMigration = {
  version: "0003_m2_community_content.sql",
  checksum: checksumManifest.migrations["0003_m2_community_content.sql"] ?? "",
  sql: m2MigrationSql,
};
const commentLockMigration: PostgresMigration = {
  version: "0004_post_comment_lock.sql",
  checksum: checksumManifest.migrations["0004_post_comment_lock.sql"] ?? "",
  sql: commentLockMigrationSql,
};
const m2BehaviorMigration: PostgresMigration = {
  version: "0005_m2_behavior_invariants.sql",
  checksum: checksumManifest.migrations["0005_m2_behavior_invariants.sql"] ?? "",
  sql: m2BehaviorMigrationSql,
};
const publicProfileMigration: PostgresMigration = {
  version: "0006_public_profile_handle_index.sql",
  checksum: checksumManifest.migrations["0006_public_profile_handle_index.sql"] ?? "",
  sql: publicProfileMigrationSql,
};
const publicProfileInvariantMigration: PostgresMigration = {
  version: "0007_public_profile_handle_invariants.sql",
  checksum: checksumManifest.migrations["0007_public_profile_handle_invariants.sql"] ?? "",
  sql: publicProfileInvariantMigrationSql,
};
const communityRouteSlugMigration: PostgresMigration = {
  version: "0008_community_route_slug.sql",
  checksum: checksumManifest.migrations["0008_community_route_slug.sql"] ?? "",
  sql: communityRouteSlugMigrationSql,
};
const gatesV2Migration: PostgresMigration = {
  version: "0009_gates_v2_foundation.sql",
  checksum: checksumManifest.migrations["0009_gates_v2_foundation.sql"] ?? "",
  sql: gatesV2MigrationSql,
};
const proofSessionProvenanceMigration: PostgresMigration = {
  version: "0010_proof_session_provenance.sql",
  checksum: checksumManifest.migrations["0010_proof_session_provenance.sql"] ?? "",
  sql: proofSessionProvenanceMigrationSql,
};
const verificationStartReservationsMigration: PostgresMigration = {
  version: "0011_verification_start_reservations.sql",
  checksum: checksumManifest.migrations["0011_verification_start_reservations.sql"] ?? "",
  sql: verificationStartReservationsMigrationSql,
};
const verificationCompletionAttemptsMigration: PostgresMigration = {
  version: "0012_verification_completion_attempts.sql",
  checksum: checksumManifest.migrations["0012_verification_completion_attempts.sql"] ?? "",
  sql: verificationCompletionAttemptsMigrationSql,
};
const migrations: readonly PostgresMigration[] = [
  migration,
  identityMigration,
  m2Migration,
  commentLockMigration,
  m2BehaviorMigration,
  publicProfileMigration,
  publicProfileInvariantMigration,
  communityRouteSlugMigration,
  gatesV2Migration,
  proofSessionProvenanceMigration,
  verificationStartReservationsMigration,
  verificationCompletionAttemptsMigration,
];

function checksum(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function schemaIdentifier(): string {
  return `api_next_foundation_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function connectionForSchema(raw: string, schema: string): string {
  const separator = raw.includes("?") ? "&" : "?";
  const option = encodeURIComponent(`-c search_path=${schema}`);
  return `${raw}${separator}options=${option}`;
}

async function applyMigrations(
  scopedConnectionString: string,
  migrations: readonly PostgresMigration[],
): Promise<unknown> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* ControlPlaneDb;
        return yield* applyPostgresMigrations(migrations);
      }).pipe(Effect.provide(makeDirectPostgresControlPlaneLayer(scopedConnectionString))),
    ),
  );
}

interface SchemaCatalog {
  readonly tables: readonly Record<string, unknown>[];
  readonly columns: readonly Record<string, unknown>[];
  readonly indexes: readonly Record<string, unknown>[];
  readonly constraints: readonly Record<string, unknown>[];
}

async function catalogForSchema(admin: Client, schema: string): Promise<SchemaCatalog> {
  const tables = await admin.query(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = $1 AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
    [schema],
  );
  const columns = await admin.query(
    `SELECT table_name, column_name, ordinal_position, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = $1
     ORDER BY table_name, ordinal_position`,
    [schema],
  );
  const indexes = await admin.query<{
    readonly table_name: string;
    readonly index_name: string;
    readonly indexdef: string;
  }>(
    `SELECT tablename AS table_name, indexname AS index_name, indexdef
     FROM pg_indexes
     WHERE schemaname = $1
     ORDER BY tablename, indexname`,
    [schema],
  );
  const constraints = await admin.query(
    `SELECT relation.relname AS table_name,
            pg_constraint.conname AS constraint_name,
            pg_constraint.contype AS constraint_type,
            pg_get_constraintdef(pg_constraint.oid) AS definition
     FROM pg_constraint
     JOIN pg_class AS relation ON relation.oid = pg_constraint.conrelid
     JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = $1
     ORDER BY relation.relname, constraint_name`,
    [schema],
  );
  return {
    tables: tables.rows,
    columns: columns.rows,
    indexes: indexes.rows.map((index) => ({
      ...index,
      indexdef: index.indexdef.replaceAll(`${schema}.`, ""),
    })),
    constraints: constraints.rows,
  };
}

async function withSchema<A>(
  use: (admin: Client, connection: string, schema: string) => Promise<A>,
): Promise<A> {
  if (connectionString === undefined) throw new Error("test URL was not configured");
  const schema = schemaIdentifier();
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
  const scopedConnectionString = connectionForSchema(connectionString, schema);
  try {
    return await use(admin, scopedConnectionString, schema);
  } finally {
    await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

async function expectForeignKeyFailure(
  admin: Client,
  text: string,
  values: readonly unknown[],
): Promise<void> {
  try {
    await admin.query({ text, values: [...values] });
    throw new Error("expected a composite foreign-key violation");
  } catch (error) {
    expect(error).toMatchObject({ code: "23503" });
  }
}

async function expectPostgresFailure(
  admin: Client,
  code: string,
  text: string,
  values: readonly unknown[],
): Promise<void> {
  try {
    await admin.query({ text, values: [...values] });
    throw new Error(`expected PostgreSQL error ${code}`);
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

suite("Postgres 17 product and gates v2 foundation", () => {
  test("applies all migrations and matches the cumulative schema source", async () => {
    await withSchema(async (admin, scopedConnectionString, schema) => {
      expect(checksum(migrationSql)).toBe(migration.checksum);
      expect(checksum(identityMigrationSql)).toBe(identityMigration.checksum);
      expect(checksum(m2MigrationSql)).toBe(m2Migration.checksum);
      expect(checksum(publicProfileMigrationSql)).toBe(publicProfileMigration.checksum);
      expect(checksum(publicProfileInvariantMigrationSql)).toBe(
        publicProfileInvariantMigration.checksum,
      );
      expect(checksum(communityRouteSlugMigrationSql)).toBe(communityRouteSlugMigration.checksum);
      expect(checksum(gatesV2MigrationSql)).toBe(gatesV2Migration.checksum);
      expect(checksum(proofSessionProvenanceMigrationSql)).toBe(
        proofSessionProvenanceMigration.checksum,
      );
      expect(checksum(verificationStartReservationsMigrationSql)).toBe(
        verificationStartReservationsMigration.checksum,
      );
      const version = await admin.query<{ server_version_num: string }>("SHOW server_version_num");
      expect(Number(version.rows[0]?.server_version_num)).toBeGreaterThanOrEqual(170000);

      await applyMigrations(scopedConnectionString, migrations);
      const migratedCatalog = await catalogForSchema(admin, schema);
      const baselineSchema = schemaIdentifier();
      await admin.query(`CREATE SCHEMA ${quoteIdentifier(baselineSchema)}`);
      try {
        await admin.query(`SET search_path TO ${quoteIdentifier(baselineSchema)}`);
        await admin.query(baselineSql);
        expect(migratedCatalog).toEqual(await catalogForSchema(admin, baselineSchema));
      } finally {
        await admin.query(`DROP SCHEMA ${quoteIdentifier(baselineSchema)} CASCADE`);
        await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
      }

      const tables = await admin.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()",
      );
      expect(tables.rows.map((row) => row.table_name).sort()).toEqual([
        "account_aliases",
        "action_challenges",
        "action_grants",
        "action_intents",
        "active_subject_key_bindings",
        "assertion_bindings",
        "assertion_revalidation_events",
        "assertions",
        "comments",
        "communities",
        "community_feed_projection",
        "community_follows",
        "community_memberships",
        "community_policy_current",
        "decision_records",
        "evidence_receipts",
        "home_feed_projection",
        "moderation_actions",
        "moderation_reports",
        "observations",
        "policy_versions",
        "post_votes",
        "posts",
        "proof_session_completion_events",
        "proof_session_presentations",
        "proof_sessions",
        "public_handle_index",
        "reward_subject_consumptions",
        "reward_uniqueness_authorities",
        "schema_migrations",
        "subject_key_binding_events",
        "subject_keys",
        "used_action_grants",
        "users",
        "verification_completion_attempts",
        "verification_start_reservations",
      ]);

      const gateTriggers = await admin.query<{ trigger_name: string }>(
        `SELECT trigger.tgname AS trigger_name
         FROM pg_trigger AS trigger
         JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
         JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = current_schema()
           AND NOT trigger.tgisinternal
           AND (trigger.tgname LIKE '%_append_only'
             OR trigger.tgname IN ('evidence_receipts_validate_metadata', 'assertions_validate_binding'))
         ORDER BY trigger.tgname`,
      );
      expect(gateTriggers.rows.map((row) => row.trigger_name)).toEqual([
        "action_grants_append_only",
        "assertion_bindings_append_only",
        "assertion_revalidation_events_append_only",
        "assertions_append_only",
        "assertions_validate_binding",
        "decision_records_append_only",
        "evidence_receipts_append_only",
        "evidence_receipts_validate_metadata",
        "observations_append_only",
        "policy_versions_append_only",
        "proof_session_completion_events_append_only",
        "proof_session_presentations_append_only",
        "reward_subject_consumptions_append_only",
        "reward_uniqueness_authorities_append_only",
        "subject_key_binding_events_append_only",
        "subject_keys_append_only",
        "used_action_grants_append_only",
      ]);

      const columns = await admin.query<{
        readonly table_name: string;
        readonly column_name: string;
        readonly is_nullable: string;
      }>(
        `SELECT table_name, column_name, is_nullable
         FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND ((table_name = 'communities' AND column_name IN ('membership_mode', 'human_verification_lane', 'route_slug'))
             OR (table_name = 'community_memberships' AND column_name = 'request_note')
             OR (table_name = 'posts' AND column_name IN ('author_user_id', 'body', 'post_type', 'visibility', 'idempotency_key', 'idempotency_body_hash', 'comments_locked'))
             OR (table_name = 'comments' AND column_name IN ('author_user_id', 'body', 'idempotency_key', 'idempotency_body_hash', 'depth'))
             OR (table_name = 'evidence_receipts' AND column_name IN ('provider_configuration_kind', 'provider_configuration_ref', 'provider_configuration_version'))
             OR (table_name = 'proof_sessions' AND column_name IN ('provider_configuration_kind', 'provider_configuration_ref', 'provider_configuration_version'))
             OR (table_name = 'proof_session_presentations' AND column_name IN ('proof_session_id', 'presentation_kind', 'payload', 'created_at')) )`,
      );
      expect(columns.rows).toEqual(
        expect.arrayContaining([
          { table_name: "posts", column_name: "author_user_id", is_nullable: "YES" },
          { table_name: "posts", column_name: "body", is_nullable: "YES" },
          { table_name: "posts", column_name: "post_type", is_nullable: "NO" },
          { table_name: "posts", column_name: "visibility", is_nullable: "NO" },
          { table_name: "posts", column_name: "idempotency_key", is_nullable: "NO" },
          { table_name: "posts", column_name: "idempotency_body_hash", is_nullable: "YES" },
          { table_name: "posts", column_name: "comments_locked", is_nullable: "NO" },
          { table_name: "comments", column_name: "author_user_id", is_nullable: "YES" },
          { table_name: "comments", column_name: "body", is_nullable: "YES" },
          { table_name: "comments", column_name: "idempotency_key", is_nullable: "NO" },
          { table_name: "comments", column_name: "idempotency_body_hash", is_nullable: "YES" },
          { table_name: "comments", column_name: "depth", is_nullable: "NO" },
          {
            table_name: "community_memberships",
            column_name: "request_note",
            is_nullable: "YES",
          },
          { table_name: "communities", column_name: "membership_mode", is_nullable: "NO" },
          {
            table_name: "communities",
            column_name: "human_verification_lane",
            is_nullable: "YES",
          },
          { table_name: "communities", column_name: "route_slug", is_nullable: "YES" },
          {
            table_name: "evidence_receipts",
            column_name: "provider_configuration_kind",
            is_nullable: "NO",
          },
          {
            table_name: "evidence_receipts",
            column_name: "provider_configuration_ref",
            is_nullable: "NO",
          },
          {
            table_name: "evidence_receipts",
            column_name: "provider_configuration_version",
            is_nullable: "NO",
          },
          {
            table_name: "proof_sessions",
            column_name: "provider_configuration_kind",
            is_nullable: "NO",
          },
          {
            table_name: "proof_sessions",
            column_name: "provider_configuration_ref",
            is_nullable: "NO",
          },
          {
            table_name: "proof_sessions",
            column_name: "provider_configuration_version",
            is_nullable: "NO",
          },
          {
            table_name: "proof_session_presentations",
            column_name: "proof_session_id",
            is_nullable: "NO",
          },
          {
            table_name: "proof_session_presentations",
            column_name: "presentation_kind",
            is_nullable: "NO",
          },
          {
            table_name: "proof_session_presentations",
            column_name: "payload",
            is_nullable: "NO",
          },
          {
            table_name: "proof_session_presentations",
            column_name: "created_at",
            is_nullable: "NO",
          },
        ]),
      );

      const postStatus = await admin.query<{ definition: string }>(
        `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
         WHERE conrelid = 'posts'::regclass AND contype = 'c' AND conname = 'posts_status_check'`,
      );
      expect(postStatus.rows[0]?.definition).toContain("processing");
      expect(postStatus.rows[0]?.definition).toContain("removed");

      const routeSlugIndex = await admin.query<{ indexdef: string }>(
        `SELECT indexdef
           FROM pg_indexes
          WHERE schemaname = current_schema()
            AND indexname = 'communities_route_slug_uidx'`,
      );
      expect(routeSlugIndex.rows).toHaveLength(1);
      expect(routeSlugIndex.rows[0]?.indexdef).toContain("WHERE (route_slug IS NOT NULL)");

      const communityOrdinals = await admin.query<{
        readonly column_name: string;
        readonly ordinal_position: number;
      }>(
        `SELECT column_name, ordinal_position
           FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'communities'
          ORDER BY ordinal_position`,
      );
      expect(communityOrdinals.rows).toEqual([
        { column_name: "community_id", ordinal_position: 1 },
        { column_name: "display_name", ordinal_position: 2 },
        { column_name: "status", ordinal_position: 3 },
        { column_name: "created_by_user_id", ordinal_position: 4 },
        { column_name: "created_at", ordinal_position: 5 },
        { column_name: "updated_at", ordinal_position: 6 },
        { column_name: "membership_mode", ordinal_position: 7 },
        { column_name: "human_verification_lane", ordinal_position: 8 },
        { column_name: "route_slug", ordinal_position: 9 },
      ]);
    });
    completedTestCount += 1;
  });

  test("refuses to invent provider configuration for an unexpected existing session", async () => {
    await withSchema(async (admin, scopedConnectionString) => {
      await applyMigrations(
        scopedConnectionString,
        migrations.slice(0, migrations.indexOf(proofSessionProvenanceMigration)),
      );
      await admin.query("INSERT INTO users (user_id) VALUES ('unexpected-user')");
      await admin.query(`INSERT INTO proof_sessions (
        proof_session_id, actor_id, intent_id, request_hash, provider_id, method, issuer,
        scope_kind, request_mode, protocol_version, environment, status,
        requested_requirements, requested_claim_ids, subject_binding_intent, started_at, expires_at
      ) VALUES (
        'unexpected-session', 'unexpected-user', 'unexpected-intent', '${"f".repeat(64)}',
        'unexpected.provider', 'document', 'unexpected.provider', 'none', 'dynamic',
        'unexpected-v1', 'test', 'pending', '[{"claim_id":"document.valid"}]'::jsonb,
        '["document.valid"]'::jsonb, 'none',
        '2026-08-17T00:00:00.000Z', '2026-08-18T00:00:00.000Z'
      )`);

      await expect(applyMigrations(scopedConnectionString, migrations)).rejects.toBeDefined();
      const applied = await admin.query<{ version: string }>(
        "SELECT version FROM schema_migrations ORDER BY version",
      );
      expect(applied.rows.at(-1)?.version).toBe(gatesV2Migration.version);
      const provenanceColumns = await admin.query<{ count: string }>(
        `SELECT count(*)
           FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'proof_sessions'
            AND column_name LIKE 'provider_configuration_%'`,
      );
      expect(provenanceColumns.rows[0]?.count).toBe("0");
    });
    completedTestCount += 1;
  });

  test("enforces gates v2 scope, co-reference, policy, and action-grant invariants", async () => {
    await withSchema(async (admin, scopedConnectionString) => {
      await applyMigrations(scopedConnectionString, migrations);
      const now = new Date("2026-08-17T00:00:00.000Z");
      const later = new Date("2026-08-18T00:00:00.000Z");
      const requestHash = "1".repeat(64);
      const evidenceHash = "2".repeat(64);
      const subjectDigest = "3".repeat(64);

      await admin.query({
        text: "INSERT INTO users (user_id) VALUES ($1), ($2)",
        values: ["user-a", "user-b"],
      });
      await expectPostgresFailure(
        admin,
        "23502",
        `INSERT INTO proof_sessions (
          proof_session_id, actor_id, intent_id, request_hash, provider_id, method, issuer,
          scope_kind, issuer_rp_scope, request_mode, protocol_version, environment, status,
          requested_requirements, requested_claim_ids, started_at, expires_at,
          provider_configuration_kind, provider_configuration_ref, provider_configuration_version
        ) VALUES ('session-implicit-binding', 'user-a', 'intent-implicit-binding', $1,
          'test.fake', 'document', 'test.fake', 'issuer_rp_scope', 'pirate.example', 'dynamic',
          'fake-v2', 'test', 'pending', '[{"claim_id":"document.valid"}]'::jsonb,
          '["document.valid"]'::jsonb, $2, $3, 'dynamic', 'test-config', '1')`,
        ["0".repeat(64), now, later],
      );
      await admin.query({
        text: "INSERT INTO communities (community_id, display_name, created_by_user_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)",
        values: ["community-a", "Community A", "user-a", now],
      });
      await admin.query({
        text: `INSERT INTO proof_sessions (
          proof_session_id, actor_id, intent_id, request_hash, provider_id, method, issuer,
          scope_kind, issuer_rp_scope, request_mode, protocol_version, environment, status,
          upstream_session_ref, requested_requirements, requested_claim_ids,
          subject_binding_intent, started_at, expires_at,
          provider_configuration_kind, provider_configuration_ref, provider_configuration_version
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'issuer_rp_scope', $8, 'dynamic', $9, $10,
          'pending', 'upstream-a', $11::jsonb, $12::jsonb, 'establish', $13, $14,
          'dynamic', 'test-config', '1')`,
        values: [
          "session-a",
          "user-a",
          "intent-a",
          requestHash,
          "test.fake",
          "document",
          "test.fake",
          "pirate.example",
          "fake-v2",
          "test",
          JSON.stringify([
            { claim_id: "credential.subject_unique" },
            { claim_id: "document.valid" },
          ]),
          JSON.stringify(["credential.subject_unique", "document.valid"]),
          now,
          later,
        ],
      });
      await expectPostgresFailure(
        admin,
        "23514",
        `INSERT INTO proof_sessions (
          proof_session_id, actor_id, intent_id, request_hash, provider_id, method, issuer,
          scope_kind, issuer_rp_scope, request_mode, protocol_version, environment, status,
          requested_requirements, requested_claim_ids, subject_binding_intent, started_at,
          expires_at, provider_configuration_kind, provider_configuration_ref,
          provider_configuration_version
        ) VALUES ('session-requirement-drift', 'user-b', 'intent-requirement-drift', $1,
          'test.fake', 'document', 'test.fake', 'issuer_rp_scope', 'pirate.example', 'dynamic',
          'fake-v2', 'test', 'pending', '[{"claim_id":"age.minimum","minimum_age":"21"}]'::jsonb,
          '["document.valid"]'::jsonb, 'establish', $2, $3, 'dynamic', 'test-config', '1')`,
        ["9".repeat(64), now, later],
      );
      await expectPostgresFailure(
        admin,
        "23505",
        `INSERT INTO proof_sessions (
          proof_session_id, actor_id, intent_id, request_hash, provider_id, method, issuer,
          scope_kind, issuer_rp_scope, request_mode, protocol_version, environment, status,
          upstream_session_ref, requested_requirements, requested_claim_ids,
          subject_binding_intent, started_at, expires_at,
          provider_configuration_kind, provider_configuration_ref, provider_configuration_version
        ) VALUES ('session-provider-replay', 'user-b', 'intent-provider-replay', $1,
          'test.fake', 'document', 'test.fake', 'issuer_rp_scope', 'pirate.example', 'dynamic',
          'fake-v2', 'test', 'pending', 'upstream-a',
          '[{"claim_id":"document.valid"}]'::jsonb, '["document.valid"]'::jsonb,
          'establish', $2, $3, 'dynamic', 'test-config', '1')`,
        ["f".repeat(64), now, later],
      );
      await expectPostgresFailure(
        admin,
        "23514",
        "UPDATE proof_sessions SET upstream_session_ref = 'upstream-rebound' WHERE proof_session_id = 'session-a'",
        [],
      );
      await expectPostgresFailure(
        admin,
        "23514",
        `UPDATE proof_sessions
            SET requested_requirements =
              '[{"claim_id":"credential.subject_unique","variant":"changed"},
                {"claim_id":"document.valid"}]'::jsonb
          WHERE proof_session_id = 'session-a'`,
        [],
      );
      await admin.query({
        text: `INSERT INTO subject_keys (
          subject_key_id, issuer, method, scope_kind, issuer_rp_scope,
          subject_digest, digest_algorithm, created_at
        ) VALUES ($1, $2, $3, 'issuer_rp_scope', $4, $5, 'sha256', $6)`,
        values: ["subject-a", "test.fake", "document", "pirate.example", subjectDigest, now],
      });
      await admin.query({
        text: `INSERT INTO subject_keys (
          subject_key_id, issuer, method, scope_kind, issuer_rp_scope,
          subject_digest, digest_algorithm, created_at
        ) VALUES ($1, $2, $3, 'issuer_rp_scope', $4, $5, 'sha256', $6)`,
        values: ["subject-b", "test.fake", "document", "pirate.example", "4".repeat(64), now],
      });
      await admin.query({
        text: `INSERT INTO subject_key_binding_events (
          binding_event_id, subject_key_id, binding_epoch, user_id, proof_session_id,
          binding_kind, previous_binding_event_id, idempotency_key, bound_at
        ) VALUES
          ('binding-event-a', 'subject-a', 1, 'user-a', 'session-a', 'initial', NULL,
            'bind-subject-a', $1),
          ('binding-event-b', 'subject-b', 1, 'user-a', 'session-a', 'initial', NULL,
            'bind-subject-b', $1)`,
        values: [now],
      });
      await expectPostgresFailure(
        admin,
        "23505",
        `INSERT INTO subject_keys (
          subject_key_id, issuer, method, scope_kind, issuer_rp_scope,
          subject_digest, digest_algorithm, created_at
        ) VALUES ($1, $2, $3, 'issuer_rp_scope', $4, $5, 'sha256', $6)`,
        ["subject-duplicate", "test.fake", "document", "pirate.example", subjectDigest, now],
      );
      await admin.query({
        text: `INSERT INTO subject_keys (
          subject_key_id, issuer, method, scope_kind, issuer_rp_scope,
          subject_digest, digest_algorithm, created_at
        ) VALUES ($1, $2, $3, 'issuer_rp_scope', $4, $5, 'sha256', $6)`,
        values: [
          "subject-other-scope",
          "test.fake",
          "document",
          "other.example",
          subjectDigest,
          now,
        ],
      });
      await expectPostgresFailure(
        admin,
        "23514",
        `INSERT INTO evidence_receipts (
          evidence_receipt_id, proof_session_id, user_id, provider_id, issuer, method,
          scope_kind, issuer_rp_scope, protocol_version, environment, evidence_kind,
          evidence_hash, receipt_metadata, observed_at, provenance_kind, subject_key_id,
          subject_binding_event_id, subject_binding_epoch, provider_configuration_kind,
          provider_configuration_ref, provider_configuration_version
        ) VALUES ($1, $2, $3, $4, $5, $6, 'issuer_rp_scope', $7, $8, $9, $10, $11,
          '{}'::jsonb, $12, 'proof_session', $13, $14, 1, 'dynamic', 'test-config', '1')`,
        [
          "receipt-wrong-provider",
          "session-a",
          "user-a",
          "other.fake",
          "test.fake",
          "document",
          "pirate.example",
          "fake-v2",
          "test",
          "document",
          "a".repeat(64),
          now,
          "subject-a",
          "binding-event-a",
        ],
      );
      await admin.query({
        text: `INSERT INTO evidence_receipts (
          evidence_receipt_id, proof_session_id, user_id, provider_id, issuer, method,
          scope_kind, issuer_rp_scope, protocol_version, environment, evidence_kind,
          evidence_hash, receipt_metadata, observed_at, provenance_kind, subject_key_id,
          subject_binding_event_id, subject_binding_epoch, provider_configuration_kind,
          provider_configuration_ref, provider_configuration_version
        ) VALUES ($1, $2, $3, $4, $5, $6, 'issuer_rp_scope', $7, $8, $9, $10, $11,
          '{}'::jsonb, $12, 'proof_session', $13, $14, 1, 'dynamic', 'test-config', '1')`,
        values: [
          "receipt-a",
          "session-a",
          "user-a",
          "test.fake",
          "test.fake",
          "document",
          "pirate.example",
          "fake-v2",
          "test",
          "document",
          evidenceHash,
          now,
          "subject-a",
          "binding-event-a",
        ],
      });
      await expectPostgresFailure(
        admin,
        "23514",
        `INSERT INTO evidence_receipts (
          evidence_receipt_id, proof_session_id, user_id, provider_id, issuer, method,
          scope_kind, issuer_rp_scope, protocol_version, environment, evidence_kind,
          evidence_hash, receipt_metadata, observed_at, provenance_kind,
          provider_configuration_kind, provider_configuration_ref, provider_configuration_version
        ) VALUES ('receipt-wrong-configuration', 'session-a', 'user-a', 'test.fake',
          'test.fake', 'document', 'issuer_rp_scope', 'pirate.example', 'fake-v2', 'test',
          'document', $1, '{}'::jsonb, $2, 'proof_session', 'dynamic', 'other-config', '1')`,
        ["b".repeat(64), now],
      );
      await admin.query({
        text: `INSERT INTO assertion_bindings (
          binding_group_id, user_id, binding_mode, subject_key_id,
          subject_binding_event_id, subject_binding_epoch
        ) VALUES
          ($1, $2, 'same_subject', $3, $4, 1),
          ($5, $2, 'same_subject', $6, $7, 1)`,
        values: [
          "binding-a",
          "user-a",
          "subject-a",
          "binding-event-a",
          "binding-b",
          "subject-b",
          "binding-event-b",
        ],
      });
      await admin.query({
        text: `INSERT INTO assertions (
          assertion_id, binding_group_id, evidence_receipt_id, subject_key_id, user_id,
          claim_id, assertion_value, assurance, observed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
        values: [
          "assertion-a",
          "binding-a",
          "receipt-a",
          "subject-a",
          "user-a",
          "credential.subject_unique",
          JSON.stringify({ subject_unique: true }),
          "document_zk",
          now,
        ],
      });
      await expectPostgresFailure(
        admin,
        "23514",
        `INSERT INTO assertions (
          assertion_id, binding_group_id, evidence_receipt_id, subject_key_id, user_id,
          claim_id, assertion_value, assurance, observed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb, $7, $8)`,
        [
          "assertion-wrong-anchor",
          "binding-b",
          "receipt-a",
          "subject-a",
          "user-a",
          "document.valid",
          "document_zk",
          now,
        ],
      );
      await expectPostgresFailure(
        admin,
        "23514",
        "UPDATE assertions SET assurance = $1 WHERE assertion_id = $2",
        ["provider_attested", "assertion-a"],
      );

      const completionHash = "d".repeat(64);
      await expectPostgresFailure(
        admin,
        "23514",
        `UPDATE proof_sessions
          SET status = 'completed', completion_idempotency_key = $1,
              completion_result_hash = $2, terminal_at = $3, completed_at = $3,
              updated_at = $3
          WHERE proof_session_id = 'session-a'`,
        ["complete-session-a", completionHash, now],
      );
      await admin.query("BEGIN");
      await admin.query({
        text: `UPDATE proof_sessions
          SET status = 'completed', completion_idempotency_key = $1,
              completion_result_hash = $2, terminal_at = $3, completed_at = $3,
              updated_at = $3
          WHERE proof_session_id = 'session-a'`,
        values: ["complete-session-a", completionHash, now],
      });
      await admin.query({
        text: `INSERT INTO proof_session_completion_events (
          completion_event_id, proof_session_id, actor_id, idempotency_key,
          terminal_status, result_hash, terminal_at
        ) VALUES ('completion-a', 'session-a', 'user-a', $1, 'completed', $2, $3)`,
        values: ["complete-session-a", completionHash, now],
      });
      await admin.query("COMMIT");
      await expectPostgresFailure(
        admin,
        "23505",
        `INSERT INTO proof_session_completion_events (
          completion_event_id, proof_session_id, actor_id, idempotency_key,
          terminal_status, result_hash, terminal_at
        ) VALUES ('completion-replay', 'session-a', 'user-a', $1, 'completed', $2, $3)`,
        ["complete-session-a", completionHash, now],
      );
      await expectPostgresFailure(
        admin,
        "23514",
        "UPDATE proof_sessions SET status = 'failed' WHERE proof_session_id = 'session-a'",
        [],
      );

      await admin.query({
        text: `INSERT INTO reward_uniqueness_authorities (
          campaign_id, issuer, method, scope_kind, issuer_rp_scope
        ) VALUES ('campaign-a', 'test.fake', 'document', 'issuer_rp_scope', 'pirate.example'),
          ('campaign-b', 'test.fake', 'document', 'issuer_rp_scope', 'pirate.example')`,
      });
      await admin.query({
        text: `INSERT INTO reward_subject_consumptions (
          reward_subject_consumption_id, campaign_id, subject_key_id, user_id,
          binding_event_id, binding_epoch, evidence_receipt_id
        ) VALUES ('reward-a', 'campaign-a', 'subject-a', 'user-a',
          'binding-event-a', 1, 'receipt-a')`,
      });
      await admin.query({
        text: `INSERT INTO proof_sessions (
          proof_session_id, actor_id, intent_id, request_hash, provider_id, method, issuer,
          scope_kind, issuer_rp_scope, request_mode, protocol_version, environment, status,
          requested_requirements, requested_claim_ids, subject_binding_intent, started_at,
          expires_at, provider_configuration_kind, provider_configuration_ref,
          provider_configuration_version
        ) VALUES ('session-ordinary', 'user-b', 'intent-ordinary', $1, 'test.fake',
          'document', 'test.fake', 'issuer_rp_scope', 'pirate.example', 'dynamic', 'fake-v2', 'test',
          'pending', '[{"claim_id":"document.valid"}]'::jsonb,
          '["document.valid"]'::jsonb, 'establish', $2, $3, 'dynamic', 'test-config', '1')`,
        values: ["c".repeat(64), now, later],
      });
      await expectPostgresFailure(
        admin,
        "23514",
        `INSERT INTO subject_key_binding_events (
          binding_event_id, subject_key_id, binding_epoch, user_id, proof_session_id,
          binding_kind, previous_binding_event_id, idempotency_key, bound_at
        ) VALUES ('binding-event-unauthorized', 'subject-a', 2, 'user-b', 'session-ordinary',
          'recovery', 'binding-event-a', 'unauthorized-recovery', $1)`,
        [now],
      );
      await admin.query({
        text: `INSERT INTO proof_sessions (
          proof_session_id, actor_id, intent_id, request_hash, provider_id, method, issuer,
          scope_kind, issuer_rp_scope, request_mode, protocol_version, environment, status,
          requested_requirements, requested_claim_ids, subject_binding_intent, started_at,
          expires_at, provider_configuration_kind, provider_configuration_ref,
          provider_configuration_version
        ) VALUES ('session-recovery', 'user-b', 'intent-recovery', $1, 'test.fake',
          'document', 'test.fake', 'issuer_rp_scope', 'pirate.example', 'dynamic', 'fake-v2', 'test',
          'pending', '[{"claim_id":"document.valid"}]'::jsonb,
          '["document.valid"]'::jsonb, 'recover', $2, $3, 'dynamic', 'test-config', '1')`,
        values: ["e".repeat(64), now, later],
      });
      await admin.query({
        text: `INSERT INTO subject_key_binding_events (
          binding_event_id, subject_key_id, binding_epoch, user_id, proof_session_id,
          binding_kind, previous_binding_event_id, idempotency_key, bound_at
        ) VALUES ('binding-event-recovery', 'subject-a', 2, 'user-b', 'session-recovery',
          'recovery', 'binding-event-a', 'recover-subject-a', $1)`,
        values: [now],
      });
      expect(
        (
          await admin.query<{ user_id: string; binding_epoch: string }>(
            "SELECT user_id, binding_epoch::text FROM active_subject_key_bindings WHERE subject_key_id = 'subject-a'",
          )
        ).rows[0],
      ).toEqual({ user_id: "user-b", binding_epoch: "2" });
      await expectPostgresFailure(
        admin,
        "23514",
        "UPDATE active_subject_key_bindings SET user_id = 'user-a' WHERE subject_key_id = 'subject-a'",
        [],
      );
      await expectPostgresFailure(
        admin,
        "23505",
        `INSERT INTO evidence_receipts (
          evidence_receipt_id, proof_session_id, user_id, provider_id, issuer, method,
          scope_kind, issuer_rp_scope, protocol_version, environment, evidence_kind,
          evidence_hash, receipt_metadata, observed_at, provenance_kind, subject_key_id,
          subject_binding_event_id, subject_binding_epoch, provider_configuration_kind,
          provider_configuration_ref, provider_configuration_version
        ) VALUES ('receipt-provider-replay', 'session-recovery', 'user-b', 'test.fake',
          'test.fake', 'document', 'issuer_rp_scope', 'pirate.example', 'fake-v2', 'test',
          'document', $1, '{}'::jsonb, $2, 'proof_session', 'subject-a',
          'binding-event-recovery', 2, 'dynamic', 'test-config', '1')`,
        [evidenceHash, now],
      );
      await expectPostgresFailure(
        admin,
        "23505",
        `INSERT INTO reward_subject_consumptions (
          reward_subject_consumption_id, campaign_id, subject_key_id, user_id,
          binding_event_id, binding_epoch
        ) VALUES ('reward-rebound', 'campaign-a', 'subject-a', 'user-b',
          'binding-event-recovery', 2)`,
        [],
      );
      await admin.query({
        text: `INSERT INTO reward_subject_consumptions (
          reward_subject_consumption_id, campaign_id, subject_key_id, user_id,
          binding_event_id, binding_epoch
        ) VALUES ('reward-other-campaign', 'campaign-b', 'subject-a', 'user-b',
          'binding-event-recovery', 2)`,
      });

      const inventoryResponseHash = "b".repeat(64);
      for (const tokenId of ["1", "2"]) {
        const assetId = `eip155:137/erc721:0x0000000000000000000000000000000000000001/${tokenId}`;
        await admin.query({
          text: `INSERT INTO observations (
            observation_id, user_id, resolver_id, source_id, claim_id, observation_kind,
            subject_ref, observation_value, chain_id, account_caip10, asset_caip19,
            aggregation_mode, trust_mode, completeness, snapshot_ref, source_response_hash,
            descriptor_version, observed_at
          ) VALUES ($1, 'user-a', 'courtyard', 'inventory-response-1', 'asset.ownership',
            'asset_inventory', 'wallet-a', $3::jsonb, 'eip155:137',
            'eip155:137:0x000000000000000000000000000000000000000a', $2, 'any_wallet',
            'provider_asserted', 'complete',
            '{"kind":"provider_snapshot","reference":"inventory-response-1"}'::jsonb,
            $4, '1', $5)`,
          values: [
            `observation-${tokenId}`,
            assetId,
            JSON.stringify({
              kind: "asset_inventory",
              chain_id: "eip155:137",
              account_id: "eip155:137:0x000000000000000000000000000000000000000a",
              asset_id: assetId,
              quantity: "1",
              descriptor: {
                kind: "token",
                schema_version: "1",
                chain_id: "eip155:137",
                asset_id: assetId,
                contract_address: "0x0000000000000000000000000000000000000001",
                token_id: tokenId,
                normalized_match: `courtyard-token-${tokenId}`,
                match_semantics: "exact",
              },
            }),
            inventoryResponseHash,
            now,
          ],
        });
      }
      await expectPostgresFailure(
        admin,
        "23514",
        `INSERT INTO observations (
          observation_id, user_id, resolver_id, source_id, claim_id, observation_kind,
          subject_ref, observation_value, chain_id, aggregation_mode, trust_mode, completeness,
          snapshot_ref, source_response_hash, descriptor_version, observed_at
        ) VALUES ('observation-invalid', 'user-a', 'predicate', 'response-2',
          'disclosed.predicate', 'disclosed_predicate', 'user-a', $1::jsonb, 'eip155:137',
          'single_wallet', 'provider_asserted', 'complete', $2::jsonb, $3, '1', $4)`,
        [
          JSON.stringify({ kind: "disclosed_predicate", predicate: "eligible", value: true }),
          JSON.stringify({ kind: "provider_snapshot", reference: "response-2" }),
          "c".repeat(64),
          now,
        ],
      );
      await expectPostgresFailure(
        admin,
        "23514",
        "UPDATE observations SET completeness = 'partial' WHERE observation_id = $1",
        ["observation-1"],
      );

      await expectPostgresFailure(
        admin,
        "23514",
        `INSERT INTO policy_versions (
          policy_version_id, community_id, policy_key, revision, policy_hash, policy,
          compiled_plan, compiler_version, uniqueness_model, policy_purpose,
          created_by_user_id, published_at
        ) VALUES ('policy-reward-unlinked', 'community-a', 'reward-unlinked', 1, $1,
          '{}'::jsonb, '{}'::jsonb, 'v2', '{}'::jsonb, 'reward', 'user-a', $2)`,
        ["0".repeat(64), now],
      );
      await expectPostgresFailure(
        admin,
        "23503",
        `INSERT INTO policy_versions (
          policy_version_id, community_id, policy_key, revision, policy_hash, policy,
          compiled_plan, compiler_version, uniqueness_model, policy_purpose,
          uniqueness_authority_id, created_by_user_id, published_at
        ) VALUES ('policy-reward-missing-authority', 'community-a', 'reward-missing', 1, $1,
          '{}'::jsonb, '{}'::jsonb, 'v2', $2::jsonb, 'reward', 'campaign-missing',
          'user-a', $3)`,
        [
          "1".repeat(64),
          JSON.stringify({ kind: "single_authority", authority_id: "campaign-missing" }),
          now,
        ],
      );
      const policyRows = [
        ["policy-access-v2", "access", "5".repeat(64), "access", { kind: "none" }, null],
        [
          "policy-reward-v2",
          "reward",
          "6".repeat(64),
          "reward",
          { kind: "single_authority", authority_id: "campaign-a" },
          "campaign-a",
        ],
      ] as const;
      for (const [
        policyVersionId,
        policyKey,
        policyHash,
        policyPurpose,
        uniquenessModel,
        authorityId,
      ] of policyRows) {
        await admin.query({
          text: `INSERT INTO policy_versions (
            policy_version_id, community_id, policy_key, revision, policy_hash, policy,
            compiled_plan, compiler_version, uniqueness_model, policy_purpose,
            uniqueness_authority_id, created_by_user_id, published_at
          ) VALUES ($1, 'community-a', $2, 1, $3, '{}'::jsonb, '{}'::jsonb, 'v2',
            $4::jsonb, $5, $6, 'user-a', $7)`,
          values: [
            policyVersionId,
            policyKey,
            policyHash,
            JSON.stringify(uniquenessModel),
            policyPurpose,
            authorityId,
            now,
          ],
        });
        await admin.query({
          text: `INSERT INTO community_policy_current (
            community_id, policy_key, policy_version_id, activated_at
          ) VALUES ('community-a', $1, $2, $3)`,
          values: [policyKey, policyVersionId, now],
        });
      }
      expect(
        (
          await admin.query<{ count: string }>(
            "SELECT count(*) FROM community_policy_current WHERE community_id = 'community-a'",
          )
        ).rows[0]?.count,
      ).toBe("2");
      await expectPostgresFailure(
        admin,
        "23503",
        `INSERT INTO decision_records (
          decision_record_id, community_id, user_id, policy_version_id, policy_hash,
          evaluation_mode, outcome, winning_witness
        ) VALUES ($1, 'community-a', 'user-a', $2, $3, 'enforce', 'pass', '["open"]'::jsonb)`,
        ["decision-wrong-hash", "policy-access-v2", "6".repeat(64)],
      );
      await admin.query({
        text: `INSERT INTO decision_records (
          decision_record_id, community_id, user_id, policy_version_id, policy_hash,
          evaluation_mode, outcome, winning_witness, request_id
        ) VALUES ('decision-a', 'community-a', 'user-a', 'policy-access-v2', $1,
          'enforce', 'pass', '["assertion-a"]'::jsonb, 'decision-request-a')`,
        values: ["5".repeat(64)],
      });
      await expectPostgresFailure(
        admin,
        "23505",
        `INSERT INTO decision_records (
          decision_record_id, community_id, user_id, policy_version_id, policy_hash,
          evaluation_mode, outcome, winning_witness, request_id
        ) VALUES ('decision-replay', 'community-a', 'user-a', 'policy-access-v2', $1,
          'enforce', 'pass', '["assertion-a"]'::jsonb, 'decision-request-a')`,
        ["5".repeat(64)],
      );

      for (const [intentId, payloadHash] of [
        ["action-intent-a", "7".repeat(64)],
        ["action-intent-b", "8".repeat(64)],
      ] as const) {
        await admin.query({
          text: `INSERT INTO action_intents (
            action_intent_id, user_id, community_id, action_kind, action_scope,
            action_payload_hash, intent_binding_hash, idempotency_key, status, expires_at
          ) VALUES ($1, 'user-a', 'community-a', 'create_post', 'community-a', $2, $3,
            $1, 'open', $4)`,
          values: [intentId, payloadHash, "9".repeat(64), later],
        });
      }
      await expectPostgresFailure(
        admin,
        "23505",
        `INSERT INTO action_intents (
          action_intent_id, user_id, community_id, action_kind, action_scope,
          action_payload_hash, intent_binding_hash, idempotency_key, status, expires_at
        ) VALUES ('action-intent-replay', 'user-a', 'community-a', 'create_post',
          'community-a', $1, $2, 'action-intent-a', 'open', $3)`,
        ["7".repeat(64), "9".repeat(64), later],
      );
      await admin.query({
        text: `INSERT INTO action_challenges (
          action_challenge_id, action_intent_id, provider_id, challenge_hash, status,
          issued_at, expires_at
        ) VALUES ('challenge-a', 'action-intent-a', 'altcha', $1, 'verified', $2, $3),
          ('challenge-b', 'action-intent-b', 'altcha', $4, 'verified', $2, $3)`,
        values: ["a".repeat(64), now, later, "b".repeat(64)],
      });
      await expectPostgresFailure(
        admin,
        "23503",
        `INSERT INTO action_grants (
          action_grant_id, action_intent_id, action_challenge_id, user_id, provider_id,
          action_kind, action_scope, action_payload_hash, grant_nonce, signed_grant,
          signer_key_id, issued_at, expires_at
        ) VALUES ('grant-wrong', 'action-intent-a', 'challenge-b', 'user-a', 'altcha',
          'create_post', 'community-a', $1, 'nonce-wrong', 'signed', 'key-1', $2, $3)`,
        ["7".repeat(64), now, later],
      );
      await admin.query({
        text: `INSERT INTO action_grants (
          action_grant_id, action_intent_id, action_challenge_id, user_id, provider_id,
          action_kind, action_scope, action_payload_hash, grant_nonce, signed_grant,
          signer_key_id, issued_at, expires_at
        ) VALUES ('grant-a', 'action-intent-a', 'challenge-a', 'user-a', 'altcha',
          'create_post', 'community-a', $1, 'nonce-a', 'signed', 'key-1', $2, $3)`,
        values: ["7".repeat(64), now, later],
      });
      await expectPostgresFailure(
        admin,
        "23505",
        `INSERT INTO action_grants (
          action_grant_id, action_intent_id, action_challenge_id, user_id, provider_id,
          action_kind, action_scope, action_payload_hash, grant_nonce, signed_grant,
          signer_key_id, issued_at, expires_at
        ) VALUES ('grant-duplicate-nonce', 'action-intent-b', 'challenge-b', 'user-a',
          'altcha', 'create_post', 'community-a', $1, 'nonce-a', 'signed', 'key-1', $2, $3)`,
        ["8".repeat(64), now, later],
      );
      await expectPostgresFailure(
        admin,
        "23503",
        `INSERT INTO used_action_grants (
          grant_nonce, action_grant_id, action_intent_id, action_kind, action_scope,
          action_payload_hash, action_result_ref
        ) VALUES ('nonce-a', 'grant-a', 'action-intent-a', 'create_post', 'other-community',
          $1, 'post-a')`,
        ["7".repeat(64)],
      );
      await admin.query({
        text: `INSERT INTO action_grants (
          action_grant_id, action_intent_id, action_challenge_id, user_id, provider_id,
          action_kind, action_scope, action_payload_hash, grant_nonce, signed_grant,
          signer_key_id, issued_at, expires_at
        ) VALUES ('grant-b', 'action-intent-b', 'challenge-b', 'user-a', 'altcha',
          'create_post', 'community-a', $1, 'nonce-b', 'signed', 'key-1', $2, $3)`,
        values: ["8".repeat(64), now, later],
      });
      await admin.query({
        text: `INSERT INTO posts (
          community_id, post_id, author_user_id, body, created_at, updated_at
        ) VALUES ('community-a', 'post-existing', 'user-a', 'existing', $1, $1)`,
        values: [now],
      });
      await admin.query("BEGIN");
      try {
        await admin.query({
          text: `INSERT INTO used_action_grants (
            grant_nonce, action_grant_id, action_intent_id, action_kind, action_scope,
            action_payload_hash, action_result_ref
          ) VALUES ('nonce-b', 'grant-b', 'action-intent-b', 'create_post', 'community-a',
            $1, 'post-existing')`,
          values: ["8".repeat(64)],
        });
        await admin.query({
          text: `INSERT INTO posts (
            community_id, post_id, author_user_id, body, created_at, updated_at
          ) VALUES ('community-a', 'post-existing', 'user-a', 'duplicate', $1, $1)`,
          values: [now],
        });
        throw new Error("expected protected action write to fail");
      } catch (error) {
        expect(error).toMatchObject({ code: "23505" });
        await admin.query("ROLLBACK");
      }
      expect(
        (
          await admin.query<{ count: string }>(
            "SELECT count(*) FROM used_action_grants WHERE grant_nonce = 'nonce-b'",
          )
        ).rows[0]?.count,
      ).toBe("0");
      await admin.query({
        text: `INSERT INTO used_action_grants (
          grant_nonce, action_grant_id, action_intent_id, action_kind, action_scope,
          action_payload_hash, action_result_ref
        ) VALUES ('nonce-a', 'grant-a', 'action-intent-a', 'create_post', 'community-a',
          $1, 'post-a')`,
        values: ["7".repeat(64)],
      });
      await expectPostgresFailure(
        admin,
        "23505",
        `INSERT INTO used_action_grants (
          grant_nonce, action_grant_id, action_intent_id, action_kind, action_scope,
          action_payload_hash, action_result_ref
        ) VALUES ('nonce-a', 'grant-a', 'action-intent-a', 'create_post', 'community-a',
          $1, 'post-replay')`,
        ["7".repeat(64)],
      );
    });
    completedTestCount += 1;
  });

  test("enforces provider configuration provenance and append-only presentations", async () => {
    await withSchema(async (admin, scopedConnectionString) => {
      await applyMigrations(scopedConnectionString, migrations);
      const now = new Date("2026-08-17T00:00:00.000Z");
      const later = new Date("2026-08-18T00:00:00.000Z");

      await admin.query("INSERT INTO users (user_id) VALUES ('user-a')");

      const insertSession = async (
        id: string,
        requestMode: "curated" | "dynamic",
        configurationKind: "managed" | "dynamic",
        configurationRef: string,
        configurationVersion: string,
      ) => {
        await admin.query({
          text: `INSERT INTO proof_sessions (
            proof_session_id, actor_id, intent_id, request_hash, provider_id, method, issuer,
            scope_kind, issuer_rp_scope, request_mode, protocol_version, environment, status,
            requested_requirements, requested_claim_ids, subject_binding_intent, started_at,
            expires_at, provider_configuration_kind, provider_configuration_ref,
            provider_configuration_version
          ) VALUES ($1, 'user-a', $2, $3, 'test.fake', 'document', 'test.fake',
            'issuer_rp_scope', 'pirate.example', $4, 'fake-v2', 'test', 'pending',
            '[{"claim_id":"document.valid"}]'::jsonb, '["document.valid"]'::jsonb,
            'none', $5, $6, $7, $8, $9)`,
          values: [
            id,
            `intent-${id}`,
            "a".repeat(64),
            requestMode,
            now,
            later,
            configurationKind,
            configurationRef,
            configurationVersion,
          ],
        });
      };

      await insertSession("session-dynamic", "dynamic", "dynamic", "dynamic-config", "v1");
      await insertSession("session-curated", "curated", "managed", "managed-config", "v2");

      await expectPostgresFailure(
        admin,
        "23514",
        `INSERT INTO proof_sessions (
          proof_session_id, actor_id, intent_id, request_hash, provider_id, method, issuer,
          scope_kind, issuer_rp_scope, request_mode, protocol_version, environment, status,
          requested_requirements, requested_claim_ids, subject_binding_intent, started_at,
          expires_at, provider_configuration_kind, provider_configuration_ref,
          provider_configuration_version
        ) VALUES ('session-curated-wrong-kind', 'user-a', 'intent-curated-wrong-kind', $1,
          'test.fake', 'document', 'test.fake', 'issuer_rp_scope', 'pirate.example', 'curated',
          'fake-v2', 'test', 'pending', '[{"claim_id":"document.valid"}]'::jsonb,
          '["document.valid"]'::jsonb, 'none', $2, $3, 'dynamic', 'config', 'v1')`,
        ["1".repeat(64), now, later],
      );
      await expectPostgresFailure(
        admin,
        "23514",
        `INSERT INTO proof_sessions (
          proof_session_id, actor_id, intent_id, request_hash, provider_id, method, issuer,
          scope_kind, issuer_rp_scope, request_mode, protocol_version, environment, status,
          requested_requirements, requested_claim_ids, subject_binding_intent, started_at,
          expires_at, provider_configuration_kind, provider_configuration_ref,
          provider_configuration_version
        ) VALUES ('session-dynamic-wrong-kind', 'user-a', 'intent-dynamic-wrong-kind', $1,
          'test.fake', 'document', 'test.fake', 'issuer_rp_scope', 'pirate.example', 'dynamic',
          'fake-v2', 'test', 'pending', '[{"claim_id":"document.valid"}]'::jsonb,
          '["document.valid"]'::jsonb, 'none', $2, $3, 'managed', 'config', 'v1')`,
        ["2".repeat(64), now, later],
      );
      await expectPostgresFailure(
        admin,
        "23514",
        "UPDATE proof_sessions SET provider_configuration_ref = ' changed' WHERE proof_session_id = 'session-dynamic'",
        [],
      );
      await expectPostgresFailure(
        admin,
        "23514",
        "UPDATE proof_sessions SET provider_configuration_version = 'v2' WHERE proof_session_id = 'session-dynamic'",
        [],
      );
      await expectPostgresFailure(
        admin,
        "23514",
        "UPDATE proof_sessions SET provider_configuration_kind = 'managed' WHERE proof_session_id = 'session-dynamic'",
        [],
      );
      await expectPostgresFailure(
        admin,
        "23514",
        `INSERT INTO proof_sessions (
          proof_session_id, actor_id, intent_id, request_hash, provider_id, method, issuer,
          scope_kind, issuer_rp_scope, request_mode, protocol_version, environment, status,
          requested_requirements, requested_claim_ids, subject_binding_intent, started_at,
          expires_at, provider_configuration_kind, provider_configuration_ref,
          provider_configuration_version
        ) VALUES ('session-whitespace-version', 'user-a', 'intent-whitespace-version', $1,
          'test.fake', 'document', 'test.fake', 'issuer_rp_scope', 'pirate.example', 'dynamic',
          'fake-v2', 'test', 'pending', '[{"claim_id":"document.valid"}]'::jsonb,
          '["document.valid"]'::jsonb, 'none', $2, $3, 'dynamic', 'config', 'v1 ')`,
        ["3".repeat(64), now, later],
      );

      await admin.query({
        text: `INSERT INTO proof_session_presentations (
          proof_session_id, presentation_kind, payload
        ) VALUES ('session-dynamic', 'redirect', '{"url":"https://example.test/callback"}'::jsonb)`,
      });
      await expectPostgresFailure(
        admin,
        "23514",
        "UPDATE proof_session_presentations SET payload = '{}'::jsonb WHERE proof_session_id = 'session-dynamic'",
        [],
      );
      await expectPostgresFailure(
        admin,
        "23514",
        "DELETE FROM proof_session_presentations WHERE proof_session_id = 'session-dynamic'",
        [],
      );
      await expectPostgresFailure(
        admin,
        "23514",
        `INSERT INTO proof_session_presentations (
          proof_session_id, presentation_kind, payload
        ) VALUES ('session-curated', 'unsupported', '{}'::jsonb)`,
        [],
      );
      await expectPostgresFailure(
        admin,
        "23514",
        `INSERT INTO proof_session_presentations (
          proof_session_id, presentation_kind, payload
        ) VALUES ('session-curated', 'poll', '[]'::jsonb)`,
        [],
      );
      await expectPostgresFailure(
        admin,
        "23503",
        `INSERT INTO proof_session_presentations (
          proof_session_id, presentation_kind, payload
        ) VALUES ('session-missing', 'none', '{}'::jsonb)`,
        [],
      );
    });
    completedTestCount += 1;
  });

  test("rejects duplicate, out-of-order, and checksum-mismatched migrations", async () => {
    await withSchema(async (_admin, scopedConnectionString) => {
      const duplicate = await applyMigrations(scopedConnectionString, [migration, migration]).catch(
        (error) => error,
      );
      expect(duplicate).toBeInstanceOf(MigrationDefinitionInvalid);
      expect(duplicate).toMatchObject({ reason: "duplicate" });

      const outOfOrder = await applyMigrations(scopedConnectionString, [
        { ...migration, version: "0002_out_of_order.sql" },
        { ...migration, version: "0001_out_of_order.sql" },
      ]).catch((error) => error);
      expect(outOfOrder).toBeInstanceOf(MigrationDefinitionInvalid);
      expect(outOfOrder).toMatchObject({ reason: "out-of-order" });

      await applyMigrations(scopedConnectionString, [migration]);
      const mismatch = await applyMigrations(scopedConnectionString, [
        { ...migration, checksum: "0".repeat(64) },
      ]).catch((error) => error);
      expect(mismatch).toBeInstanceOf(MigrationLedgerMismatch);
      expect(mismatch).toMatchObject({ version: migration.version });

      const secondMigration = { ...migration, version: "0002_follow-up.sql" };
      await withSchema(async (_admin, secondScopedConnectionString) => {
        await applyMigrations(secondScopedConnectionString, [secondMigration]);
        const gap = await applyMigrations(secondScopedConnectionString, [
          migration,
          secondMigration,
        ]).catch((error) => error);
        expect(gap).toBeInstanceOf(MigrationLedgerMismatch);
        expect(gap).toMatchObject({
          reason: "not-prefix",
          version: migration.version,
          expectedVersion: migration.version,
          actualVersion: secondMigration.version,
        });
      });

      await withSchema(async (_admin, secondScopedConnectionString) => {
        await applyMigrations(secondScopedConnectionString, [identityMigration]);
        const gap = await applyMigrations(secondScopedConnectionString, migrations).catch(
          (error) => error,
        );
        expect(gap).toBeInstanceOf(MigrationLedgerMismatch);
        expect(gap).toMatchObject({
          reason: "not-prefix",
          version: migration.version,
          expectedVersion: migration.version,
          actualVersion: identityMigration.version,
        });
      });
    });
    completedTestCount += 1;
  });

  test("rejects cross-community post, comment, and vote references", async () => {
    await withSchema(async (admin, scopedConnectionString) => {
      await applyMigrations(scopedConnectionString, migrations);
      const now = new Date();
      await admin.query({
        text: "INSERT INTO communities (community_id, display_name, created_by_user_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $4), ($5, $6, $7, $4, $4)",
        values: ["community-a", "A", "user-a", now, "community-b", "B", "user-b"],
      });
      await admin.query({
        text: "INSERT INTO posts (community_id, post_id, author_user_id, body, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5)",
        values: ["community-a", "post-a", "user-a", "post", now],
      });

      await expectForeignKeyFailure(
        admin,
        "INSERT INTO comments (community_id, comment_id, post_id, body, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5)",
        ["community-b", "comment-b", "post-a", "comment", now],
      );
      await expectForeignKeyFailure(
        admin,
        "INSERT INTO post_votes (community_id, post_vote_id, post_id, user_id, vote_value, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $6)",
        ["community-b", "vote-b", "post-a", "user-b", 1, now],
      );
    });
    completedTestCount += 1;
  });

  test("scopes repository reads, updates, and deletes by community", async () => {
    await withSchema(async (admin, scopedConnectionString) => {
      await applyMigrations(scopedConnectionString, migrations);
      const now = new Date();
      await admin.query({
        text: "INSERT INTO communities (community_id, display_name, created_by_user_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $4), ($5, $6, $7, $4, $4)",
        values: ["community-a", "A", "user-a", now, "community-b", "B", "user-b"],
      });
      await admin.query({
        text: "INSERT INTO posts (community_id, post_id, author_user_id, body, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5), ($6, $7, $8, $9, $5, $5)",
        values: [
          "community-a",
          "post-a",
          "user-a",
          "community A",
          now,
          "community-b",
          "post-b",
          "user-b",
          "community B",
        ],
      });

      const readPost = async (communityId: string, postId: string) =>
        (
          await admin.query<{ readonly body: string }>({
            text: "SELECT body FROM posts WHERE community_id = $1 AND post_id = $2",
            values: [communityId, postId],
          })
        ).rows;

      expect(await readPost("community-a", "post-b")).toEqual([]);
      expect(await readPost("community-b", "post-b")).toEqual([{ body: "community B" }]);

      const wrongUpdate = await admin.query({
        text: "UPDATE posts SET body = $1, updated_at = $2 WHERE community_id = $3 AND post_id = $4",
        values: ["cross-tenant update", now, "community-a", "post-b"],
      });
      expect(wrongUpdate.rowCount).toBe(0);

      const wrongDelete = await admin.query({
        text: "DELETE FROM posts WHERE community_id = $1 AND post_id = $2",
        values: ["community-a", "post-b"],
      });
      expect(wrongDelete.rowCount).toBe(0);
      expect(await readPost("community-b", "post-b")).toEqual([{ body: "community B" }]);

      const ownUpdate = await admin.query({
        text: "UPDATE posts SET body = $1, updated_at = $2 WHERE community_id = $3 AND post_id = $4",
        values: ["updated A", now, "community-a", "post-a"],
      });
      expect(ownUpdate.rowCount).toBe(1);
      const ownDelete = await admin.query({
        text: "DELETE FROM posts WHERE community_id = $1 AND post_id = $2",
        values: ["community-a", "post-a"],
      });
      expect(ownDelete.rowCount).toBe(1);
      expect(await readPost("community-a", "post-a")).toEqual([]);
      expect(await readPost("community-b", "post-b")).toEqual([{ body: "community B" }]);
    });
    completedTestCount += 1;
  });

  afterAll(async () => {
    if (connectionString !== undefined && completedTestCount === foundationTestCount) {
      await Bun.write(sentinelPath, sentinelContents);
    }
  });
});
