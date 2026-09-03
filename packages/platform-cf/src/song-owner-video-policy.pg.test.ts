import { describe, expect, test } from "bun:test";
import { Client } from "pg";
import {
  applyPostgresTestBaselineConnection,
  withReusablePostgresTestSchema,
} from "../../../scripts/postgres-test-baseline.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;

const HASH = "11".repeat(32);
const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const connectionForSchema = (raw: string, schema: string): string => {
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
};

async function withSchema<A>(use: (admin: Client, scopedUrl: string) => Promise<A>): Promise<A> {
  if (connectionString === undefined) throw new Error("test URL was not configured");
  return withReusablePostgresTestSchema({
    baseConnectionString: connectionString,
    schemaName: "packages_platform_cf_src_song_owner_video_policy_pg_test_ts",
    use: async ({ admin, schema }) => {
      await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
      const scopedUrl = connectionForSchema(connectionString, schema);
      await applyPostgresTestBaselineConnection({ connectionString: scopedUrl });
      await admin.query("ALTER TABLE media_publication_projections DISABLE TRIGGER USER");
      await admin.query(
        "ALTER TABLE media_publication_projections ENABLE TRIGGER media_publication_song_owner_policy_initialize",
      );
      return use(admin, scopedUrl);
    },
  });
}

async function seedIdentity(admin: Client): Promise<void> {
  await admin.query("SET session_replication_role = replica");
  try {
    await admin.query(
      `INSERT INTO users (user_id) VALUES
         ('owner-account'), ('other-account')`,
    );
    await admin.query(
      `INSERT INTO personas (persona_id, account_id, status, created_at) VALUES
         ('owner-persona', 'owner-account', 'active', clock_timestamp()),
         ('owner-sibling-persona', 'owner-account', 'active', clock_timestamp()),
         ('other-persona', 'other-account', 'active', clock_timestamp())`,
    );
    await admin.query(
      `INSERT INTO communities (
         community_id, display_name, status, created_by_user_id, created_at, updated_at
       ) VALUES (
         'community-1', 'Song policy fixtures', 'active', 'owner-account',
         clock_timestamp(), clock_timestamp()
       )`,
    );
  } finally {
    await admin.query("SET session_replication_role = origin");
  }
}

async function seedSong(
  admin: Client,
  suffix: string,
  licensePreset: "commercial-remix" | "commercial-use" | "non-commercial",
): Promise<void> {
  const postId = `song-${suffix}`;
  const submissionId = `submission-${suffix}`;
  const operationId = `song-operation-${suffix}`;
  await admin.query("SET session_replication_role = replica");
  try {
    await admin.query(
      `INSERT INTO posts (
         community_id, post_id, author_user_id, author_persona_id, post_type,
         status, visibility, title, created_at, updated_at,
         author_declared_rating, content_rating
       ) VALUES (
         'community-1', $1, 'owner-account', 'owner-persona', 'song',
         'published', 'public', $2, clock_timestamp(), clock_timestamp(),
         'general', 'general'
       )`,
      [postId, `Song ${suffix}`],
    );
    await admin.query(
      `INSERT INTO media_post_submissions (
         submission_id, community_id, actor_user_id, author_persona_id,
         operation_id, idempotency_key, request_hash, title, song_type,
         start_input, audio_reservation_id, creation_revision, audio_revision,
         analysis_revision, decision_revision, current_terms_revision,
         current_immutable_ref, current_analysis_revision,
         current_decision_revision, status, phase, post_id,
         response_snapshot_bytes, response_snapshot_sha256
       ) VALUES (
         $1, 'community-1', 'owner-account', 'owner-persona',
         $2, $3, $4, $5, 'original', '{}'::jsonb, $6,
         2, 1, 1, 1, 2, $7, 1, 1, 'published', NULL, $8,
         convert_to('{}', 'UTF8'),
         encode(sha256(convert_to('{}', 'UTF8')), 'hex')
       )`,
      [
        submissionId,
        operationId,
        `submission-idempotency-${suffix}`,
        HASH,
        `Song ${suffix}`,
        `reservation-${suffix}`,
        `r2://song/${suffix}`,
        postId,
      ],
    );
    await admin.query(
      `INSERT INTO media_submission_terms (
         submission_id, community_id, actor_user_id, author_persona_id,
         operation_id, creation_revision, license_preset,
         commercial_remix_share_bps, royalty_allocations, access_mode,
         terms_snapshot
       ) VALUES (
         $1, 'community-1', 'owner-account', 'owner-persona', $2, 2, $3,
         $4, '[{"recipient_id":"owner-account","share_bps":10000}]'::jsonb,
         'public', jsonb_build_object('license_preset', $3::text)
       )`,
      [submissionId, operationId, licensePreset, licensePreset === "commercial-remix" ? 1000 : 0],
    );
  } finally {
    await admin.query("SET session_replication_role = origin");
  }

  await admin.query(
    `INSERT INTO media_publication_projections (
       submission_id, community_id, actor_user_id, author_persona_id,
       operation_id, post_id, creation_revision, audio_revision,
       analysis_revision, decision_revision, canonical_audio_sha256,
       title, audio_asset_ref, language_status, lyrics_explicitness,
       alignment, data_registration, locked_delivery
     ) VALUES (
       $1, 'community-1', 'owner-account', 'owner-persona', $2, $3,
       2, 1, 1, 1, $4, $5, $6, 'not_applicable', 'not_applicable',
       'not_applicable', 'pending', 'not_required'
     )`,
    [submissionId, operationId, postId, HASH, `Song ${suffix}`, `r2://song/${suffix}`],
  );
}

type PolicyRow = Readonly<{
  policy_revision: string;
  third_party_reward_legs: string;
  pool_leg: string;
  derivative_video: string;
  policy_hash: string;
  owner_account_id: string;
  audio_revision: string;
}>;

async function currentPolicy(admin: Client, postId: string): Promise<PolicyRow> {
  const result = await admin.query<PolicyRow>(
    `SELECT revision.policy_revision::text, revision.third_party_reward_legs,
            revision.pool_leg, revision.derivative_video, revision.policy_hash,
            revision.owner_account_id, revision.audio_revision::text
       FROM song_owner_policies AS head
       JOIN song_owner_policy_revisions AS revision
         ON revision.community_id = head.community_id
        AND revision.post_id = head.post_id
        AND revision.policy_revision = head.current_policy_revision
      WHERE head.community_id = 'community-1' AND head.post_id = $1`,
    [postId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("current song owner policy was not created");
  return row;
}

suite("song owner derivative-video policy persistence", () => {
  test("publication creates one exact owner policy with license-derived defaults", async () => {
    await withSchema(async (admin) => {
      await seedIdentity(admin);
      await seedSong(admin, "remix", "commercial-remix");
      await seedSong(admin, "noncommercial", "non-commercial");
      await seedSong(admin, "commercial", "commercial-use");

      expect(await currentPolicy(admin, "song-remix")).toMatchObject({
        policy_revision: "1",
        third_party_reward_legs: "allowed",
        pool_leg: "allowed",
        derivative_video: "allowed",
        owner_account_id: "owner-account",
        audio_revision: "1",
      });
      expect((await currentPolicy(admin, "song-noncommercial")).derivative_video).toBe("allowed");
      expect((await currentPolicy(admin, "song-commercial")).derivative_video).toBe("owner_only");

      const counts = await admin.query<{ readonly heads: string; readonly revisions: string }>(
        `SELECT count(*)::text AS heads,
                (SELECT count(*)::text FROM song_owner_policy_revisions) AS revisions
           FROM song_owner_policies`,
      );
      expect(counts.rows[0]).toEqual({ heads: "3", revisions: "3" });
    });
  });

  test("owner CAS appends while stale and foreign updates leave no partial row", async () => {
    await withSchema(async (admin) => {
      await seedIdentity(admin);
      await seedSong(admin, "cas", "non-commercial");

      const updated = await admin.query<PolicyRow>(
        `SELECT policy_revision::text, third_party_reward_legs, pool_leg,
                derivative_video, policy_hash, owner_account_id,
                audio_revision::text
           FROM append_song_owner_policy_revision_v1(
             'community-1', 'song-cas', 'owner-account', 1,
             'owner_only', 'declined', 'blocked'
           )`,
      );
      expect(updated.rows[0]).toMatchObject({
        policy_revision: "2",
        third_party_reward_legs: "owner_only",
        pool_leg: "declined",
        derivative_video: "blocked",
      });

      await expect(
        admin.query(
          `SELECT * FROM append_song_owner_policy_revision_v1(
             'community-1', 'song-cas', 'owner-account', 1,
             'allowed', 'allowed', 'allowed'
           )`,
        ),
      ).rejects.toThrow("song owner policy revision conflict");
      await expect(
        admin.query(
          `SELECT * FROM append_song_owner_policy_revision_v1(
             'community-1', 'song-cas', 'other-account', 2,
             'allowed', 'allowed', 'allowed'
           )`,
        ),
      ).rejects.toThrow("song owner policy actor is not the owner account");

      const counts = await admin.query<{ readonly revisions: string }>(
        `SELECT count(*)::text AS revisions
           FROM song_owner_policy_revisions
          WHERE community_id = 'community-1' AND post_id = 'song-cas'`,
      );
      expect(counts.rows[0]?.revisions).toBe("2");
      await expect(
        admin.query(
          `UPDATE song_owner_policy_revisions
              SET derivative_video = 'allowed'
            WHERE community_id = 'community-1' AND post_id = 'song-cas'
              AND policy_revision = 2`,
        ),
      ).rejects.toThrow("append-only");
    });
  });

  test("concurrent CAS commands produce one successor", async () => {
    await withSchema(async (admin, scopedUrl) => {
      await seedIdentity(admin);
      await seedSong(admin, "concurrent", "non-commercial");
      const left = new Client({ connectionString: scopedUrl });
      const right = new Client({ connectionString: scopedUrl });
      await Promise.all([left.connect(), right.connect()]);
      try {
        const results = await Promise.allSettled([
          left.query(
            `SELECT * FROM append_song_owner_policy_revision_v1(
               'community-1', 'song-concurrent', 'owner-account', 1,
               'allowed', 'allowed', 'blocked'
             )`,
          ),
          right.query(
            `SELECT * FROM append_song_owner_policy_revision_v1(
               'community-1', 'song-concurrent', 'owner-account', 1,
               'allowed', 'allowed', 'owner_only'
             )`,
          ),
        ]);
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
        expect((await currentPolicy(admin, "song-concurrent")).policy_revision).toBe("2");
      } finally {
        await Promise.all([left.end(), right.end()]);
      }
    });
  });

  test("reservation, decision, and commit observations freeze current policy", async () => {
    await withSchema(async (admin) => {
      await seedIdentity(admin);
      await seedSong(admin, "observe", "non-commercial");

      const reservation = await admin.query(
        `SELECT owner_policy_revision::text, derivative_video, permitted, denial_reason
           FROM observe_song_derivative_video_policy_v1(
             'video-operation-1', 'media_reservation_issued', 1,
             'community-1', 'song-observe', 1, 'other-account'
           )`,
      );
      expect(reservation.rows[0]).toEqual({
        owner_policy_revision: "1",
        derivative_video: "allowed",
        permitted: true,
        denial_reason: null,
      });

      await admin.query(
        `SELECT * FROM append_song_owner_policy_revision_v1(
          'community-1', 'song-observe', 'owner-account', 1,
          'allowed', 'allowed', 'owner_only'
        )`,
      );
      const decision = await admin.query(
        `SELECT owner_policy_revision::text, derivative_video, permitted, denial_reason
           FROM observe_song_derivative_video_policy_v1(
             'video-operation-1', 'publication_allowed', 2,
             'community-1', 'song-observe', 1, 'other-account'
           )`,
      );
      expect(decision.rows[0]).toEqual({
        owner_policy_revision: "2",
        derivative_video: "owner_only",
        permitted: false,
        denial_reason: "derivative_video_owner_only",
      });

      await admin.query(
        `SELECT * FROM append_song_owner_policy_revision_v1(
          'community-1', 'song-observe', 'owner-account', 2,
          'allowed', 'allowed', 'blocked'
        )`,
      );
      const commit = await admin.query(
        `SELECT owner_policy_revision::text, derivative_video, permitted, denial_reason
           FROM observe_song_derivative_video_policy_v1(
             'video-operation-1', 'publication_committed', 3,
             'community-1', 'song-observe', 1, 'owner-account'
           )`,
      );
      expect(commit.rows[0]).toEqual({
        owner_policy_revision: "3",
        derivative_video: "blocked",
        permitted: false,
        denial_reason: "derivative_video_blocked",
      });

      const replay = await admin.query(
        `SELECT owner_policy_revision::text, derivative_video, permitted, denial_reason
           FROM observe_song_derivative_video_policy_v1(
             'video-operation-1', 'media_reservation_issued', 1,
             'community-1', 'song-observe', 1, 'other-account'
           )`,
      );
      expect(replay.rows[0]).toEqual(reservation.rows[0]);
      await expect(
        admin.query(
          `SELECT * FROM observe_song_derivative_video_policy_v1(
             'video-operation-1', 'media_reservation_issued', 1,
             'community-1', 'song-observe', 1, 'owner-account'
           )`,
        ),
      ).rejects.toThrow("observation replay conflict");
    });
  });
});
