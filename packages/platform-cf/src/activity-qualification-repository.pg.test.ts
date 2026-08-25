import { afterAll, describe, expect, test } from "bun:test";
import {
  Clock,
  IdGen,
  makeActivityQualificationService,
  StudyItemSource,
  type StudyItemSourceSetV1,
} from "@pirate/application";
import { Effect } from "effect";
import { Client } from "pg";
import { loadPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import { makeControlPlaneActivityQualificationStore } from "./activity-qualification-repository.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { applyPostgresMigrations } from "./postgres-migrations.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;
const migrations = await loadPostgresMigrations();

const schemaIdentifier = (): string =>
  `api_next_rewards_repository_${crypto.randomUUID().replaceAll("-", "")}`;
const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const connectionForSchema = (raw: string, schema: string): string => {
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
};

async function withSchema<A>(
  use: (input: { readonly admin: Client; readonly scopedConnection: string }) => Promise<A>,
): Promise<A> {
  if (connectionString === undefined) throw new Error("test URL was not configured");
  const schema = schemaIdentifier();
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
  const scopedConnection = connectionForSchema(connectionString, schema);
  try {
    await Effect.runPromise(
      Effect.scoped(
        applyPostgresMigrations(migrations).pipe(
          Effect.provide(makeDirectPostgresControlPlaneLayer(scopedConnection)),
        ),
      ),
    );
    return await use({ admin, scopedConnection });
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
     VALUES ($1, 'active', '{}'::jsonb, '2026-08-01T00:00:00.000Z')`,
    [accountId],
  );
  const firstPersona = await admin.query<{ readonly persona_id: string }>(
    `SELECT persona_id FROM personas WHERE account_id=$1 AND is_first_persona`,
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
     ) VALUES ($1,$2,'active',$3,'2026-08-02T00:00:00.000Z','2026-08-02T00:00:00.000Z')`,
    [communityId, `Community ${suffix}`, accountId],
  );
  await admin.query(
    `INSERT INTO community_memberships (
       community_id, membership_id, user_id, status, joined_at, created_at, updated_at
     ) VALUES ($1,$2,$3,'member','2026-08-03T00:00:00.000Z',
       '2026-08-03T00:00:00.000Z','2026-08-03T00:00:00.000Z')`,
    [communityId, `membership-${suffix}`, accountId],
  );
  await admin.query(
    `INSERT INTO posts (
       community_id, post_id, author_user_id, author_persona_id, post_type,
       status, visibility, title, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,'song','published','public',$5,
       '2026-08-04T00:00:00.000Z','2026-08-04T00:00:00.000Z')`,
    [communityId, postId, accountId, personaId, `Song ${suffix}`],
  );
  await admin.query("SET session_replication_role = replica");
  try {
    await admin.query(
      `INSERT INTO media_publication_projections (
         submission_id, community_id, actor_user_id, operation_id, post_id,
         creation_revision, audio_revision, analysis_revision, decision_revision,
         canonical_audio_sha256, title, audio_asset_ref, language_status,
         lyrics_explicitness, alignment, data_registration, locked_delivery,
         projected_at, author_persona_id, lyrics_status, lyrics_revision, lyrics_text
       ) VALUES (
         $1,$2,$3,$4,$5,1,3,1,1,$6,$7,$8,'ready','not_explicit','ready',
         'registered','not_required','2026-08-04T00:00:00.000Z',$9,'ready',2,$10
       )`,
      [
        `submission-${suffix}`,
        communityId,
        accountId,
        `operation-${suffix}`,
        postId,
        "a".repeat(64),
        `Song ${suffix}`,
        `r2://audio-${suffix}`,
        personaId,
        "Sail away",
      ],
    );
  } finally {
    await admin.query("SET session_replication_role = origin");
  }
  return { accountId, communityId, personaId, postId };
}

const sourceFor = (identity: {
  readonly communityId: string;
  readonly postId: string;
}): StudyItemSourceSetV1 => ({
  version: "study_item_source_v1",
  song_revision: {
    community_id: identity.communityId,
    post_id: identity.postId,
    audio_revision: 3,
    lyrics_revision: 2,
  },
  source_revision: 1,
  provenance: {
    kind: "accepted_song_lyrics",
    producer_id: "study-producer",
    producer_revision: "prompt-policy-v1",
  },
  items: [
    {
      source_item_key: "line-1",
      prompt: { kind: "text_response", text: "Repeat the line" },
      answer_key: {
        kind: "text_response",
        comparison: "unicode_casefold_whitespace_v1",
        accepted_answers: ["Sail away"],
      },
    },
  ],
});

const provideServices =
  (ids: string[], source: StudyItemSourceSetV1, now: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(Clock, { now: Effect.succeed(Date.parse(now)) }),
      Effect.provideService(IdGen, {
        next: Effect.sync(() => {
          const id = ids.shift();
          if (id === undefined) throw new Error("test identifier sequence exhausted");
          return id;
        }),
      }),
      Effect.provideService(StudyItemSource, {
        getForAcceptedSongRevision: () => Effect.succeed(source),
      }),
    );

suite("Postgres 17 activity qualification repository", () => {
  test("freezes Study evidence, replays commands, and emits one account day", async () => {
    await withSchema(async ({ admin, scopedConnection }) => {
      const identity = await seedAccountSong(admin, "repository");
      const source = sourceFor(identity);
      const store = makeControlPlaneActivityQualificationStore(
        makeDirectPostgresControlPlaneLayer(scopedConnection),
      );
      const service = makeActivityQualificationService(store);
      const startInput = {
        accountId: identity.accountId,
        communityId: identity.communityId,
        idempotencyKey: "start-1",
        personaId: identity.personaId,
        postId: identity.postId,
        requestedTimezone: "UTC",
      } as const;
      const start = () =>
        Effect.runPromise(
          provideServices(
            ["session-1", "item-1"],
            source,
            "2026-08-25T12:00:00.000Z",
          )(service.startStudySession(startInput)),
        );
      const session = await start();
      expect(session).toMatchObject({
        status: "active",
        streak_day: null,
        items: [{ session_item_id: "study_item_item-1", answer_count: 0 }],
      });
      expect(JSON.stringify(session)).not.toContain("answer_key");
      await expect(start()).resolves.toEqual(session);

      const submission = {
        accountId: identity.accountId,
        answer: { kind: "text_response" as const, text: "  SAIL   AWAY " },
        attemptNumber: 1,
        communityId: identity.communityId,
        idempotencyKey: "answer-1",
        sessionId: session.session_id,
        sessionItemId: session.items[0]?.session_item_id ?? "missing",
      };
      const result = await Effect.runPromise(
        provideServices(
          ["answer-1", "qualification-1"],
          source,
          "2026-08-25T12:05:00.000Z",
        )(service.submitStudyAnswer(submission)),
      );
      expect(result).toMatchObject({
        outcome: "correct",
        first_pass: true,
        session: {
          status: "completed",
          streak_day: "2026-08-25",
          progress: { score_bps: 10_000 },
          qualification: { activity: "study", persona_id: identity.personaId },
        },
      });
      const replay = await Effect.runPromise(
        provideServices(
          ["discarded-answer", "discarded-qualification"],
          source,
          "2026-08-25T12:06:00.000Z",
        )(service.submitStudyAnswer(submission)),
      );
      expect(replay).toEqual(result);

      const secondPersonaId = `persona-${crypto.randomUUID()}`;
      await admin.query(
        `INSERT INTO personas (
           persona_id, account_id, status, is_first_persona, created_at, retired_at
         ) VALUES ($1,$2,'active',false,'2026-08-10T00:00:00.000Z',NULL)`,
        [secondPersonaId, identity.accountId],
      );
      await admin.query(
        `INSERT INTO persona_profiles (
           persona_id, revision, display_name, created_at, updated_at
         ) VALUES ($1,1,'Second Persona','2026-08-10T00:00:00.000Z',
           '2026-08-10T00:00:00.000Z')`,
        [secondPersonaId],
      );
      const secondSession = await Effect.runPromise(
        provideServices(
          ["session-2", "item-2"],
          source,
          "2026-08-25T12:10:00.000Z",
        )(
          service.startStudySession({
            ...startInput,
            idempotencyKey: "start-2",
            personaId: secondPersonaId,
            requestedTimezone: null,
          }),
        ),
      );
      await Effect.runPromise(
        provideServices(
          ["answer-2", "qualification-2"],
          source,
          "2026-08-25T12:15:00.000Z",
        )(
          service.submitStudyAnswer({
            ...submission,
            idempotencyKey: "answer-2",
            sessionId: secondSession.session_id,
            sessionItemId: secondSession.items[0]?.session_item_id ?? "missing",
          }),
        ),
      );
      const presentation = await Effect.runPromise(
        provideServices(
          [],
          source,
          "2026-08-25T12:16:00.000Z",
        )(
          service.setPresentationPersona({
            accountId: identity.accountId,
            communityId: identity.communityId,
            idempotencyKey: "presentation-2",
            personaId: secondPersonaId,
          }),
        ),
      );
      expect(presentation.persona_id).toBe(secondPersonaId);

      const counts = await admin.query<{
        readonly answers: string;
        readonly activity_count: string;
        readonly qualifications: string;
        readonly song_days: string;
        readonly community_days: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM study_session_answers) AS answers,
           (SELECT count(*)::text FROM activity_qualifications) AS qualifications,
           (SELECT count(*)::text FROM song_streak_days) AS song_days,
           (SELECT count(*)::text FROM community_streak_days) AS community_days,
           (SELECT qualification_count::text FROM song_streak_day_activities) AS activity_count`,
      );
      expect(counts.rows[0]).toEqual({
        answers: "2",
        qualifications: "2",
        song_days: "1",
        community_days: "1",
        activity_count: "2",
      });

      const leaderboard = await Effect.runPromise(
        provideServices(
          [],
          source,
          "2026-08-25T12:06:00.000Z",
        )(
          service.getSongLeaderboard({
            accountId: identity.accountId,
            communityId: identity.communityId,
            postId: identity.postId,
          }),
        ),
      );
      expect(leaderboard.entries).toHaveLength(1);
      expect(leaderboard.entries[0]).toMatchObject({
        rank: 1,
        current: 1,
        persona: { persona_id: secondPersonaId, display_name: "Second Persona" },
        is_viewer: true,
      });
      expect(JSON.stringify(leaderboard)).not.toContain(identity.accountId);
    });
  });

  test("serializes concurrent finalization and keeps timezone updates prospective", async () => {
    await withSchema(async ({ admin, scopedConnection }) => {
      const identity = await seedAccountSong(admin, "concurrent");
      const source = sourceFor(identity);
      const store = makeControlPlaneActivityQualificationStore(
        makeDirectPostgresControlPlaneLayer(scopedConnection),
      );
      const service = makeActivityQualificationService(store);
      const session = await Effect.runPromise(
        provideServices(
          ["session-concurrent", "item-concurrent"],
          source,
          "2026-08-25T13:00:00.000Z",
        )(
          service.startStudySession({
            accountId: identity.accountId,
            communityId: identity.communityId,
            idempotencyKey: "start-concurrent",
            personaId: identity.personaId,
            postId: identity.postId,
            requestedTimezone: "UTC",
          }),
        ),
      );
      const answerInput = {
        accountId: identity.accountId,
        answer: { kind: "text_response" as const, text: "Sail away" },
        attemptNumber: 1,
        communityId: identity.communityId,
        idempotencyKey: "answer-concurrent",
        sessionId: session.session_id,
        sessionItemId: session.items[0]?.session_item_id ?? "missing",
      };
      const ids = ["answer-left", "qualification-left", "answer-right", "qualification-right"];
      const submit = () =>
        Effect.runPromise(
          provideServices(
            ids,
            source,
            "2026-08-25T13:05:00.000Z",
          )(service.submitStudyAnswer(answerInput)),
        );
      const [left, right] = await Promise.all([submit(), submit()]);
      expect(left).toEqual(right);
      const counts = await admin.query<{
        readonly answers: string;
        readonly qualifications: string;
      }>(
        `SELECT (SELECT count(*)::text FROM study_session_answers) AS answers,
                (SELECT count(*)::text FROM activity_qualifications) AS qualifications`,
      );
      expect(counts.rows[0]).toEqual({ answers: "1", qualifications: "1" });

      const unchanged = await Effect.runPromise(
        provideServices(
          [],
          source,
          "2026-08-25T14:00:00.000Z",
        )(
          service.setStreakTimezone({
            accountId: identity.accountId,
            idempotencyKey: "timezone-same",
            timezone: "UTC",
          }),
        ),
      );
      expect(unchanged.timezone).toBe("UTC");
      await expect(
        Effect.runPromise(
          provideServices(
            [],
            source,
            "2026-08-26T14:00:00.000Z",
          )(
            service.setStreakTimezone({
              accountId: identity.accountId,
              idempotencyKey: "timezone-too-soon",
              timezone: "Asia/Tbilisi",
            }),
          ),
        ),
      ).rejects.toMatchObject({
        _tag: "ActivityQualificationRejected",
        reason: "timezone-change-too-soon",
      });
    });
  });
});

afterAll(() => undefined);
