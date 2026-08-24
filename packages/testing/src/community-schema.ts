import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export type CommunitySqliteDatabase = Database;

export type CommunityMigrationFixture = {
  readonly name: string;
  readonly path: string;
  readonly checksum: string;
  readonly sql: string;
};

type ChecksumsManifest = {
  readonly algorithm: "sha256";
  readonly migrations: Readonly<Record<string, string>>;
};

const COMMUNITY_MIGRATION_NAME_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/;

const HISTORICAL_DUPLICATE_COMMUNITY_MIGRATION_ORDINALS: Readonly<
  Record<string, readonly string[]>
> = Object.freeze({
  "1037": Object.freeze([
    "1037_community_text_localization.sql",
    "1037_rebuild_comments_guest_authorship.sql",
  ]),
  "1089": Object.freeze([
    "1089_community_assistant_text_and_voice_mode.sql",
    "1089_post_events.sql",
  ]),
  "1123": Object.freeze([
    "1123_karaoke_attempts.sql",
    "1123_song_engagement_activity_timezone.sql",
  ]),
});

export function assertCommunityMigrationOrdinalUniqueness(names: readonly string[]): void {
  const namesByOrdinal = new Map<string, string[]>();
  for (const name of names) {
    const match = COMMUNITY_MIGRATION_NAME_PATTERN.exec(name);
    if (match === null) {
      throw new Error(`Invalid community migration fixture filename: ${name}`);
    }
    const ordinal = match[1] ?? "";
    const ordinalNames = namesByOrdinal.get(ordinal) ?? [];
    ordinalNames.push(name);
    namesByOrdinal.set(ordinal, ordinalNames);
  }

  for (const [ordinal, ordinalNames] of namesByOrdinal) {
    if (ordinalNames.length < 2) continue;
    const actual = [...ordinalNames].sort();
    const historical = HISTORICAL_DUPLICATE_COMMUNITY_MIGRATION_ORDINALS[ordinal];
    if (historical === undefined || actual.join("\n") !== historical.join("\n")) {
      throw new Error(`Duplicate community migration ordinal ${ordinal}: ${actual.join(", ")}`);
    }
  }
}

function communityMigrationFixtureDirectory(): URL {
  return new URL("../../../db/community-shard/migrations/", import.meta.url);
}

function filePath(url: URL): string {
  return fileURLToPath(url as unknown as import("node:url").URL);
}

async function readChecksumsManifest(): Promise<ChecksumsManifest> {
  const manifest = JSON.parse(
    await readFile(
      filePath(new URL("checksums.json", communityMigrationFixtureDirectory())),
      "utf8",
    ),
  ) as ChecksumsManifest;
  if (manifest.algorithm !== "sha256" || manifest.migrations == null) {
    throw new Error("Invalid community migration checksum manifest");
  }
  return manifest;
}

export async function listCommunityMigrationFixtures(): Promise<CommunityMigrationFixture[]> {
  const directory = communityMigrationFixtureDirectory();
  const manifest = await readChecksumsManifest();
  const names = (await readdir(filePath(directory))).filter((name) => name.endsWith(".sql")).sort();
  const manifestNames = Object.keys(manifest.migrations).sort();
  if (names.join("\n") !== manifestNames.join("\n")) {
    throw new Error("Community migration fixture set does not match its checksum manifest");
  }
  assertCommunityMigrationOrdinalUniqueness(names);

  const fixtures: CommunityMigrationFixture[] = [];
  for (const name of names) {
    const path = new URL(name, directory);
    const sql = await readFile(filePath(path), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    if (checksum !== manifest.migrations[name]) {
      throw new Error(`Community migration checksum mismatch: ${name}`);
    }
    fixtures.push({ name, path: filePath(path), checksum, sql });
  }
  return fixtures;
}

export async function getNMinusOneCommunityMigrationName(): Promise<string> {
  const migrations = await listCommunityMigrationFixtures();
  if (migrations.length < 2) {
    throw new Error("At least two community migrations are required for N-1 schema tests");
  }
  return migrations[migrations.length - 2]?.name ?? "";
}

export async function getMigrationBeforeCommunityMigration(migrationName: string): Promise<string> {
  const migrations = await listCommunityMigrationFixtures();
  const index = migrations.findIndex((migration) => migration.name === migrationName);
  if (index <= 0) {
    throw new Error(`No previous community migration found for ${migrationName}`);
  }
  return migrations[index - 1]?.name ?? "";
}

export async function createCommunityDbThroughMigration(
  client: CommunitySqliteDatabase,
  throughMigrationName: string,
): Promise<void> {
  const migrations = await listCommunityMigrationFixtures();
  const throughIndex = migrations.findIndex((migration) => migration.name === throughMigrationName);
  if (throughIndex < 0) {
    throw new Error(`Unknown community migration fixture: ${throughMigrationName}`);
  }

  client.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      migration_name TEXT PRIMARY KEY,
      migration_label TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  for (const migration of migrations.slice(0, throughIndex + 1)) {
    client.exec(migration.sql);
    client
      .query(
        `INSERT INTO schema_migrations (migration_name, migration_label, checksum)
         VALUES (?, 'community-shard', ?)`,
      )
      .run(migration.name, migration.checksum);
  }
}

export async function createCommunityDbFromSquashedSchema(
  client: CommunitySqliteDatabase,
): Promise<void> {
  client.exec(
    await readFile(
      filePath(new URL("../../../db/community-shard/schema.sql", import.meta.url)),
      "utf8",
    ),
  );
}

export function exerciseCommunityCoreCompatibility(client: CommunitySqliteDatabase): void {
  client
    .query(
      `INSERT INTO communities (
         community_id, display_name, status, artist_governance_state,
         membership_mode, default_age_gate_policy, donation_policy_mode,
         donation_partner_status, governance_mode, created_by_user_id,
         created_at, updated_at
       ) VALUES (?, ?, 'active', 'fan_run', 'open', 'none', 'none',
         'unconfigured', 'centralized', ?, ?, ?)`,
    )
    .run("cmt_schema_probe", "Schema probe", "usr_schema_probe", "2026-08-16", "2026-08-16");
  client
    .query(
      `INSERT INTO community_memberships (
         membership_id, community_id, user_id, status, joined_at,
         left_at, banned_at, created_at, updated_at
       ) VALUES (?, ?, ?, 'member', ?, NULL, NULL, ?, ?)`,
    )
    .run(
      "mbr_schema_probe",
      "cmt_schema_probe",
      "usr_schema_probe",
      "2026-08-16",
      "2026-08-16",
      "2026-08-16",
    );
  client
    .query(
      `INSERT INTO posts (
         post_id, community_id, author_user_id, identity_mode, post_type,
         status, analysis_state, content_safety_state, age_gate_policy,
         title, body, created_at, updated_at, idempotency_key
       ) VALUES (?, ?, ?, 'public', 'text', 'published', 'allow', 'safe',
         'none', ?, ?, ?, ?, ?)`,
    )
    .run(
      "pst_schema_probe",
      "cmt_schema_probe",
      "usr_schema_probe",
      "N-1 post",
      "Schema-compatible post",
      "2026-08-16",
      "2026-08-16",
      "schema-probe-post",
    );
  client
    .query(
      `INSERT INTO post_votes (
         post_vote_id, post_id, community_id, user_id, vote_value,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(
      "pvt_schema_probe",
      "pst_schema_probe",
      "cmt_schema_probe",
      "usr_schema_probe",
      "2026-08-16",
      "2026-08-16",
    );

  const post = client
    .query("SELECT title, body, idempotency_key FROM posts WHERE post_id = ?")
    .all("pst_schema_probe") as Array<{ title: string; body: string; idempotency_key: string }>;
  if (
    post.length !== 1 ||
    post[0]?.title !== "N-1 post" ||
    post[0]?.idempotency_key !== "schema-probe-post"
  ) {
    throw new Error("Community N-1 post compatibility probe failed");
  }
  const vote = client
    .query("SELECT vote_value FROM post_votes WHERE post_id = ?")
    .all("pst_schema_probe") as Array<{ vote_value: number }>;
  if (vote.length !== 1 || vote[0]?.vote_value !== 1) {
    throw new Error("Community N-1 vote compatibility probe failed");
  }
}
