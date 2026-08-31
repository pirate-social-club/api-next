import { afterAll, describe, expect, test } from "bun:test";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { activatePendingPersonaFixtures } from "./persona-wallet.pg-fixture.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;
const sentinelPath =
  process.env.CONTROL_PLANE_POSTGRES_REWARDS_QUALIFICATION_TEST_SENTINEL ??
  "/tmp/api-next-control-plane-postgres-rewards-qualification-suite-complete";
const sentinelContents = "api-next-control-plane-postgres-rewards-qualification-suite-complete\n";
const testCount = 5;
let completedTestCount = 0;

const schemaIdentifier = (): string =>
  `api_next_rewards_${crypto.randomUUID().replaceAll("-", "")}`;
const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const connectionForSchema = (raw: string, schema: string): string => {
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
};

async function withSchema<A>(use: (admin: Client) => Promise<A>): Promise<A> {
  if (connectionString === undefined) throw new Error("test URL was not configured");
  const schema = schemaIdentifier();
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
  const scopedConnection = connectionForSchema(connectionString, schema);
  try {
    await applyPostgresTestBaselineConnection({ connectionString: scopedConnection });
    return await use(admin);
  } finally {
    await admin.query("ROLLBACK");
    await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

async function seedAccountSong(
  admin: Client,
  suffix: string,
): Promise<{
  readonly accountId: string;
  readonly communityId: string;
  readonly personaId: string;
  readonly postId: string;
}> {
  const accountId = `account-${suffix}`;
  const communityId = `community-${suffix}`;
  const postId = `post-${suffix}`;
  await admin.query(
    `INSERT INTO users (user_id, status, account, created_at)
     VALUES ($1, 'active', '{}'::jsonb, clock_timestamp() - interval '30 days')`,
    [accountId],
  );
  await activatePendingPersonaFixtures(admin);
  const firstPersona = await admin.query<{ readonly persona_id: string }>(
    `SELECT persona_id FROM personas
      WHERE account_id=$1 AND is_first_persona`,
    [accountId],
  );
  const personaId = firstPersona.rows[0]?.persona_id;
  if (personaId === undefined) throw new Error("first persona was not provisioned");
  await admin.query(`UPDATE persona_profiles SET display_name=$2 WHERE persona_id=$1`, [
    personaId,
    `Persona ${suffix}`,
  ]);
  await admin.query(
    `INSERT INTO communities (
       community_id, display_name, status, created_by_user_id, created_at, updated_at
     ) VALUES ($1, $2, 'active', $3, clock_timestamp() - interval '20 days',
       clock_timestamp() - interval '20 days')`,
    [communityId, `Community ${suffix}`, accountId],
  );
  await admin.query(
    `INSERT INTO community_memberships (
       community_id, membership_id, user_id, status, joined_at, created_at, updated_at
     ) VALUES ($1, $2, $3, 'member', clock_timestamp() - interval '19 days',
       clock_timestamp() - interval '19 days', clock_timestamp() - interval '19 days')`,
    [communityId, `membership-${suffix}`, accountId],
  );
  await admin.query(
    `INSERT INTO posts (
       community_id, post_id, author_user_id, author_persona_id, post_type,
       status, visibility, title, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, 'song', 'published', 'public', $5,
       clock_timestamp() - interval '10 days', clock_timestamp() - interval '10 days')`,
    [communityId, postId, accountId, personaId, `Song ${suffix}`],
  );
  await admin.query(
    `INSERT INTO account_streak_clocks (
       account_id, timezone, timezone_updated_at, next_change_allowed_at
     ) VALUES ($1, 'UTC', statement_timestamp() - interval '8 days',
       statement_timestamp() - interval '1 day')`,
    [accountId],
  );
  return { accountId, communityId, personaId, postId };
}

const hash = (character: string): string => character.repeat(64);

suite("Postgres 17 activity qualification persistence", () => {
  test("seeds an open registry with active typed policies and reserved Dance", async () => {
    await withSchema(async (admin) => {
      const registry = await admin.query<{
        readonly activity_key: string;
        readonly status: string;
        readonly current_policy_version_id: string | null;
      }>(
        `SELECT activity_key, status, current_policy_version_id
           FROM activity_registry ORDER BY activity_key`,
      );
      expect(registry.rows).toEqual([
        { activity_key: "dance", status: "reserved", current_policy_version_id: null },
        {
          activity_key: "karaoke",
          status: "active",
          current_policy_version_id: "karaoke_qualification_v2@1",
        },
        {
          activity_key: "study",
          status: "active",
          current_policy_version_id: "study_session_first_pass_v2@1",
        },
      ]);
      await expect(
        admin.query(
          `UPDATE qualification_policy_versions
              SET policy_document='{"required_correct_bps": 1}'::jsonb
            WHERE qualification_policy_version_id='study_session_first_pass_v2@1'`,
        ),
      ).rejects.toMatchObject({ message: expect.stringContaining("append-only") });
    });
    completedTestCount += 1;
  });

  test("enforces an account-pinned IANA timezone with a prospective seven-day CAS", async () => {
    await withSchema(async (admin) => {
      const { accountId } = await seedAccountSong(admin, "clock");
      await admin.query(
        `UPDATE account_streak_clocks
            SET timezone='America/New_York',
                timezone_updated_at=statement_timestamp(),
                next_change_allowed_at=statement_timestamp() + interval '7 days'
          WHERE account_id=$1`,
        [accountId],
      );
      await expect(
        admin.query(
          `UPDATE account_streak_clocks
              SET timezone='Asia/Tbilisi',
                  timezone_updated_at=statement_timestamp(),
                  next_change_allowed_at=statement_timestamp() + interval '7 days'
            WHERE account_id=$1`,
          [accountId],
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining("outside its prospective window"),
      });
      await expect(
        admin.query(
          `INSERT INTO account_streak_clocks (
             account_id, timezone, timezone_updated_at, next_change_allowed_at
           ) VALUES ('missing-account', 'Not/A_Zone', clock_timestamp(),
             statement_timestamp() + interval '7 days')`,
        ),
      ).rejects.toBeDefined();
    });
    completedTestCount += 1;
  });

  test("grades frozen Study items and permits only the exact qualifying reducer output", async () => {
    await withSchema(async (admin) => {
      const identity = await seedAccountSong(admin, "study");
      const createdAt = new Date(Date.now() - 60_000).toISOString();
      const completedAt = new Date().toISOString();
      await admin.query(
        `INSERT INTO study_sessions (
           session_id, account_id, persona_id, community_id, post_id,
           audio_revision, lyrics_revision, source_revision,
           source_producer_id, source_producer_revision, source_snapshot_hash,
           qualification_policy_version_id, idempotency_key, request_hash,
           timezone, qualifying_exercise_count, required_correct, created_at
         ) VALUES (
           'study-session-1', $1, $2, $3, $4, 3, 2, 4,
           'study-producer', 'prompt-policy-v2', $5,
           'study_session_first_pass_v2@1', 'study-start-1', $6,
           'UTC', 2, 2, $7
         )`,
        [
          identity.accountId,
          identity.personaId,
          identity.communityId,
          identity.postId,
          hash("a"),
          hash("b"),
          createdAt,
        ],
      );
      await admin.query(
        `INSERT INTO study_session_items (
           session_id, session_item_id, ordinal, source_item_key, prompt, answer_key
         ) VALUES
         (
           'study-session-1', 'study-item-1', 0, 'source-item-1',
           '{"kind":"text_response","text":"Repeat the line"}'::jsonb,
           '{"kind":"text_response","comparison":"unicode_casefold_whitespace_v1","accepted_answers":["Sail away"]}'::jsonb
         ),
         (
           'study-session-1', 'study-item-2', 1, 'source-item-2',
           '{"kind":"single_select","text":"Pick the line","choices":[{"choice_key":"a","text":"Moon"},{"choice_key":"b","text":"Sea"}]}'::jsonb,
           '{"kind":"single_select","correct_choice_key":"b"}'::jsonb
         )`,
      );
      await expect(
        admin.query(
          `INSERT INTO study_session_answers (
             answer_id, session_id, session_item_id, attempt_number, idempotency_key,
             request_hash, answer, outcome, first_pass, answered_at
           ) VALUES (
             'study-answer-bad', 'study-session-1', 'study-item-1', 1, 'bad-outcome', $1,
             '{"kind":"text_response","text":"sail away"}'::jsonb,
             'incorrect', true, $2
           )`,
          [hash("c"), completedAt],
        ),
      ).rejects.toMatchObject({ message: expect.stringContaining("not server-derived") });
      await admin.query("BEGIN");
      try {
        await admin.query(
          `INSERT INTO study_session_answers (
             answer_id, session_id, session_item_id, attempt_number, idempotency_key,
             request_hash, answer, outcome, first_pass, answered_at
           ) VALUES (
             'study-answer-1', 'study-session-1', 'study-item-1', 1, 'answer-1', $1,
             '{"kind":"text_response","text":"  SAIL   AWAY "}'::jsonb,
             'correct', true, $2
           )`,
          [hash("d"), completedAt],
        );
        await admin.query(
          `UPDATE study_session_items
              SET answer_count=1, first_pass_outcome='correct'
            WHERE session_id='study-session-1' AND session_item_id='study-item-1'`,
        );
        await admin.query(
          `INSERT INTO study_session_answers (
             answer_id, session_id, session_item_id, attempt_number, idempotency_key,
             request_hash, answer, outcome, first_pass, answered_at
           ) VALUES (
             'study-answer-2', 'study-session-1', 'study-item-2', 1, 'answer-2', $1,
             '{"kind":"single_select","choice_key":"b"}'::jsonb,
             'correct', true, $2
           )`,
          [hash("e"), completedAt],
        );
        await admin.query(
          `UPDATE study_session_items
              SET answer_count=1, first_pass_outcome='correct'
            WHERE session_id='study-session-1' AND session_item_id='study-item-2'`,
        );
        await admin.query(
          `UPDATE study_sessions
              SET status='completed', answered_exercise_count=2,
                  first_pass_correct=2, score_bps=10000,
                  streak_day=($1::timestamptz AT TIME ZONE timezone)::date,
                  completed_at=$1
            WHERE session_id='study-session-1'`,
          [completedAt],
        );
        await admin.query(
          `INSERT INTO activity_qualifications (
             qualification_id, account_id, persona_id, community_id, post_id,
             audio_revision, activity_key, study_session_id, score_bps,
             qualification_policy_version_id, qualified_at, streak_day,
             evidence_summary, created_at
           ) VALUES (
             'qualification-study-1', $1, $2, $3, $4, 3, 'study',
             'study-session-1', 10000, 'study_session_first_pass_v2@1',
             $5, ($5::timestamptz AT TIME ZONE 'UTC')::date,
             '{"kind":"study_session_first_pass_v2","qualifying_exercise_count":2,"first_pass_correct":2,"required_correct":2}'::jsonb,
             $5
           )`,
          [
            identity.accountId,
            identity.personaId,
            identity.communityId,
            identity.postId,
            completedAt,
          ],
        );
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
      await expect(
        admin.query(
          `INSERT INTO activity_qualifications (
             qualification_id, account_id, persona_id, community_id, post_id,
             audio_revision, activity_key, study_session_id, score_bps,
             qualification_policy_version_id, qualified_at, streak_day,
             evidence_summary, created_at
           ) SELECT 'qualification-study-forged', account_id, persona_id,
             community_id, post_id, audio_revision, 'study', session_id, 9999,
             qualification_policy_version_id, completed_at, streak_day,
             '{"kind":"study_session_first_pass_v2","qualifying_exercise_count":2,"first_pass_correct":2,"required_correct":2}'::jsonb,
             clock_timestamp()
             FROM study_sessions WHERE session_id='study-session-1'`,
        ),
      ).rejects.toMatchObject({ message: expect.stringContaining("not exact reducer output") });
      const stored = await admin.query(
        `SELECT qualification_id, reward_period_key, streak_day
           FROM activity_qualifications WHERE study_session_id='study-session-1'`,
      );
      expect(stored.rows).toHaveLength(1);
    });
    completedTestCount += 1;
  });

  test("binds Karaoke terminal evidence and rejects below-policy qualifications", async () => {
    await withSchema(async (admin) => {
      const identity = await seedAccountSong(admin, "karaoke");
      const createdAt = new Date(Date.now() - 60_000).toISOString();
      const completedAt = new Date().toISOString();
      await admin.query(
        `INSERT INTO karaoke_sessions (
           session_id, attempt_id, account_id, persona_id, community_id, post_id,
           audio_revision, lyrics_revision, line_snapshot,
           karaoke_revision_id, qualification_policy_version_id,
           idempotency_key, request_hash, timezone, created_at, expires_at
         ) VALUES (
           'karaoke-session-1', 'karaoke-attempt-1', $1, $2, $3, $4,
           3, 1, '[{}]'::jsonb, 'karaoke-revision-1', 'karaoke_qualification_v1@1',
           'karaoke-start-1', $5, 'UTC', $6, $6::timestamptz + interval '10 minutes'
         )`,
        [
          identity.accountId,
          identity.personaId,
          identity.communityId,
          identity.postId,
          hash("f"),
          createdAt,
        ],
      );
      const evidence = {
        kind: "karaoke_qualification_v1",
        scored_line_count: 5,
        line_count: 5,
        coverage_bps: 10_000,
        final_score_bps: 8_000,
        scoring_version: 1,
        scoring_provider: "provider-v1",
        karaoke_revision_id: "karaoke-revision-1",
      };
      await admin.query(
        `INSERT INTO karaoke_attempts (
           attempt_id, session_id, completion_reason, scoring_version,
           scoring_provider, scoring_model, final_score_bps,
           scored_line_count, line_count, evidence_summary, completed_at, created_at,
           lyrics_score_bps, timing_score_bps, timing_trend, uncertain_line_count,
           no_recognition_line_count, low_confidence_line_count,
           scoring_diagnostics, transport_facts
         ) VALUES (
           'karaoke-attempt-1', 'karaoke-session-1', 'completed', 1,
           'provider-v1', 'model-v1', 8000, 5, 5, $1::jsonb, $2, $3,
           8000, 8000, 'on_time', 0, 0, 0,
           '{"schema_version":1,"scoring_version":1,"line_diagnostics":[]}'::jsonb,
           '{"schema_version":1}'::jsonb
         )`,
        [JSON.stringify(evidence), completedAt, createdAt],
      );
      await admin.query(
        `UPDATE karaoke_sessions SET status='completed', completed_at=$1
          WHERE session_id='karaoke-session-1'`,
        [completedAt],
      );
      await admin.query(
        `INSERT INTO activity_qualifications (
           qualification_id, account_id, persona_id, community_id, post_id,
           audio_revision, activity_key, karaoke_session_id, karaoke_attempt_id,
           score_bps, qualification_policy_version_id, qualified_at,
           streak_day, evidence_summary, created_at
         ) VALUES (
           'qualification-karaoke-1', $1, $2, $3, $4, 3, 'karaoke',
           'karaoke-session-1', 'karaoke-attempt-1', 8000,
           'karaoke_qualification_v1@1', $5,
           ($5::timestamptz AT TIME ZONE 'UTC')::date, $6::jsonb, $5
         )`,
        [
          identity.accountId,
          identity.personaId,
          identity.communityId,
          identity.postId,
          completedAt,
          JSON.stringify(evidence),
        ],
      );
      await expect(
        admin.query(
          `UPDATE karaoke_attempts SET final_score_bps=10000
            WHERE attempt_id='karaoke-attempt-1'`,
        ),
      ).rejects.toMatchObject({ message: expect.stringContaining("append-only") });
      const stored = await admin.query(
        `SELECT qualification_id, score_bps FROM activity_qualifications
          WHERE karaoke_attempt_id='karaoke-attempt-1'`,
      );
      expect(stored.rows).toEqual([
        { qualification_id: "qualification-karaoke-1", score_bps: 8000 },
      ]);
    });
    completedTestCount += 1;
  });

  test("keeps full-mix qualification reversible through immutable v2 policy rows", async () => {
    await withSchema(async (admin) => {
      const identity = await seedAccountSong(admin, "karaoke-v2");
      const createdAt = new Date(Date.now() - 60_000).toISOString();
      const completedAt = new Date().toISOString();
      await admin.query(
        `INSERT INTO qualification_policy_versions (
           qualification_policy_version_id, activity_key, policy_kind, policy_document
         ) VALUES (
           'karaoke_qualification_v2@test-instrumental-only', 'karaoke',
           'karaoke_qualification_v2',
           '{"minimum_scored_line_count":5,"minimum_coverage_bps":8500,"minimum_final_score_bps":7000,"eligible_playback_kinds":["instrumental"]}'::jsonb
         )`,
      );
      const createAttempt = async (suffix: string, policyId: string, hashCharacter: string) => {
        const sessionId = `karaoke-v2-session-${suffix}`;
        const attemptId = `karaoke-v2-attempt-${suffix}`;
        await admin.query(
          `INSERT INTO karaoke_sessions (
             session_id, attempt_id, account_id, persona_id, community_id, post_id,
             audio_revision, lyrics_revision, line_snapshot,
             karaoke_revision_id, qualification_policy_version_id,
             idempotency_key, request_hash, timezone, playback_kind, created_at, expires_at
           ) VALUES ($1,$2,$3,$4,$5,$6,1,1,'[{}]'::jsonb,$7,$8,$9,$10,'UTC','full_mix',$11,$11::timestamptz + interval '10 minutes')`,
          [
            sessionId,
            attemptId,
            identity.accountId,
            identity.personaId,
            identity.communityId,
            identity.postId,
            `karaoke-revision-${suffix}`,
            policyId,
            `idem-${suffix}`,
            hash(hashCharacter),
            createdAt,
          ],
        );
        const evidence = {
          kind: "karaoke_qualification_v2",
          scored_line_count: 5,
          line_count: 5,
          coverage_bps: 10_000,
          final_score_bps: 8_000,
          scoring_version: 1,
          scoring_provider: "provider-v1",
          karaoke_revision_id: `karaoke-revision-${suffix}`,
          playback_kind: "full_mix",
        };
        await admin.query(
          `INSERT INTO karaoke_attempts (
             attempt_id, session_id, completion_reason, scoring_version,
             scoring_provider, scoring_model, final_score_bps, scored_line_count,
             line_count, evidence_summary, completed_at, created_at,
             lyrics_score_bps, timing_score_bps, timing_trend, uncertain_line_count,
             no_recognition_line_count, low_confidence_line_count,
             scoring_diagnostics, transport_facts
           ) VALUES ($1,$2,'completed',1,'provider-v1','model-v1',8000,5,5,$3::jsonb,$4,$5,
             8000,8000,'on_time',0,0,0,
             '{"schema_version":1,"scoring_version":1,"line_diagnostics":[]}'::jsonb,
             '{"schema_version":1}'::jsonb)`,
          [attemptId, sessionId, JSON.stringify(evidence), completedAt, createdAt],
        );
        await admin.query(
          "UPDATE karaoke_sessions SET status='completed', completed_at=$1 WHERE session_id=$2",
          [completedAt, sessionId],
        );
        return { attemptId, evidence, sessionId };
      };
      const eligible = await createAttempt("eligible", "karaoke_qualification_v2@1", "a");
      const excluded = await createAttempt(
        "excluded",
        "karaoke_qualification_v2@test-instrumental-only",
        "b",
      );
      const insertQualification = (suffix: string, attempt: typeof eligible) =>
        admin.query(
          `INSERT INTO activity_qualifications (
             qualification_id, account_id, persona_id, community_id, post_id,
             audio_revision, activity_key, karaoke_session_id, karaoke_attempt_id,
             score_bps, qualification_policy_version_id, qualified_at,
             streak_day, evidence_summary, created_at
           ) SELECT $1, account_id, persona_id, community_id, post_id,
             audio_revision, 'karaoke', session_id, attempt_id, 8000,
             qualification_policy_version_id, $2,
             ($2::timestamptz AT TIME ZONE timezone)::date, $3::jsonb, $2
             FROM karaoke_sessions WHERE session_id=$4`,
          [
            `qualification-karaoke-v2-${suffix}`,
            completedAt,
            JSON.stringify(attempt.evidence),
            attempt.sessionId,
          ],
        );
      await insertQualification("eligible", eligible);
      await expect(insertQualification("excluded", excluded)).rejects.toMatchObject({
        message: expect.stringContaining("not exact reducer output"),
      });
      const stored = await admin.query(
        "SELECT qualification_id FROM activity_qualifications WHERE karaoke_attempt_id=$1",
        [eligible.attemptId],
      );
      expect(stored.rows).toEqual([{ qualification_id: "qualification-karaoke-v2-eligible" }]);
    });
    completedTestCount += 1;
  });
});

afterAll(async () => {
  if (required && completedTestCount === testCount) {
    await Bun.write(sentinelPath, sentinelContents);
  }
});
