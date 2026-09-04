import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { makeControlPlaneKaraokeRepository } from "./karaoke-repository.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const connectionForSchema = (raw: string, schema: string): string => {
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
};

const WORDS = ["Hello", "Pirate"] as const;

async function seedKaraokeSong(admin: Client): Promise<void> {
  await admin.query(
    "UPDATE activity_registry SET status='active', current_policy_version_id='karaoke_qualification_v2@1' WHERE activity_key='karaoke'",
  );
  await admin.query(
    `INSERT INTO media_publication_projections (
       submission_id, community_id, actor_user_id, operation_id, post_id,
       creation_revision, audio_revision, analysis_revision, decision_revision,
       canonical_audio_sha256, title, audio_asset_ref, language_status,
       primary_language_bcp47, lyrics_explicitness, alignment, data_registration,
       locked_delivery, projected_at, author_persona_id, lyrics_status,
       lyrics_revision, lyrics_text
     ) VALUES ('karaoke-submission','karaoke-community','karaoke-author','karaoke-operation',
       'karaoke-post',1,1,1,1,$1,'Karaoke song','audio-ref','ready','en','not_explicit',
       'ready','registered','not_required',clock_timestamp(),'karaoke-author-persona','ready',1,$2)`,
    ["1".repeat(64), WORDS.join("\n")],
  );
  await admin.query(
    `INSERT INTO media_alignment_projections (
       submission_id, community_id, actor_user_id, operation_id, post_id,
       audio_revision, analysis_revision, canonical_audio_sha256, alignment_revision,
       status, current_artifact_ref, current_artifact_revision, author_persona_id,
       lyrics_revision
     ) VALUES ('karaoke-submission','karaoke-community','karaoke-author','karaoke-operation',
       'karaoke-post',1,1,$1,1,'ready','karaoke-artifact',1,'karaoke-author-persona',1)`,
    ["1".repeat(64)],
  );
  const artifact = {
    version: "media-timed-lyrics-artifact-v1",
    mode: "word",
    segments: WORDS.map((text, index) => ({
      text,
      start_ms: index * 1000,
      end_ms: index * 1000 + 500,
    })),
  };
  await admin.query(
    `INSERT INTO media_timed_lyrics_artifacts (
       artifact_ref, community_id, actor_user_id, submission_id, operation_id,
       post_id, audio_revision, analysis_revision, artifact_revision,
       canonical_audio_sha256, artifact_sha256, artifact, author_persona_id,
       lyrics_revision
     ) VALUES ('karaoke-artifact','karaoke-community','karaoke-author','karaoke-submission',
       'karaoke-operation','karaoke-post',1,1,1,$1,
       encode(sha256(convert_to($2::jsonb::text,'UTF8')),'hex'),$2::jsonb,
       'karaoke-author-persona',1)`,
    ["1".repeat(64), JSON.stringify(artifact)],
  );
  for (const [index, text] of WORDS.entries()) {
    const ordinal = index + 1;
    await admin.query(
      `INSERT INTO localization_lyric_line_occurrences (
           community_id, post_id, lyric_line_id
         ) VALUES ('karaoke-community','karaoke-post',$1)`,
      [`karaoke-line-${ordinal}`],
    );
    await admin.query(
      `INSERT INTO localization_lyric_line_versions (
           community_id, post_id, lyric_line_id, line_version, canonical_text,
           source_language, source_hash
         ) VALUES ('karaoke-community','karaoke-post',$1,1,$2,'en',$3)`,
      [`karaoke-line-${ordinal}`, text, `${index + 2}`.repeat(64)],
    );
    await admin.query(
      `INSERT INTO localization_lyrics_revision_lines (
           community_id, actor_user_id, post_id, submission_id, lyrics_revision,
           ordinal, lyric_line_id, line_version, source_hash
         ) VALUES ('karaoke-community','karaoke-author','karaoke-post','karaoke-submission',1,
           $1,$2,1,$3)`,
      [ordinal, `karaoke-line-${ordinal}`, `${index + 2}`.repeat(64)],
    );
  }
}

suite("Karaoke persona boundary", () => {
  test("requires an explicitly bound persona at session start with no fallback", async () => {
    if (connectionString === undefined) throw new Error("test URL was not configured");
    const schema = `api_next_karaoke_persona_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const scoped = connectionForSchema(connectionString, schema);
    const admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    try {
      await applyPostgresTestBaselineConnection({ connectionString: scoped });
      await admin.query("SET session_replication_role = replica");
      try {
        await admin.query(
          `INSERT INTO users (user_id) VALUES
             ('karaoke-account'), ('karaoke-foreign-account'), ('karaoke-author')`,
        );
        await admin.query(
          `INSERT INTO communities (
             community_id, display_name, status, created_by_user_id, created_at, updated_at
           ) VALUES ('karaoke-community','Karaoke community','active','karaoke-author',
             clock_timestamp(),clock_timestamp()),
             ('karaoke-other-community','Other community','active','karaoke-author',
             clock_timestamp(),clock_timestamp())`,
        );
        await admin.query(
          `INSERT INTO community_memberships (
             community_id, membership_id, user_id, status, joined_at, created_at, updated_at
           ) VALUES ('karaoke-community','karaoke-membership','karaoke-account','member',
             clock_timestamp(),clock_timestamp(),clock_timestamp())`,
        );
        await admin.query(
          `INSERT INTO personas (
             persona_id, account_id, status, is_first_persona, created_at, retired_at
           ) VALUES
             ('karaoke-persona-bound','karaoke-account','active',false,clock_timestamp(),NULL),
             ('karaoke-persona-unbound','karaoke-account','active',false,clock_timestamp(),NULL),
             ('karaoke-persona-other','karaoke-account','active',false,clock_timestamp(),NULL),
             ('karaoke-persona-suspended','karaoke-account','suspended',false,clock_timestamp(),NULL),
             ('karaoke-persona-retired','karaoke-account','retired',false,clock_timestamp(),
               clock_timestamp()),
             ('karaoke-foreign-persona','karaoke-foreign-account','active',false,
               clock_timestamp(),NULL),
             ('karaoke-author-persona','karaoke-author','active',true,clock_timestamp(),NULL)`,
        );
        await admin.query(
          `INSERT INTO persona_community_bindings (
             persona_id, account_id, community_id, binding_source
           ) VALUES
             ('karaoke-persona-bound','karaoke-account','karaoke-community','first_membership'),
             ('karaoke-persona-other','karaoke-account','karaoke-other-community',
               'first_membership'),
             ('karaoke-author-persona','karaoke-author','karaoke-community','community_creation')`,
        );
        await admin.query(
          `INSERT INTO posts (
             community_id, post_id, author_user_id, author_persona_id, post_type,
             status, visibility, title, created_at, updated_at
           ) VALUES ('karaoke-community','karaoke-post','karaoke-author','karaoke-author-persona',
             'song','published','public','Karaoke song',clock_timestamp(),clock_timestamp())`,
        );
        await admin.query(
          `INSERT INTO media_post_submissions (
             submission_id, community_id, actor_user_id, operation_id, idempotency_key,
             request_hash, title, song_type, start_input, audio_reservation_id,
             creation_revision, audio_revision, analysis_revision, current_analysis_revision,
             current_immutable_ref, status, phase, post_id,
             response_snapshot_bytes, response_snapshot_sha256,
             author_persona_id, lyrics_revision, current_lyrics_revision
           ) VALUES ('karaoke-submission','karaoke-community','karaoke-author','karaoke-operation',
             'karaoke-idempotency',$1,'Karaoke song','original','{}'::jsonb,'karaoke-reservation',
             1,1,1,1,'audio-ref','published',NULL,'karaoke-post',
             convert_to('snapshot','UTF8'),
             encode(sha256(convert_to('snapshot','UTF8')),'hex'),
             'karaoke-author-persona',1,1)`,
          ["3".repeat(64)],
        );
        await seedKaraokeSong(admin);
      } finally {
        await admin.query("SET session_replication_role = origin");
      }

      const repository = makeControlPlaneKaraokeRepository();
      const runtime = makeDirectPostgresControlPlaneLayer(scoped);
      const base = {
        accountId: "karaoke-account",
        artifactId: "karaoke-artifact-id",
        clientContext: undefined,
        communityId: "karaoke-community",
        createdAt: "2026-09-03T12:00:00.000Z",
        expiresAt: "2026-09-03T12:30:00.000Z",
        personaId: "karaoke-persona-bound" as string,
        postId: "karaoke-post",
        requestHash: "a".repeat(64),
        timezone: "UTC",
      } as const;
      const reserve = (overrides: Partial<typeof base> = {}, idempotencyKey = "karaoke-key-1") =>
        Effect.runPromise(
          Effect.scoped(
            repository
              .reserveSession({
                ...base,
                ...overrides,
                attemptId: `karaoke-attempt-${idempotencyKey}`,
                idempotencyKey,
                sessionId: `karaoke-session-${idempotencyKey}`,
              })
              .pipe(Effect.provide(runtime)),
          ),
        );

      const authority = await reserve();
      expect(authority.personaId).toBe("karaoke-persona-bound");
      expect(authority.postId).toBe("karaoke-post");

      const replay = await reserve();
      expect(replay).toMatchObject({ personaId: "karaoke-persona-bound" });
      await expect(reserve({ requestHash: "b".repeat(64) })).rejects.toMatchObject({
        _tag: "KaraokeCommandRejected",
        reason: "idempotency-conflict",
      });

      for (const [label, overrides] of [
        ["unbound persona", { personaId: "karaoke-persona-unbound" }],
        ["wrong-community persona", { personaId: "karaoke-persona-other" }],
        ["suspended persona", { personaId: "karaoke-persona-suspended" }],
        ["retired persona", { personaId: "karaoke-persona-retired" }],
        ["foreign persona", { personaId: "karaoke-foreign-persona" }],
      ] as const) {
        await expect(
          reserve(overrides, `karaoke-reject-${label.replace(/\s+/gu, "-")}`),
        ).rejects.toMatchObject({ _tag: "KaraokeCommandRejected", reason: "invalid-input" });
      }
      const sessions = await admin.query(
        "SELECT persona_id FROM karaoke_sessions ORDER BY created_at, session_id",
      );
      expect(sessions.rows.map((row) => row.persona_id)).toEqual(["karaoke-persona-bound"]);
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      await admin.end();
    }
  });

  test("presents the community activity persona and only community-issued handles on the leaderboard", async () => {
    if (connectionString === undefined) throw new Error("test URL was not configured");
    const schema = `api_next_karaoke_board_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const scoped = connectionForSchema(connectionString, schema);
    const admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    try {
      await applyPostgresTestBaselineConnection({ connectionString: scoped });
      await admin.query("SET session_replication_role = replica");
      try {
        await admin.query(
          `INSERT INTO users (user_id) VALUES
             ('board-account-performer'), ('board-account-plain'), ('board-author')`,
        );
        await admin.query(
          `INSERT INTO communities (
             community_id, display_name, status, created_by_user_id, created_at, updated_at
           ) VALUES ('board-community','Board community','active','board-author',
             clock_timestamp(),clock_timestamp()),
             ('board-other-community','Other community','active','board-author',
             clock_timestamp(),clock_timestamp())`,
        );
        await admin.query(
          `INSERT INTO community_memberships (
             community_id, membership_id, user_id, status, joined_at, created_at, updated_at
           ) VALUES
             ('board-community','board-membership-performer','board-account-performer','member',
               clock_timestamp(),clock_timestamp(),clock_timestamp()),
             ('board-community','board-membership-plain','board-account-plain','member',
               clock_timestamp(),clock_timestamp(),clock_timestamp())`,
        );
        await admin.query(
          `INSERT INTO personas (
             persona_id, account_id, status, is_first_persona, created_at, retired_at
           ) VALUES
             ('board-persona-performer','board-account-performer','active',false,
               clock_timestamp(),NULL),
             ('board-persona-presentation','board-account-performer','active',false,
               clock_timestamp(),NULL),
             ('board-persona-plain','board-account-plain','active',false,
               clock_timestamp(),NULL),
             ('board-author-persona','board-author','active',true,clock_timestamp(),NULL)`,
        );
        await admin.query(
          `INSERT INTO persona_profiles (persona_id, display_name) VALUES
             ('board-persona-performer','Performer Persona'),
             ('board-persona-presentation','Presentation Persona'),
             ('board-persona-plain','Plain Persona')`,
        );
        await admin.query(
          `INSERT INTO persona_community_bindings (
             persona_id, account_id, community_id, binding_source
           ) VALUES
             ('board-persona-performer','board-account-performer','board-community',
               'first_membership'),
             ('board-persona-presentation','board-account-performer','board-community',
               'first_membership'),
             ('board-persona-plain','board-account-plain','board-community','first_membership')`,
        );
        await admin.query(
          `INSERT INTO persona_activity_presentations (
             community_id, account_id, persona_id
           ) VALUES
             ('board-community','board-account-performer','board-persona-presentation'),
             ('board-community','board-account-plain','board-persona-plain')`,
        );
        // The global .pirate grants and the other-community grant must never
        // surface on this community's leaderboard.
        await admin.query(
          `INSERT INTO public_handle_index (
             handle_id, label_normalized, label_display, status, owner_user_id,
             owner_persona_id, platform_handle_id, generation
           ) VALUES
             ('board-pirate-performer','performer','performer.pirate','active',
               'board-account-performer','board-persona-performer','platform-1',1),
             ('board-pirate-plain','plain','plain.pirate','active',
               'board-account-plain','board-persona-plain','platform-2',1)`,
        );
        await admin.query(
          `INSERT INTO handle_grants (
             grant_id, grant_generation, community_id, offering_id, offering_hash, claim_id,
             owner_account_id, owner_persona_id, sale_namespace_activation_id,
             sale_namespace_activation_generation, fulfillment_kind, family, namespace_root,
             handle_label, display_identifier, status, issued_at, updated_at
           ) VALUES
             ('board-grant-community',1,'board-community','board-community-offering',
               '${"5".repeat(64)}','board-claim-1','board-account-performer',
               'board-persona-presentation','board-activation',1,'hosted_persona_v1','hns',
               'board','presentation','presentation.board','active',clock_timestamp(),
               clock_timestamp()),
             ('board-grant-foreign',1,'board-other-community','board-other-community-offering',
               '${"6".repeat(64)}','board-claim-2','board-account-plain',
               'board-persona-plain','board-activation',1,'hosted_persona_v1','hns',
               'board','plain','plain.board','active',clock_timestamp(),clock_timestamp())`,
        );
        await admin.query(
          `INSERT INTO posts (
             community_id, post_id, author_user_id, author_persona_id, post_type,
             status, visibility, title, created_at, updated_at
           ) VALUES ('board-community','board-post','board-author','board-author-persona',
             'song','published','public','Board song',clock_timestamp(),clock_timestamp())`,
        );
        const session = (accountId: string, personaId: string, suffix: string) =>
          admin.query(
            `INSERT INTO karaoke_sessions (
               session_id, attempt_id, account_id, persona_id, community_id, post_id,
               audio_revision, lyrics_revision, karaoke_revision_id,
               qualification_policy_version_id, idempotency_key, request_hash, timezone,
               created_at, expires_at, playback_kind, scoring_version, scoring_provider,
               scoring_model, line_snapshot, client_context
             ) VALUES ($1,$2,$3,$4,'board-community','board-post',1,1,'board-revision',
               'karaoke_qualification_v2@1',$5,$6,'UTC',clock_timestamp(),
               clock_timestamp() + interval '1 hour','full_mix',5,'elevenlabs',
               'scribe_v2_realtime','[{"id":"board-line","index":0}]'::jsonb,NULL)`,
            [
              `board-session-${suffix}`,
              `board-attempt-${suffix}`,
              accountId,
              personaId,
              `board-key-${suffix}`,
              "0".repeat(64),
            ],
          );
        await session("board-account-performer", "board-persona-performer", "performer");
        await session("board-account-plain", "board-persona-plain", "plain");
        await admin.query(
          `INSERT INTO karaoke_attempts (
             attempt_id, session_id, completion_reason, scoring_version, scoring_provider,
             scoring_model, final_score_bps, scored_line_count, line_count,
             evidence_summary, completed_at, created_at, lyrics_score_bps,
             timing_score_bps, timing_trend,
             uncertain_line_count, no_recognition_line_count, low_confidence_line_count,
             scoring_diagnostics, transport_facts
           ) VALUES
             ('board-attempt-performer','board-session-performer','completed',5,'elevenlabs',
               'scribe_v2_realtime',9500,1,1,'{}'::jsonb,clock_timestamp(),clock_timestamp(),
               9500,9500,'on_time',0,0,0,'{}'::jsonb,'{}'::jsonb),
             ('board-attempt-plain','board-session-plain','completed',5,'elevenlabs',
               'scribe_v2_realtime',8000,1,1,'{}'::jsonb,clock_timestamp(),clock_timestamp(),
               8000,8000,'on_time',0,0,0,'{}'::jsonb,'{}'::jsonb)`,
        );
        await admin.query(
          `INSERT INTO activity_qualifications (
             qualification_id, account_id, persona_id, community_id, post_id, audio_revision,
             activity_key, karaoke_session_id, karaoke_attempt_id, score_bps,
             qualification_policy_version_id, qualified_at, streak_day, evidence_summary
           ) VALUES
             ('board-qualification-performer','board-account-performer',
               'board-persona-performer','board-community','board-post',1,'karaoke',
               'board-session-performer','board-attempt-performer',9500,
               'karaoke_qualification_v2@1',clock_timestamp(),
               (clock_timestamp() AT TIME ZONE 'UTC')::date,'{}'::jsonb),
             ('board-qualification-plain','board-account-plain','board-persona-plain',
               'board-community','board-post',1,'karaoke','board-session-plain',
               'board-attempt-plain',8000,'karaoke_qualification_v2@1',clock_timestamp(),
               (clock_timestamp() AT TIME ZONE 'UTC')::date,'{}'::jsonb)`,
        );
      } finally {
        await admin.query("SET session_replication_role = origin");
      }

      const repository = makeControlPlaneKaraokeRepository();
      const leaderboard = await Effect.runPromise(
        Effect.scoped(
          repository
            .getLeaderboard({
              accountId: "board-unmatched-viewer",
              communityId: "board-community",
              limit: 10,
              postId: "board-post",
            })
            .pipe(Effect.provide(makeDirectPostgresControlPlaneLayer(scoped))),
        ),
      );
      expect(leaderboard.total_ranked).toBe(2);
      expect(leaderboard.entries.map((entry) => entry.rank)).toEqual([1, 2]);
      expect(leaderboard.entries.map((entry) => entry.identity.display_name)).toEqual([
        "Presentation Persona",
        "Plain Persona",
      ]);
      expect(leaderboard.entries.map((entry) => entry.identity.handle)).toEqual([
        "presentation.board",
        null,
      ]);
      expect(JSON.stringify(leaderboard)).not.toContain("performer.pirate");
      expect(JSON.stringify(leaderboard)).not.toContain("plain.pirate");
      expect(JSON.stringify(leaderboard)).not.toContain("plain.board");
      expect(JSON.stringify(leaderboard)).not.toContain("board-account");
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      await admin.end();
    }
  });
});
