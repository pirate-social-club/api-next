import { describe, expect, test } from "bun:test";
import { Client } from "pg";
import {
  loadPostgresMigrations,
  runPostgresMigrations,
} from "../../../scripts/postgres-migrations.ts";
import { insertActiveCommunityMembershipFixture } from "./community-follow.pg-fixture.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;

const MIGRATION_VERSION = "0110_persona_community_bindings.sql";

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function connectionForSchema(raw: string, schema: string): string {
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}

async function withSchema<A>(use: (connection: string, admin: Client) => Promise<A>): Promise<A> {
  if (connectionString === undefined) throw new Error("test URL was not configured");
  const schema = `api_next_persona_binding_migration_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2)}`;
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
  try {
    return await use(connectionForSchema(connectionString, schema), admin);
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

type Fixture = Readonly<{
  readonly accountId: string;
  readonly personaId: string;
  readonly communities: readonly string[];
}>;

/**
 * Installs pre-migration fixtures with persona/community evidence in the named
 * communities. Evidence rows are written with triggers disabled because the
 * 0110 preflight must observe historical rows exactly as a live database would
 * hold them, not as fresh repository writes produce them.
 */
async function installEvidenceFixtures(admin: Client, fixtures: readonly Fixture[]): Promise<void> {
  const communities = new Set(fixtures.flatMap(({ communities: ids }) => ids));
  await admin.query("SET session_replication_role = replica");
  try {
    await admin.query("INSERT INTO users (user_id) VALUES ('binding-observer')");
    for (const communityId of communities) {
      await admin.query(
        `INSERT INTO communities (
           community_id, display_name, status, created_by_user_id, created_at, updated_at
         ) VALUES ($1, $2, 'active', 'binding-observer', clock_timestamp(), clock_timestamp())`,
        [communityId, `Binding fixture ${communityId}`],
      );
    }
    let karaokeOrdinal = 0;
    for (const { accountId, personaId, communities: ids } of fixtures) {
      await admin.query("INSERT INTO users (user_id) VALUES ($1)", [accountId]);
      await admin.query(
        `INSERT INTO personas (
           persona_id, account_id, status, is_first_persona, created_at, retired_at
         ) VALUES ($1, $2, 'active', false, clock_timestamp(), NULL)`,
        [personaId, accountId],
      );
      for (const [index, communityId] of ids.entries()) {
        await admin.query(
          `INSERT INTO posts (
             community_id, post_id, author_user_id, author_persona_id,
             post_type, status, visibility, title, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, 'text', 'published', 'public', $5,
             clock_timestamp(), clock_timestamp())`,
          [communityId, `${personaId}-post-${index}`, accountId, personaId, "Binding fixture"],
        );
        if (index > 0) {
          karaokeOrdinal += 1;
          await admin.query(
            `INSERT INTO karaoke_sessions (
               session_id, attempt_id, account_id, persona_id, community_id, post_id,
               audio_revision, lyrics_revision, karaoke_revision_id,
               qualification_policy_version_id, idempotency_key, request_hash, timezone,
               created_at, expires_at, playback_kind, scoring_version, scoring_provider,
               scoring_model, line_snapshot, client_context
             ) VALUES ($1, $2, $3, $4, $5, $6, 1, 1, 'binding-fixture-revision',
               'binding-fixture-policy', $7, $8, 'UTC', clock_timestamp(),
               clock_timestamp() + interval '1 hour', 'full_mix', 5, 'elevenlabs',
               'scribe_v2_realtime', '[{"id":"binding-fixture-line","index":0}]'::jsonb, NULL)`,
            [
              `binding-karaoke-session-${karaokeOrdinal}`,
              `binding-karaoke-attempt-${karaokeOrdinal}`,
              accountId,
              personaId,
              communityId,
              `${personaId}-post-${index}`,
              `binding-karaoke-idempotency-${karaokeOrdinal}`,
              "0".repeat(64),
            ],
          );
        }
      }
    }
  } finally {
    await admin.query("SET session_replication_role = origin");
  }
}

suite("persona community binding PostgreSQL migration", () => {
  test("derives one binding per single-evidence persona and leaves zero-evidence personas unbound", async () => {
    await withSchema(async (connection, admin) => {
      const migrations = await loadPostgresMigrations();
      const bindingIndex = migrations.findIndex(
        (migration) => migration.version === MIGRATION_VERSION,
      );
      expect(bindingIndex).toBeGreaterThan(0);
      await runPostgresMigrations({
        connectionString: connection,
        migrations: migrations.slice(0, bindingIndex),
      });
      await installEvidenceFixtures(admin, [
        {
          accountId: "binding-account-one",
          personaId: "binding-persona-one",
          communities: ["binding-community-1"],
        },
        { accountId: "binding-account-zero", personaId: "binding-persona-zero", communities: [] },
      ]);

      const applied = await runPostgresMigrations({
        connectionString: connection,
        migrations,
      });
      if (applied.dryRun) throw new Error("expected a real migration run");
      expect(applied.result.applied).toContain(MIGRATION_VERSION);

      await expect(
        admin.query(
          `SELECT persona_id, account_id, community_id, binding_source
             FROM persona_community_bindings`,
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            persona_id: "binding-persona-one",
            account_id: "binding-account-one",
            community_id: "binding-community-1",
            binding_source: "migration_single_evidence",
          },
        ],
      });
      await expect(
        admin.query(
          "SELECT active_owned_community_persona('binding-account-one','binding-persona-one','binding-community-1') AS eligible",
        ),
      ).resolves.toMatchObject({ rows: [{ eligible: true }] });
      await expect(
        admin.query(
          "SELECT active_owned_community_persona('binding-account-one','binding-persona-one','binding-community-other') AS eligible",
        ),
      ).resolves.toMatchObject({ rows: [{ eligible: false }] });
      await expect(
        admin.query(
          "SELECT active_owned_community_persona('binding-account-zero','binding-persona-zero','binding-community-1') AS eligible",
        ),
      ).resolves.toMatchObject({ rows: [{ eligible: false }] });

      // A presentation for the bound persona is accepted; a zero-evidence
      // persona has no binding, so the composite foreign key rejects it.
      await insertActiveCommunityMembershipFixture(admin, {
        communityId: "binding-community-1",
        membershipId: "binding-membership-one",
        userId: "binding-account-one",
      });
      await expect(
        admin.query(
          `INSERT INTO persona_role_presentations (
             community_id, account_id, persona_id, created_at, updated_at
           ) VALUES ('binding-community-1','binding-account-one','binding-persona-one',
             clock_timestamp(), clock_timestamp())`,
        ),
      ).resolves.toBeDefined();
      await expect(
        admin.query(
          `INSERT INTO persona_activity_presentations (
             community_id, account_id, persona_id, created_at, updated_at
           ) VALUES ('binding-community-1','binding-account-zero','binding-persona-zero',
             clock_timestamp(), clock_timestamp())`,
        ),
      ).rejects.toThrow();

      // Bindings are immutable and a persona can never gain a second one.
      await expect(
        admin.query(
          "UPDATE persona_community_bindings SET community_id='binding-community-other' WHERE persona_id='binding-persona-one'",
        ),
      ).rejects.toThrow();
      await expect(
        admin.query(
          "DELETE FROM persona_community_bindings WHERE persona_id='binding-persona-one'",
        ),
      ).rejects.toThrow();
      await expect(
        admin.query(
          `INSERT INTO persona_community_bindings (
             persona_id, account_id, community_id, binding_source
           ) VALUES ('binding-persona-one','binding-account-one','binding-community-other','explicit_migration_resolution')`,
        ),
      ).rejects.toThrow();
      await expect(
        admin.query(
          `INSERT INTO persona_community_bindings (
             persona_id, account_id, community_id, binding_source
           ) VALUES ('binding-persona-zero','binding-account-zero','binding-community-1','first_membership')`,
        ),
      ).resolves.toBeDefined();
    });
  });

  test("aborts atomically with bounded conflict identifiers when a persona evidences multiple communities", async () => {
    await withSchema(async (connection, admin) => {
      const migrations = await loadPostgresMigrations();
      const bindingIndex = migrations.findIndex(
        (migration) => migration.version === MIGRATION_VERSION,
      );
      await runPostgresMigrations({
        connectionString: connection,
        migrations: migrations.slice(0, bindingIndex),
      });
      await installEvidenceFixtures(admin, [
        {
          accountId: "binding-account-conflict",
          personaId: "binding-persona-conflict",
          communities: ["binding-community-1", "binding-community-2"],
        },
        {
          accountId: "binding-account-clean",
          personaId: "binding-persona-clean",
          communities: ["binding-community-1"],
        },
      ]);

      const failure = await runPostgresMigrations({
        connectionString: connection,
        migrations,
      }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeDefined();

      // The typed migration runner drops the SQL diagnostic, so the bounded
      // operator evidence is asserted against the raw migration statement.
      const bindingMigration = migrations[bindingIndex];
      if (bindingMigration === undefined) throw new Error("binding migration is missing");
      await admin.query("BEGIN");
      const diagnostic = await admin.query(bindingMigration.sql).then(
        () => null,
        (error: unknown) => error,
      );
      await admin.query("ROLLBACK");
      expect(diagnostic).toBeInstanceOf(Error);
      const message = String((diagnostic as Error).message);
      expect(message).toContain("aborted");
      expect(message).toContain("binding-persona-conflict");
      expect(message).not.toContain("binding-account-conflict");

      // The abort happened before any schema or data change committed.
      await expect(
        admin.query(`SELECT count(*)::integer AS count FROM schema_migrations WHERE version = $1`, [
          MIGRATION_VERSION,
        ]),
      ).resolves.toMatchObject({ rows: [{ count: 0 }] });
      await expect(
        admin.query(
          "SELECT count(*)::integer AS count FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'persona_community_bindings'",
        ),
      ).resolves.toMatchObject({ rows: [{ count: 0 }] });
      await expect(
        admin.query(
          "SELECT count(*)::integer AS count FROM posts WHERE author_persona_id = 'binding-persona-conflict'",
        ),
      ).resolves.toMatchObject({ rows: [{ count: 2 }] });
      await expect(
        admin.query(
          "SELECT count(*)::integer AS count FROM karaoke_sessions WHERE persona_id = 'binding-persona-conflict'",
        ),
      ).resolves.toMatchObject({ rows: [{ count: 1 }] });
    });
  });
});
