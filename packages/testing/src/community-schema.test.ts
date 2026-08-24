import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  assertCommunityMigrationOrdinalUniqueness,
  createCommunityDbFromSquashedSchema,
  createCommunityDbThroughMigration,
  exerciseCommunityCoreCompatibility,
  getNMinusOneCommunityMigrationName,
  listCommunityMigrationFixtures,
} from "./community-schema";

describe("community schema compatibility", () => {
  test("rejects new duplicate ordinals while preserving exact historical exceptions", () => {
    expect(() =>
      assertCommunityMigrationOrdinalUniqueness([
        "1037_community_text_localization.sql",
        "1037_rebuild_comments_guest_authorship.sql",
        "1089_community_assistant_text_and_voice_mode.sql",
        "1089_post_events.sql",
        "1123_karaoke_attempts.sql",
        "1123_song_engagement_activity_timezone.sql",
      ]),
    ).not.toThrow();

    expect(() =>
      assertCommunityMigrationOrdinalUniqueness([
        "1158_generic_assets_learning_foundation.sql",
        "1158_new_conflicting_migration.sql",
      ]),
    ).toThrow("Duplicate community migration ordinal 1158");
    expect(() =>
      assertCommunityMigrationOrdinalUniqueness([
        "1037_community_text_localization.sql",
        "1037_rebuild_comments_guest_authorship.sql",
        "1037_third_conflicting_migration.sql",
      ]),
    ).toThrow("Duplicate community migration ordinal 1037");
  });

  test("checksums every migration fixture and exercises core paths at N-1", async () => {
    const migrations = await listCommunityMigrationFixtures();
    const nMinusOne = await getNMinusOneCommunityMigrationName();
    const expectedMigration = migrations[migrations.length - 2];
    if (!expectedMigration) throw new Error("N-1 migration fixture is missing");
    const client = new Database(":memory:");
    try {
      await createCommunityDbThroughMigration(client, nMinusOne);
      exerciseCommunityCoreCompatibility(client);

      const applied = client
        .query("SELECT migration_name, checksum FROM schema_migrations ORDER BY rowid DESC LIMIT 1")
        .get() as { migration_name: string; checksum: string };
      expect(applied.migration_name).toBe(nMinusOne);
      expect(applied.checksum).toBe(expectedMigration.checksum);
      expect(migrations.length).toBe(160);
    } finally {
      client.close();
    }
  });

  test("the squashed baseline is executable independently of forward migrations", async () => {
    const client = new Database(":memory:");
    try {
      await createCommunityDbFromSquashedSchema(client);
      const table = client
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'communities'")
        .all() as Array<{ name: string }>;
      expect(table).toEqual([{ name: "communities" }]);
    } finally {
      client.close();
    }
  });
});
