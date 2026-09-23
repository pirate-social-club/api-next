/**
 * The five song prerequisite checks plus qualification-row absence, read-only,
 * against the database in QUAL_CHECK_URL (main or the branch). Prints facts
 * and an overall pass flag; exits 1 on any failure.
 */
import { Client } from "pg";

const EXPECTED = {
  post_id: "media-post-media-operation-5f474b7a-6b47-4e86-b585-e65cf2cc3e3b",
  community_id: "community_d77ee63a-e0dc-4162-aab1-ae593b533bda",
  audio_revision: "1",
  canonical_audio_sha256: "51afd9db7bb1e0be27c0d1fd4c55741d0570027dd6c20a6f087388e971c62d08",
  audio_asset_ref: "media://immutable/media-operation-5f474b7a-6b47-4e86-b585-e65cf2cc3e3b/audio/1",
};
const raw = process.env.QUAL_CHECK_URL;
if (!raw) throw new Error("QUAL_CHECK_URL is required");
const url = new URL(raw);
if (url.searchParams.get("sslrootcert") === "system") url.searchParams.delete("sslrootcert");
url.searchParams.set("options", "-c search_path=api_next");
const c = new Client({ connectionString: url.toString() });
await c.connect();
try {
  await c.query("BEGIN READ ONLY");
  const q = async (text: string, values: unknown[] = []) => (await c.query(text, values)).rows;
  const post = (await q(`SELECT p.post_id,p.community_id,p.post_type,p.status,p.visibility,p.author_user_id,p.author_persona_id,c.status AS community_status
    FROM posts p JOIN communities c ON c.community_id=p.community_id WHERE p.post_id=$1`, [EXPECTED.post_id]))[0];
  const projection = (await q(`SELECT audio_revision::text,canonical_audio_sha256,audio_asset_ref FROM media_publication_projections WHERE post_id=$1 AND media_kind='song'`, [EXPECTED.post_id]))[0];
  const policy = (await q(`SELECT r.derivative_video FROM song_owner_policies o JOIN song_owner_policy_revisions r
    ON r.community_id=o.community_id AND r.post_id=o.post_id AND r.audio_revision=o.audio_revision AND r.policy_revision=o.current_policy_revision WHERE o.post_id=$1`, [EXPECTED.post_id]))[0];
  const membership = post ? (await q(`SELECT status FROM community_memberships WHERE community_id=$1 AND user_id=$2`, [post.community_id, post.author_user_id]))[0] : undefined;
  const persona = post ? (await q(`SELECT status FROM personas WHERE account_id=$1 AND persona_id=$2`, [post.author_user_id, post.author_persona_id]))[0] : undefined;
  const audio = projection ? (await q(`SELECT canonical_sha256,size_bytes::text FROM media_immutable_objects WHERE immutable_ref=$1`, [projection.audio_asset_ref]))[0] : undefined;
  const absent = (await q(`SELECT
    (SELECT count(*) FROM media_upload_reservations WHERE reservation_id='media-reservation-00000000-0000-4000-8000-000000009211')::int +
    (SELECT count(*) FROM media_post_submissions WHERE submission_id='media-submission-video-qualification-20260921-01')::int +
    (SELECT count(*) FROM media_song_video_render_plans WHERE plan_id='song-video-plan:qualification-20260921-01')::int +
    (SELECT count(*) FROM media_song_video_render_attempts WHERE plan_id='song-video-plan:qualification-20260921-01')::int AS qualification_rows,
    (SELECT count(*) FROM media_song_canonical_timings)::int AS timings,
    (SELECT count(*) FROM media_song_video_render_attempts)::int AS render_attempts`))[0];
  const checks = {
    published_song_in_active_community:
      post?.post_type === "song" && post?.status === "published" && post?.visibility === "public" &&
      post?.community_status === "active" && post?.community_id === EXPECTED.community_id,
    projection_matches:
      projection?.audio_revision === EXPECTED.audio_revision &&
      projection?.canonical_audio_sha256 === EXPECTED.canonical_audio_sha256 &&
      projection?.audio_asset_ref === EXPECTED.audio_asset_ref,
    derivative_video_allowed: policy?.derivative_video === "allowed",
    audio_object_sealed: audio?.canonical_sha256 === EXPECTED.canonical_audio_sha256,
    author_active_member_with_active_persona: membership?.status === "member" && persona?.status === "active",
    no_qualification_rows: absent?.qualification_rows === 0,
  };
  const pass = Object.values(checks).every(Boolean);
  console.log(JSON.stringify({ checks, facts: { audio_size_bytes: audio?.size_bytes ?? null, timings: absent?.timings, render_attempts: absent?.render_attempts }, pass }, null, 1));
  if (!pass) process.exitCode = 1;
} finally {
  await c.query("ROLLBACK").catch(() => undefined);
  await c.end();
}
