import { expect } from "bun:test";
import { Schema } from "effect";
import { Client } from "pg";
import { runPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import {
  applyPostgresTestBaselineConnection,
  type createReusablePostgresTestSchemaOwner,
} from "../../../scripts/postgres-test-baseline.ts";
import {
  type ModeratorReview,
  transitionModeratorReview,
} from "../../domain/src/dance/moderator-review.ts";
import { ModeratorReviewFactsSchema } from "../../domain/src/dance/moderator-review-schema.ts";
import { historicalReview, reviewCommit } from "./moderated-dance-authority.pg-fixture.ts";
import { seedModeratedDanceIntake as seed } from "./moderated-dance-intake.pg-fixture.ts";
import { makeModeratedDancePublicationInput } from "./moderated-dance-publication-input.ts";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && url === undefined)
  throw new Error("Native target required");
const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;
const sql = "SELECT moderated_dance_publication_input_v1($1,$2,$3::jsonb) packet";
export const token = "original-handoff";
export function makePublicationInputFixture(
  reusableSchema: ReturnType<typeof createReusablePostgresTestSchemaOwner>,
) {
  return async function withFixture(
    use: (
      f: Awaited<ReturnType<typeof seed>>,
      admin: Client,
      review: ModeratorReview,
    ) => Promise<void>,
    remainingMs?: number,
    migrated = false,
    maximumProviderCalls = 6,
  ) {
    if (url === undefined) throw new Error("Native target missing");
    const setup = async ({ admin, schema }: { admin: Client; schema: string }) => {
      const scoped = new URL(url);
      scoped.searchParams.set("options", `-c search_path=${schema}`);
      if (migrated)
        await runPostgresMigrations({ connectionString: scoped.toString(), dryRun: false });
      else await applyPostgresTestBaselineConnection({ connectionString: scoped.toString() });
      await admin.query(`SET search_path TO ${quote(schema)}`);
      const f = await seed(admin, scoped.toString(), undefined, {
        transferWithinMs: 300000,
        maximumProviderCalls,
      });
      // Synthetic ordinary published song/timing/PCM lineage only. All commands
      // under test run with guards ON. No real camera, provider or R2 is claimed.
      await admin.query("BEGIN");
      try {
        await admin.query("SET LOCAL session_replication_role=replica");
        await admin.query("INSERT INTO persona_profiles(persona_id) VALUES($1)", [
          f.facts.personaId,
        ]);
        await admin.query(
          "INSERT INTO community_memberships(community_id,membership_id,user_id,status,joined_at,created_at,updated_at) VALUES($1,'dance-member',$2,'member',clock_timestamp(),clock_timestamp(),clock_timestamp())",
          [f.facts.communityId, f.facts.accountId],
        );
        await admin.query(
          "INSERT INTO song_owner_policy_revisions(community_id,post_id,audio_revision,owner_account_id,policy_revision,third_party_reward_legs,pool_leg,derivative_video,policy_hash) VALUES($1,$2,$3,'private-test-owner',1,'allowed','allowed','allowed',song_owner_policy_hash_v1($1,$2,$3,'private-test-owner',1,'allowed','allowed','allowed'))",
          [f.facts.communityId, f.facts.songPostId, f.facts.audioRevision],
        );
        await admin.query(
          "INSERT INTO song_owner_policies(community_id,post_id,audio_revision,owner_account_id,current_policy_revision,current_policy_hash) SELECT community_id,post_id,audio_revision,owner_account_id,policy_revision,policy_hash FROM song_owner_policy_revisions",
        );
        await admin.query(
          "INSERT INTO media_song_canonical_timings(song_post_id,audio_revision,song_community_id,canonical_audio_sha256,state,duration_samples,prober_identity,prober_policy_revision,measured_at) VALUES($1,$2,$3,$4,'ready',8640000,'fixture-decoder',1,clock_timestamp())",
          [f.facts.songPostId, f.facts.audioRevision, f.facts.communityId, "a".repeat(64)],
        );
        await admin.query(
          "INSERT INTO media_song_video_pcm_references(song_post_id,audio_revision,canonical_audio_sha256,duration_samples,pcm_object_key,pcm_object_version,pcm_object_etag,pcm_sha256,pcm_byte_length,decoder_recipe) VALUES($1,$2,$3,8640000,'song-video-pcm/fixture','v1','etag',$3,34560000,'fixture')",
          [f.facts.songPostId, f.facts.audioRevision, "a".repeat(64)],
        );
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
      let review = await historicalReview(f, admin, Date.now() + 604200000);
      for (const operation of ["visibility", "verdict"] as const) {
        const actor = {
          kind: "account",
          accountId: operation === "visibility" ? f.facts.accountId : "private-test-owner",
        } as const;
        const at =
          operation === "visibility"
            ? review.capture.uploadedAtMs + 10
            : remainingMs === undefined
              ? Date.now()
              : Date.now() - f.publication.disposition.transferWithinMs + remainingMs;
        const facts = Schema.decodeUnknownSync(ModeratorReviewFactsSchema)(
          (
            await admin.query("SELECT moderated_dance_review_facts_v1($1,$2::jsonb,$3,$4) packet", [
              review.capture.reviewId,
              JSON.stringify(actor),
              operation,
              at,
            ])
          ).rows[0]?.packet,
        );
        const change = transitionModeratorReview(
          review,
          operation === "visibility"
            ? {
                kind: "visibility",
                showPublicly: true,
                disclosureVersion: review.capture.policy.disclosureVersion,
              }
            : { kind: "verdict", verdict: "passed", version: "dance-owner-verdict-attestation-v1" },
          actor,
          review.revision,
          at,
          facts,
        );
        expect(change.refusal).toBeNull();
        await admin.query("SELECT commit_moderated_dance_review_v1($1::jsonb)", [
          JSON.stringify(reviewCommit(review, change, actor, operation, operation, at)),
        ]);
        review = change.state;
      }
      expect(review.publication).toBe("pending");
      await use(f, admin, review);
    };
    if (!migrated)
      return reusableSchema.run({
        baseConnectionString: url,
        schemaName: "dance_publication_input_pg_v1",
        use: setup,
      });
    const admin = new Client({ connectionString: url }),
      schema = `dance_input_acl_${crypto.randomUUID().replaceAll("-", "")}`;
    await admin.connect();
    try {
      await admin.query(`CREATE SCHEMA ${quote(schema)}`);
      await setup({ admin, schema });
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
      await admin.end();
    }
  };
}

export const command = (
  admin: Client,
  reviewId: string,
  action: string,
  input: Record<string, unknown> = {},
) =>
  admin
    .query(sql, [reviewId, action, JSON.stringify({ ...input, token, videoTrackEnabled: true })])
    .then((r) => r.rows[0]?.packet);
export const protocol = (admin: Client, reviewId: string) =>
  makeModeratedDancePublicationInput({
    reviewId,
    token,
    videoTrackEnabled: true,
    call: async (_label, text, values) => (await admin.query(text, [...values])).rows[0]?.packet,
  });
export async function stored(admin: Client, r: ModeratorReview) {
  const id = r.capture.reviewId,
    h = await command(admin, id, "begin"),
    c = r.capture;
  const body = {
    key: h.destination_key,
    sha256: "9".repeat(64),
    size: 1000,
    sourceSha256: c.sourceDigest,
    bodyStartMs: c.bodyStartMs,
    bodyEndMs: c.bodyEndMs,
    durationMs: c.bodyEndMs - c.bodyStartMs,
    transformRevision: "dance-publication-body-v1",
  };
  await command(admin, id, "plan", { body });
  expect((await command(admin, id, "put")).status).toBe("put");
  await command(admin, id, "observe", {
    body: { ...body, version: "independent-v1", etag: "independent-etag" },
  });
  return { h, body };
}
