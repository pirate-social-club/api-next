import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { removeOwnVideoPost } from "@pirate/application/video/post-removal";
import { Effect } from "effect";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { authorizeVideoAccess } from "../../application/src/video/access-authorization.ts";
import { acceptTrustedVideoAnalysis } from "../../application/src/video/publication.ts";
import { makeControlPlaneContentStore } from "./content-repository.ts";
import { makeControlPlaneFeedStore } from "./feed-repository.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { makeReleaseRuntimeLogin } from "./reward-safe-runtime-role.pg-fixture.ts";
import { makeVideoPublicationAuthorization } from "./video-access-authorization.ts";
import { makeControlPlaneVideoPostRemovalStore } from "./video-post-removal-repository.ts";
import {
  actor,
  community,
  finalizedFixture,
  operationId,
  persona,
  seedVideoActors,
  submissionId,
  trustedAnalysis,
} from "./video-publication.pg-fixture.ts";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !url)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
const suite = url ? describe : describe.skip;
const q = (value: string) => `"${value.replaceAll('"', '""')}"`;

suite("author video removal under release runtime privileges", () => {
  const schema = `video_post_removal_${process.pid}_${Date.now()}`;
  const admin = new Client({ connectionString: url });
  let login: Awaited<ReturnType<typeof makeReleaseRuntimeLogin>> | undefined;
  let scoped = "";
  let publishedPost = "";
  const runtime = () => {
    if (!login) throw new Error("runtime fixture not ready");
    return makeControlPlaneVideoPostRemovalStore(makeDirectPostgresControlPlaneLayer(login.url));
  };
  const remove = (postId: string, accountId = actor) =>
    Effect.runPromise(removeOwnVideoPost({ postId, accountId }, runtime()));
  const state = async (postId: string) =>
    (await admin.query("SELECT status FROM posts WHERE post_id=$1", [postId])).rows[0]?.status;
  const projection = async (postId: string) =>
    (await admin.query("SELECT post_id FROM home_feed_projection WHERE post_id=$1", [postId])).rows;
  const seed = async (postId: string, status = "published", kind = "video") => {
    await admin.query(
      `INSERT INTO posts (community_id,post_id,author_user_id,author_persona_id,
        post_type,status,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,clock_timestamp(),clock_timestamp())`,
      [community, postId, actor, persona, kind, status],
    );
    await admin.query(
      `INSERT INTO home_feed_projection (community_id,feed_item_id,post_id,projected_at)
       VALUES ($1,$2,$2,clock_timestamp())`,
      [community, postId],
    );
  };
  const publicationEvidence = async () =>
    JSON.stringify(
      (
        await admin.query(
          `SELECT row_to_json(s) AS submission,
            (SELECT jsonb_agg(to_jsonb(p)) FROM media_publication_projections p
             WHERE p.submission_id=s.submission_id) AS projection,
            (SELECT jsonb_agg(to_jsonb(r)) FROM media_video_rights r
             WHERE r.submission_id=s.submission_id) AS rights
           FROM media_post_submissions s WHERE s.submission_id=$1`,
          [submissionId],
        )
      ).rows,
    );

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${q(schema)}`);
    await admin.query(`SET search_path TO ${q(schema)}`);
    const scopedUrl = new URL(url as string);
    scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
    scoped = scopedUrl.toString();
    await applyPostgresTestBaselineConnection({ connectionString: scoped });
    await seedVideoActors(admin);
    await admin.query("INSERT INTO users (user_id) VALUES ('other_account')");
    const { store } = await finalizedFixture(scoped);
    const result = await acceptTrustedVideoAnalysis(
      { submissionId, analysis: trustedAnalysis() },
      { store, nowIso: () => new Date().toISOString(), randomUuid: () => crypto.randomUUID() },
    );
    expect(result.status).toBe("published");
    publishedPost = (
      await admin.query("SELECT post_id FROM media_post_submissions WHERE operation_id=$1", [
        operationId,
      ])
    ).rows[0]?.post_id;
    expect(publishedPost).toBeString();
    login = await makeReleaseRuntimeLogin(admin, url as string, schema);
  }, 30_000);

  afterAll(async () => {
    try {
      if (login) await login.drop();
      await admin.query(`DROP SCHEMA IF EXISTS ${q(schema)} CASCADE`);
    } finally {
      await admin.end();
    }
  });

  test("another account cannot remove the public video or learn an author receipt", async () => {
    await expect(remove(publishedPost, "other_account")).rejects.toMatchObject({
      _tag: "NotFound",
    });
    expect(await state(publishedPost)).toBe("published");
    expect(await projection(publishedPost)).toHaveLength(1);
  });

  test("removes the Post atomically, denies fresh detail and shared poster/playback authority, and survives a lost reply", async () => {
    // Normal read stores use the schema owner here; every mutation under test
    // uses the restricted release login, never the DDL owner.
    const layer = makeDirectPostgresControlPlaneLayer(scoped);
    const contentStore = makeControlPlaneContentStore(layer);
    const read = () =>
      Effect.runPromise(
        contentStore.getPost({
          communityId: community,
          postId: publishedPost,
          viewerUserId: actor,
        }),
      );
    expect(await read()).toMatchObject({ post: { id: publishedPost, status: "published" } });
    const before = await publicationEvidence();
    const receipt = await remove(publishedPost);
    expect(receipt).toEqual({
      object: "video_post_deletion",
      community_id: community,
      post_id: publishedPost,
      status: "deleted",
    });
    expect(await state(publishedPost)).toBe("deleted");
    expect(await projection(publishedPost)).toHaveLength(0);
    expect(await read()).toBeNull();
    const feed = await Effect.runPromise(
      makeControlPlaneFeedStore(layer).listHome({ query: {}, viewerUserId: actor }),
    );
    expect(JSON.stringify(feed)).not.toContain(publishedPost);
    await expect(
      Effect.runPromise(
        authorizeVideoAccess(
          { postId: publishedPost, viewerUserId: actor },
          {
            contentStore,
            authorizePublication: makeVideoPublicationAuthorization(layer),
          },
        ),
      ),
    ).rejects.toMatchObject({ _tag: "NotFound" });
    expect(await remove(publishedPost)).toEqual(receipt);
    expect(await publicationEvidence()).toBe(before);
    // The real publication retry cannot resurrect a tombstoned Post.
    const { makeControlPlaneVideoPublicationStore } = await import(
      "./video-publication-repository.ts"
    );
    await acceptTrustedVideoAnalysis(
      { submissionId, analysis: trustedAnalysis() },
      {
        store: makeControlPlaneVideoPublicationStore(layer),
        nowIso: () => new Date().toISOString(),
        randomUuid: () => crypto.randomUUID(),
      },
    );
    expect(await state(publishedPost)).toBe("deleted");
    expect(await read()).toBeNull();
    expect(await publicationEvidence()).toBe(before);
  });

  test("a failed feed mutation rolls the tombstone back; the same target can recover", async () => {
    await seed("post-rollback");
    if (!login) throw new Error("runtime fixture not ready");
    await admin.query(`REVOKE DELETE ON home_feed_projection FROM ${q(login.role)}`);
    try {
      await expect(remove("post-rollback")).rejects.toMatchObject({ _tag: "InternalError" });
      expect(await state("post-rollback")).toBe("published");
      expect(await projection("post-rollback")).toHaveLength(1);
    } finally {
      await admin.query(`GRANT DELETE ON home_feed_projection TO ${q(login.role)}`);
    }
    await remove("post-rollback");
    expect(await state("post-rollback")).toBe("deleted");
  });

  test("rejects non-video and unpublished targets without changing them", async () => {
    for (const status of ["draft", "processing", "failed"]) {
      const postId = `post-unpublished-${status}`;
      await seed(postId, status);
      await expect(remove(postId)).rejects.toMatchObject({ _tag: "Conflict" });
      expect(await state(postId)).toBe(status);
      expect(await projection(postId)).toHaveLength(1);
    }
    await seed("post-song-kept", "published", "song");
    await expect(remove("post-song-kept")).rejects.toMatchObject({ _tag: "NotFound" });
    expect(await state("post-song-kept")).toBe("published");
  });

  test("the author can finish deleting a previously hidden or removed video", async () => {
    for (const status of ["hidden", "removed"]) {
      const postId = `post-owned-${status}`;
      await seed(postId, status);
      await remove(postId);
      expect(await state(postId)).toBe("deleted");
      expect(await projection(postId)).toHaveLength(0);
    }
  });
});
