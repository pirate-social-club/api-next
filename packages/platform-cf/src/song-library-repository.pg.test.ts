import { describe, expect, test } from "bun:test";
import { listPersonaSongs } from "@pirate/application/use-cases/song-library";
import { Effect } from "effect";
import { Client } from "pg";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { makeControlPlaneSongLibraryStore } from "./song-library-repository.ts";

const connection = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const suite = connection ? describe : describe.skip;

// Query integration fixture: production-shaped columns, without replaying the
// activity writers' independent lifecycle/qualification fixtures.
suite("persona song library PostgreSQL reads", () => {
  test("isolates owners, unions starts, deduplicates, filters access and ranks distinct participants", async () => {
    if (!connection) throw new Error("Missing PostgreSQL fixture URL");
    const schema = `song_library_${crypto.randomUUID().replaceAll("-", "")}`;
    const db = new Client({ connectionString: connection });
    await db.connect();
    try {
      await db.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);
      await db.query(`
        CREATE TABLE users(user_id text PRIMARY KEY, status text);
        CREATE TABLE personas(persona_id text PRIMARY KEY, account_id text, status text);
        CREATE TABLE communities(community_id text PRIMARY KEY, status text);
        CREATE TABLE posts(community_id text, post_id text, title text, author_persona_id text, status text, post_type text, visibility text, content_rating text);
        CREATE TABLE community_memberships(community_id text, user_id text, status text);
        CREATE FUNCTION public_persona_projection(text) RETURNS jsonb LANGUAGE sql AS 'SELECT jsonb_build_object(''display_name'', ''Harbor'')';
        CREATE FUNCTION can_account_view_content_rating_v1(text,text) RETURNS boolean LANGUAGE sql AS 'SELECT $2 = ''general''';
        CREATE TABLE study_sessions(account_id text, persona_id text, community_id text, post_id text, created_at timestamptz, completed_at timestamptz);
        CREATE TABLE study_sessions_v2(LIKE study_sessions, current_presented_at timestamptz);
        CREATE TABLE karaoke_sessions(LIKE study_sessions);
        CREATE TABLE dance_sessions(account_id text, persona_id text, community_id text, song_post_id text, created_at timestamptz, terminal_at timestamptz);
        INSERT INTO users VALUES ('a','active'),('b','active'),('c','active');
        INSERT INTO personas VALUES ('pa','a','active'),('pa2','a','active'),('pb','b','active'),('pc','c','active');
        INSERT INTO communities VALUES ('crew','active');
        INSERT INTO posts SELECT 'crew', id, id, 'pa', 'published', 'song', 'public', 'general' FROM unnest(ARRAY['shared','dance','never-started','private','removed','adult','foreign','old','repeat']) id;
        UPDATE posts SET visibility='members_only' WHERE post_id='private';
        UPDATE posts SET status='removed' WHERE post_id='removed';
        UPDATE posts SET content_rating='adult_18' WHERE post_id='adult';
        INSERT INTO study_sessions SELECT 'a','pa','crew',id,CURRENT_TIMESTAMP-interval '1 hour',NULL FROM unnest(ARRAY['shared','private','removed','adult','repeat']) id;
        INSERT INTO karaoke_sessions VALUES ('a','pa','crew','shared',CURRENT_TIMESTAMP,NULL);
        INSERT INTO dance_sessions VALUES ('a','pa','crew','dance',CURRENT_TIMESTAMP-interval '30 minutes',NULL);
        INSERT INTO study_sessions_v2 VALUES ('a','pa','crew','shared',CURRENT_TIMESTAMP-interval '20 minutes',NULL,CURRENT_TIMESTAMP);
        INSERT INTO study_sessions VALUES ('a','pa2','crew','foreign',CURRENT_TIMESTAMP,NULL),('b','pb','crew','shared',CURRENT_TIMESTAMP,NULL),('c','pc','crew','shared',CURRENT_TIMESTAMP,NULL),('a','pa','crew','old',CURRENT_TIMESTAMP-interval '8 days',NULL);
        INSERT INTO study_sessions SELECT 'a','pa','crew','repeat',CURRENT_TIMESTAMP,NULL FROM generate_series(1,10);
      `);
      const url = new URL(connection);
      url.searchParams.set("options", `-c search_path=${schema}`);
      const store = makeControlPlaneSongLibraryStore(
        makeDirectPostgresControlPlaneLayer(url.toString()),
      );
      const page = await Effect.runPromise(
        listPersonaSongs({ accountId: "a", personaId: "pa" }, store),
      );
      expect(page.songs.map((song) => song.post_id)).toEqual(["shared", "repeat", "dance", "old"]);
      expect(page.songs[0]?.activities).toEqual(["karaoke", "study"]);
      expect(page.songs.find((song) => song.post_id === "dance")?.activities).toEqual(["dance"]);
      expect(page.next_cursor).toBeNull();
      for (const personaId of ["pb", "missing"]) {
        await expect(
          Effect.runPromise(listPersonaSongs({ accountId: "a", personaId }, store)),
        ).rejects.toMatchObject({ _tag: "NotFound" });
      }
      const trending = await Effect.runPromise(store.trending());
      expect(trending.map((song) => song.post_id)).toEqual(["shared"]);
      expect(trending[0]).not.toHaveProperty("account_id");
      await db.query("INSERT INTO community_memberships VALUES ('crew','a','member')");
      expect(
        (
          await Effect.runPromise(listPersonaSongs({ accountId: "a", personaId: "pa" }, store))
        ).songs.some((song) => song.post_id === "private"),
      ).toBe(true);
      await db.query(`
        INSERT INTO posts SELECT 'crew', 'paged-'||i, 'Paged song', 'pa', 'published', 'song', 'public', 'general' FROM generate_series(1,27) i;
        INSERT INTO study_sessions SELECT 'a','pa','crew','paged-'||i,TIMESTAMPTZ '2026-01-01 00:00:00.123456+00',NULL FROM generate_series(1,27) i;
      `);
      const first = await Effect.runPromise(
        listPersonaSongs({ accountId: "a", personaId: "pa" }, store),
      );
      if (first.next_cursor === null) throw new Error("Expected pagination cursor");
      const second = await Effect.runPromise(
        listPersonaSongs({ accountId: "a", personaId: "pa", cursor: first.next_cursor }, store),
      );
      const ids = [...first.songs, ...second.songs].map((song) => song.post_id);
      expect(ids).toHaveLength(32);
      expect(new Set(ids).size).toBe(32);
      expect(second.next_cursor).toBeNull();
      await db.query("UPDATE personas SET status='retired' WHERE persona_id='pa'");
      await expect(
        Effect.runPromise(listPersonaSongs({ accountId: "a", personaId: "pa" }, store)),
      ).rejects.toMatchObject({ _tag: "NotFound" });
      expect(await Effect.runPromise(store.trending())).toEqual([]);
    } finally {
      await db.query(`DROP SCHEMA ${schema} CASCADE`);
      await db.end();
    }
  });
});
