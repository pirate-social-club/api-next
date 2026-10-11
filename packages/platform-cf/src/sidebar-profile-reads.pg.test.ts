import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import {
  communityNavigationStatements,
  makeControlPlaneCommunityNavigationStore,
} from "./community-navigation-repository.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import {
  makeControlPlaneProfileActivityStore,
  profileActivityStatements,
} from "./profile-activity-repository.ts";

const connection = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !connection)
  throw new Error("PostgreSQL fixture required");
const suite = connection ? describe : describe.skip;
async function fixture(use: (db: Client, url: string) => Promise<void>) {
  if (!connection) throw new Error("Missing fixture URL");
  const schema = `sidebar_profile_${crypto.randomUUID().replaceAll("-", "")}`;
  const db = new Client({ connectionString: connection });
  await db.connect();
  try {
    await db.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);
    const scoped = new URL(connection);
    scoped.searchParams.set("options", `-c search_path=${schema}`);
    await use(db, scoped.toString());
  } finally {
    await db.query(`DROP SCHEMA ${schema} CASCADE`);
    await db.end();
  }
}
suite("sidebar/profile PostgreSQL reads", () => {
  test(
    "all statements prepare against the actual migrated schema",
    () =>
      fixture(async (db, url) => {
        await applyPostgresTestBaselineConnection({ connectionString: url });
        for (const [name, sql] of Object.entries(communityNavigationStatements))
          await db.query(`PREPARE navigation_${name} AS ${sql}`);
        for (const [name, sql] of Object.entries(profileActivityStatements))
          await db.query(`PREPARE profile_${name} AS ${sql}`);
        const navigation = makeControlPlaneCommunityNavigationStore(
          makeDirectPostgresControlPlaneLayer(url),
        );
        expect(await Effect.runPromise(navigation.popular(20))).toEqual([]);
        expect(await Effect.runPromise(navigation.moderated("missing"))).toEqual([]);
        const activity = makeControlPlaneProfileActivityStore(
          makeDirectPostgresControlPlaneLayer(url),
        );
        await expect(
          Effect.runPromise(
            activity.list({ personaId: "missing", surface: "overview", cursor: null }),
          ),
        ).rejects.toMatchObject({ _tag: "NotFound" });
      }),
    30000,
  );
  test(
    "member ranking, actual roles and profile visibility filter independent fixtures",
    () =>
      fixture(async (db, url) => {
        await db.query(`
      CREATE TABLE users(user_id text PRIMARY KEY,status text);
      CREATE TABLE personas(persona_id text PRIMARY KEY,account_id text,status text);
      CREATE TABLE communities(community_id text PRIMARY KEY,display_name text,status text);
      CREATE TABLE community_memberships(community_id text,user_id text,status text);
      CREATE TABLE community_role_assignments(community_id text,account_id text,role text,status text);
      CREATE TABLE posts(community_id text,post_id text PRIMARY KEY,author_persona_id text,
        created_at timestamptz,status text,post_type text,visibility text,content_rating text,title text);
      CREATE TABLE comments(community_id text,post_id text,comment_id text PRIMARY KEY,author_persona_id text,
        parent_comment_id text,depth integer,body text,status text,content_rating text,created_at timestamptz);
      CREATE TABLE post_slug_aliases(post_id text,slug text);
      CREATE FUNCTION public_persona_projection(text) RETURNS jsonb LANGUAGE sql AS $$
        SELECT jsonb_build_object('persona_id',persona_id,'object','persona','display_name',persona_id,
          'avatar_ref',NULL,'primary_public_handle',NULL) FROM personas WHERE persona_id=$1 AND status='active' $$;
      CREATE FUNCTION can_account_view_content_rating_v1(text,text) RETURNS boolean LANGUAGE sql AS $$
        SELECT COALESCE($2='general' OR ($1='adult-viewer' AND $2='adult_18'),false) $$;
      CREATE FUNCTION has_community_moderation_capability_v1(text,text,text) RETURNS boolean LANGUAGE sql AS $$
        SELECT EXISTS(SELECT 1 FROM community_role_assignments role JOIN users account ON account.user_id=role.account_id
          WHERE role.account_id=$1 AND role.community_id=$2 AND role.role='owner' AND role.status='active'
            AND account.status='active') AND $3='moderation.view' $$;
      INSERT INTO users VALUES('viewer','active'),('author','active'),('foreign','active');
      INSERT INTO personas VALUES('persona','author','active'),('foreign-persona','foreign','active');
      INSERT INTO communities VALUES('alpha','Alpha','active'),('beta','Beta','active'),('hidden','Hidden','hidden');
      INSERT INTO community_memberships VALUES('alpha','viewer','member'),('alpha','author','member'),
        ('alpha','foreign','left'),('beta','foreign','member'),('hidden','viewer','member');
      INSERT INTO community_role_assignments VALUES('alpha','author','owner','active'),('beta','author','owner','revoked');
      INSERT INTO posts SELECT 'alpha',id,'persona','2026-10-05T10:00:00.123456Z','published','text','public','general',id
        FROM unnest(ARRAY['public','hidden-post','anonymous','private','adult','foreign-post','video']) id;
      UPDATE posts SET status='hidden' WHERE post_id='hidden-post';
      UPDATE posts SET author_persona_id=NULL WHERE post_id='anonymous';
      UPDATE posts SET visibility='members_only' WHERE post_id='private';
      UPDATE posts SET content_rating='adult_18' WHERE post_id='adult';
      UPDATE posts SET author_persona_id='foreign-persona' WHERE post_id='foreign-post';
      UPDATE posts SET post_type='video' WHERE post_id='video';
      INSERT INTO post_slug_aliases VALUES('public','public-post');
      INSERT INTO comments SELECT 'alpha','public',id,'persona',NULL,0,id,'published','general','2026-10-05T11:00:00.123456Z'
        FROM unnest(ARRAY['visible-comment','hidden-parent','child-hidden','orphan','adult-comment','foreign-comment']) id;
      UPDATE comments SET status='hidden',author_persona_id='foreign-persona' WHERE comment_id='hidden-parent';
      UPDATE comments SET parent_comment_id='hidden-parent',depth=1 WHERE comment_id='child-hidden';
      UPDATE comments SET parent_comment_id='missing',depth=1 WHERE comment_id='orphan';
      UPDATE comments SET content_rating='adult_18' WHERE comment_id='adult-comment';
      UPDATE comments SET author_persona_id='foreign-persona' WHERE comment_id='foreign-comment';
    `);
        const runtime = makeDirectPostgresControlPlaneLayer(url);
        const navigation = makeControlPlaneCommunityNavigationStore(runtime);
        const popular = await Effect.runPromise(navigation.popular(20));
        expect(popular.map((i) => [i.community_id, i.member_count])).toEqual([
          ["alpha", 2],
          ["beta", 1],
        ]);
        expect(await Effect.runPromise(navigation.moderated("viewer"))).toEqual([]);
        expect(
          (await Effect.runPromise(navigation.moderated("author"))).map((i) => i.community_id),
        ).toEqual(["alpha"]);
        await expect(
          Effect.runPromise(navigation.moderated("viewer", "alpha")),
        ).rejects.toMatchObject({ _tag: "BadRequest" });
        const activity = makeControlPlaneProfileActivityStore(runtime);
        const anon = await Effect.runPromise(
          activity.list({ personaId: "persona", surface: "overview", cursor: null }),
        );
        expect(anon.map((i) => i.activity_id)).toEqual(["visible-comment", "public"]);
        const member = await Effect.runPromise(
          activity.list({
            personaId: "persona",
            viewerId: "viewer",
            surface: "posts",
            cursor: null,
          }),
        );
        expect(member.map((i) => i.activity_id)).toEqual(["public", "private"]);
        await db.query(`INSERT INTO posts SELECT 'alpha','paged-'||lpad(i::text,2,'0'),'persona',
      '2026-10-06T10:00:00.123456Z','published','text','public','general','Paged post'
      FROM generate_series(0,24) i`);
        const first = await Effect.runPromise(
          activity.list({ personaId: "persona", surface: "posts", cursor: null }),
        );
        expect(first).toHaveLength(21);
        const last = first[19];
        if (!last) throw new Error("Expected a bounded first page");
        const second = await Effect.runPromise(
          activity.list({
            personaId: "persona",
            surface: "posts",
            cursor: {
              persona_id: "persona",
              surface: "posts",
              at: last.activity_at,
              id: last.activity_id,
              kind: last.kind,
            },
          }),
        );
        const ids = [...first.slice(0, 20), ...second].map((row) => row.activity_id);
        expect(ids).toHaveLength(26);
        expect(new Set(ids).size).toBe(26);
        expect(first[0]?.activity_at).toBe("2026-10-06T10:00:00.123456Z");
        await db.query("UPDATE community_role_assignments SET status='revoked'");
        expect(await Effect.runPromise(navigation.moderated("author"))).toEqual([]);
        await db.query("UPDATE communities SET status='hidden' WHERE community_id='alpha'");
        expect(
          await Effect.runPromise(
            activity.list({ personaId: "persona", surface: "overview", cursor: null }),
          ),
        ).toEqual([]);
      }),
    30000,
  );
  test(
    "the cursor query prepares against actual timestamp columns",
    () =>
      fixture(async (db, url) => {
        await applyPostgresTestBaselineConnection({ connectionString: url });
        const plan = await db.query(`EXPLAIN ${profileActivityStatements.list}`, [
          "persona",
          null,
          "posts",
          "2026-10-05T10:00:00.123456Z",
          "post",
          "post",
        ]);
        expect(plan.rows.length).toBeGreaterThan(0);
      }),
    30000,
  );
});
