import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Effect } from "effect";
import { Client } from "pg";
import {
  loadPostgresMigrations,
  runPostgresMigrations,
} from "../../../scripts/postgres-migrations.ts";
import {
  applyPostgresTestBaselineConnection,
  createReusablePostgresTestSchemaOwner,
} from "../../../scripts/postgres-test-baseline.ts";
import { runBlockedQuery } from "./moderated-dance-authority.pg-fixture.ts";
import { seedModeratedDanceIntake as seed } from "./moderated-dance-intake.pg-fixture.ts";
import {
  moderatedReferenceCommand,
  preparePublishedModeratedReference,
  publishedModeratedDanceVideo,
} from "./moderated-dance-reference.pg-fixture.ts";
import { community } from "./video-publication.pg-fixture.ts";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && url === undefined)
  throw new Error("Isolated native Postgres target required");
const suite = url === undefined ? describe.skip : describe;
const reusableSchema = createReusablePostgresTestSchemaOwner();
setDefaultTimeout(30000);
afterAll(async () => {
  await reusableSchema.dispose();
});
type Intake = Awaited<ReturnType<typeof seed>>;
const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;
async function withFixture(use: (f: Intake, db: Client) => Promise<void>) {
  if (url === undefined) throw new Error("Isolated target required");
  await reusableSchema.run({
    baseConnectionString: url,
    schemaName: "dance_reference_communities_v1",
    use: async ({ admin, schema }) => {
      const connection = new URL(url);
      connection.searchParams.set("options", `-c search_path=${schema}`);
      await applyPostgresTestBaselineConnection({ connectionString: connection.toString() });
      await admin.query(`SET search_path TO ${quote(schema)}`);
      await use(await seed(admin, connection.toString()), admin);
    },
  });
}

suite("native canonical-song and ordinary-reference community ownership", () => {
  for (const duration of [6000, 30000])
    test(`Community1 song -> Community2 ${duration}ms video -> Community1 capture`, async () =>
      withFixture(async (f, db) => {
        const video = await publishedModeratedDanceVideo(
          db,
          f.connection,
          f.facts.communityId,
          duration,
        );
        expect(video.community).not.toBe(f.facts.communityId);
        const reference = await preparePublishedModeratedReference(db, f, video);
        await reference.publish();
        await f.ready();
        const options = await Effect.runPromise(
          f.store.captureOptions(f.facts.communityId, video.song.songPostId, null),
        );
        expect(options.ready).toBe(true);
        expect(options.choreographies).toHaveLength(1);
        expect(options.choreographies[0]).toMatchObject({
          reference_post_id: video.postId,
          body_duration_ms: duration,
        });
        const created = await Effect.runPromise(
          f.store.command({
            ...f.create,
            song_post_id: video.song.songPostId,
            choreography_id: reference.choreography,
          }),
        );
        expect(created.session).toMatchObject({
          community_id: f.facts.communityId,
          body_end_ms: f.facts.profile.bodyStartMs + duration,
        });
        const context = await Effect.runPromise(
          f.store.captureContext(f.facts.communityId, created.session.session_id),
        );
        expect(context.reference.reference_post_id).toBe(video.postId);
        expect(context.reward_mode).toBe("practice");
        expect(
          (
            await db.query(
              "SELECT community_id,song_post_id,reference_community_id FROM dance_moderator_reference_revisions_v1 WHERE choreography_id=$1",
              [reference.choreography],
            )
          ).rows,
        ).toEqual([
          {
            community_id: f.facts.communityId,
            song_post_id: video.song.songPostId,
            reference_community_id: video.community,
          },
        ]);
        await expect(
          db.query(
            "UPDATE dance_moderated_reference_commands_v1 SET reference_community_id=$1 WHERE choreography_id=$2",
            [f.facts.communityId, reference.choreography],
          ),
        ).rejects.toMatchObject({ code: "DRV01" });
        expect(await reference.create()).toEqual(reference.receipt);
      }));

  test("a hidden video closes its original source and fresh publication; replay retains the original command", async () =>
    withFixture(async (f, db) => {
      const video = await publishedModeratedDanceVideo(db, f.connection, f.facts.communityId);
      const reference = await preparePublishedModeratedReference(db, f, video);
      const digest = "1".repeat(64);
      await db.query("SELECT issue_moderated_dance_reference_source_v1($1,'observer',$2)", [
        reference.choreography,
        digest,
      ]);
      const source = () =>
        db.query("SELECT * FROM resolve_moderated_dance_reference_source_v1($1)", [digest]);
      expect((await source()).rows).toHaveLength(1);
      await db.query("UPDATE posts SET status='hidden' WHERE community_id=$1 AND post_id=$2", [
        video.community,
        video.postId,
      ]);
      expect((await source()).rows).toEqual([]);
      await expect(reference.publish()).rejects.toMatchObject({ code: "DRV05" });
      expect(await reference.create()).toEqual(reference.receipt);
      expect(
        (await db.query("SELECT count(*)::int n FROM dance_moderated_reference_commands_v1"))
          .rows[0]?.n,
      ).toBe(1);
      expect(
        (
          await db.query(
            "SELECT count(*)::int n FROM dance_moderator_reference_revisions_v1 WHERE choreography_id=$1",
            [reference.choreography],
          )
        ).rows[0]?.n,
      ).toBe(0);
    }));

  test("another account, another song and an unbound video cannot allocate a reference", async () =>
    withFixture(async (f, db) => {
      const video = await publishedModeratedDanceVideo(db, f.connection, f.facts.communityId);
      const { body } = await moderatedReferenceCommand(video);
      await expect(
        Effect.runPromise(f.store.createReference({ ...body, persona_id: f.facts.personaId })),
      ).rejects.toMatchObject({ reason: "unavailable" });
      const create = (command: typeof body) =>
        db.query(
          "SELECT create_moderated_dance_reference_v1($1,$2::jsonb,$3,'rejected-choreography','rejected-segment')",
          [video.actor, JSON.stringify(command), "2".repeat(64)],
        );
      await expect(create({ ...body, song_post_id: f.facts.songPostId })).rejects.toMatchObject({
        code: "DRV07",
      });
      await expect(
        create({ ...body, reference_post_id: "private-reference" }),
      ).rejects.toMatchObject({ code: "DRV07" });
      // Migration0003 already makes Post IDs globally unique. Preserve that
      // guard as well as the separately bound community foreign key.
      await expect(
        db.query(
          "INSERT INTO posts(community_id,post_id,author_user_id,author_persona_id,post_type,status,visibility,content_rating,author_declared_rating,created_at,updated_at) VALUES($1,$2,$3,$4,'video','published','public','general','general',clock_timestamp(),clock_timestamp())",
          [f.facts.communityId, video.postId, video.actor, video.persona],
        ),
      ).rejects.toMatchObject({ code: "23505" });
      expect(
        (await db.query("SELECT count(*)::int n FROM dance_moderated_reference_commands_v1"))
          .rows[0]?.n,
      ).toBe(0);
    }));

  test("publication waits for its author before taking the replay lock used by intake", async () =>
    withFixture(async (f, db) => {
      const video = await publishedModeratedDanceVideo(db, f.connection, f.facts.communityId);
      const reference = await preparePublishedModeratedReference(db, f, video);
      const third = new Client({ connectionString: f.connection });
      await third.connect();
      try {
        const response = await runBlockedQuery(
          f.connection,
          db,
          { text: "SELECT 1 FROM users WHERE user_id=$1 FOR UPDATE", values: [video.actor] },
          reference.publication,
          async () => {
            // The old order held this lock while waiting on the actor, creating
            // a cycle with an intake transaction that already owned that actor.
            expect(
              (
                await third.query(
                  "SELECT pg_try_advisory_xact_lock(hashtextextended('moderated-dance-replay-family-v1',0)) acquired",
                )
              ).rows[0]?.acquired,
            ).toBe(true);
          },
        );
        expect(response).toHaveProperty("result");
      } finally {
        await third.end();
      }
    }));

  test("actual0306->0307 upgrade preserves same-community command, revision and capture documents under confined roles", async () => {
    if (url === undefined) throw new Error("Isolated target required");
    const db = new Client({ connectionString: url });
    await db.connect();
    const schema = `dance_ref_upgrade_${process.pid}_${Date.now()}`;
    const scoped = new URL(url);
    scoped.searchParams.set("options", `-c search_path=${schema}`);
    const role = `dance_ref_reader_${process.pid}_${Date.now()}`;
    let confined: Client | undefined;
    try {
      await db.query(`CREATE SCHEMA ${quote(schema)};SET search_path TO ${quote(schema)}`);
      const all = await loadPostgresMigrations(),
        prefix = all.slice(0, 306);
      expect(prefix.at(-1)?.version).toBe("0306_moderated_dance_publication_views.sql");
      await runPostgresMigrations({
        connectionString: scoped.toString(),
        migrations: prefix,
        expectedLedger: [],
      });
      const f = await seed(db, scoped.toString(), undefined, {
        historicalReferenceSchema: "pre-0307",
      });
      const video = await publishedModeratedDanceVideo(db, f.connection, community, 6000);
      await db.query(
        "INSERT INTO dance_review_policy_admissions_v1 SELECT $1,policy_id,accepted,accepted_by,effective_at,valid_until FROM dance_review_policy_admissions_v1 WHERE community_id=$2",
        [video.community, f.facts.communityId],
      );
      const reference = await preparePublishedModeratedReference(db, f, video);
      await reference.publish();
      await f.ready();
      const captured = await Effect.runPromise(f.store.command(f.create));
      const snapshot = async () =>
        (
          await db.query(`SELECT
        (SELECT jsonb_agg(to_jsonb(c)-'reference_community_id' ORDER BY choreography_id) FROM dance_moderated_reference_commands_v1 c) commands,
        (SELECT jsonb_agg(to_jsonb(r)-'reference_community_id' ORDER BY choreography_id) FROM dance_moderator_reference_revisions_v1 r) revisions,
        (SELECT jsonb_agg(to_jsonb(s) ORDER BY session_id) FROM dance_moderated_sessions_v1 s) sessions`)
        ).rows;
      const before = await snapshot();
      await db.query(
        `CREATE ROLE ${quote(role)} LOGIN;GRANT USAGE ON SCHEMA ${quote(schema)} TO ${quote(role)}`,
      );
      await db.query("SELECT grant_moderated_dance_runtime_v1($1,'account')", [role]);
      const result = await runPostgresMigrations({
        connectionString: scoped.toString(),
        migrations: all,
        expectedLedger: prefix,
      });
      if (result.dryRun) throw new Error("Actual upgrade required");
      expect(result.result.applied).toEqual(["0307_moderated_dance_reference_communities.sql"]);
      expect(await snapshot()).toEqual(before);
      expect(await reference.create()).toEqual(reference.receipt);
      expect(await Effect.runPromise(f.store.command(f.create))).toEqual(captured);
      expect(
        (
          await db.query(
            "SELECT reference_community_id=community_id correct FROM dance_moderated_reference_commands_v1",
          )
        ).rows,
      ).toEqual([{ correct: true }]);
      const login = new URL(scoped);
      login.username = role;
      confined = new Client({ connectionString: login.toString() });
      await confined.connect();
      expect(
        (
          await confined.query(
            "SELECT read_owned_moderated_dance_reference_v1($1,$2,$3,$4) packet",
            [video.actor, video.song.communityId, video.song.songPostId, reference.choreography],
          )
        ).rows[0]?.packet.status,
      ).toBe("ready");
      await expect(
        confined.query("SELECT reference_community_id FROM dance_moderator_reference_revisions_v1"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        confined.query("SELECT claim_moderated_dance_reference_media_v1('forbidden','x','[]')"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        db.query(
          "UPDATE dance_moderator_reference_revisions_v1 SET reference_community_id=reference_community_id",
        ),
      ).rejects.toMatchObject({ code: "DRV01" });
    } finally {
      await confined?.end();
      await db.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
      await db.query(`DROP ROLE IF EXISTS ${quote(role)}`);
      await db.end();
    }
  });
});
