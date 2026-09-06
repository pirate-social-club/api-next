import { describe, expect, test } from "bun:test";
import { Effect, Result } from "effect";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { makeControlPlaneActivityQualificationRepository } from "./activity-qualification-repository.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { makeControlPlaneStudyV2Repository } from "./study-v2-repository.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;

// These are current-runtime characterizations, not acceptance of the ratified
// participation boundary. Replace the denial expectations when the shared
// authority and independent monetary admission implementation lands together.
suite("Activity participation authority implementation baseline", () => {
  test("owned exact-community identity survives leaving but practice start and presentation reject it", async () => {
    if (connectionString === undefined) throw new Error("test URL was not configured");
    const schema = `api_next_participation_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const separator = connectionString.includes("?") ? "&" : "?";
    const scoped = `${connectionString}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
    const admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    try {
      await applyPostgresTestBaselineConnection({ connectionString: scoped });
      await admin.query("SET session_replication_role = replica");
      try {
        await admin.query("INSERT INTO users (user_id) VALUES ('participant'),('foreign-account')");
        await admin.query(`INSERT INTO communities (
          community_id,display_name,status,created_by_user_id,created_at,updated_at
        ) VALUES ('practice-community','Practice','active','participant',clock_timestamp(),clock_timestamp()),
          ('other-community','Other','active','participant',clock_timestamp(),clock_timestamp())`);
        await admin.query(`INSERT INTO personas (persona_id,account_id,status,created_at) VALUES
          ('participant-persona','participant','active',clock_timestamp()),
          ('unbound-persona','participant','active',clock_timestamp()),
          ('foreign-persona','foreign-account','active',clock_timestamp())`);
        await admin.query(`INSERT INTO persona_community_bindings
          (persona_id,account_id,community_id,binding_source) VALUES
          ('participant-persona','participant','practice-community','first_membership'),
          ('foreign-persona','foreign-account','practice-community','first_membership')`);
        await admin.query(`INSERT INTO community_memberships
          (community_id,membership_id,user_id,status,joined_at,created_at,updated_at) VALUES
          ('practice-community','participant-membership','participant','member',
            clock_timestamp(),clock_timestamp(),clock_timestamp())`);
        await admin.query(`INSERT INTO posts
          (community_id,post_id,author_user_id,author_persona_id,post_type,status,visibility,created_at,updated_at)
          VALUES ('practice-community','practice-song','participant','participant-persona','song',
            'published','public',clock_timestamp(),clock_timestamp())`);
      } finally {
        await admin.query("SET session_replication_role = origin");
      }
      const authority = () =>
        admin.query(`SELECT
        active_owned_persona('participant','participant-persona') AS owned,
        active_owned_community_persona('participant','participant-persona','practice-community') AS bound,
        active_community_effect('practice-community','participant') AS posting,
        active_owned_community_persona('participant','foreign-persona','practice-community') AS foreign_persona,
        active_owned_community_persona('participant','unbound-persona','practice-community') AS unbound_persona,
        active_owned_community_persona('participant','participant-persona','other-community') AS wrong_community`);
      expect((await authority()).rows).toEqual([
        {
          owned: true,
          bound: true,
          posting: true,
          foreign_persona: false,
          unbound_persona: false,
          wrong_community: false,
        },
      ]);
      await admin.query(`UPDATE community_memberships SET status='left',updated_at=clock_timestamp()
        WHERE membership_id='participant-membership'`);
      expect((await authority()).rows).toEqual([
        {
          owned: true,
          bound: true,
          posting: false,
          foreign_persona: false,
          unbound_persona: false,
          wrong_community: false,
        },
      ]);
      const runtime = makeDirectPostgresControlPlaneLayer(scoped);
      const base = {
        accountId: "participant",
        personaId: "participant-persona",
        communityId: "practice-community",
        postId: "practice-song",
        idempotencyKey: "practice-key",
        requestHash: "a".repeat(64),
        createdAt: "2026-09-06T12:00:00.000Z",
        timezone: "UTC",
        sessionId: "practice-session",
      };
      const study = await Effect.runPromise(
        Effect.scoped(
          makeControlPlaneStudyV2Repository()
            .startSession({
              ...base,
              targetLanguage: null,
              learnerBand: null,
            })
            .pipe(Effect.result, Effect.provide(runtime)),
        ),
      );
      expect(Result.isFailure(study)).toBe(true);
      if (!Result.isFailure(study)) throw new Error("Expected current membership refusal");
      expect(study.failure._tag).toBe("StudyV2CommandRejected");
      if (study.failure._tag !== "StudyV2CommandRejected")
        throw new Error("Unexpected storage failure");
      expect(study.failure.reason).toBe("not-found");
      const presentation = await Effect.runPromise(
        Effect.scoped(
          makeControlPlaneActivityQualificationRepository()
            .setPresentationPersona({
              ...base,
              updatedAt: base.createdAt,
            })
            .pipe(Effect.result, Effect.provide(runtime)),
        ),
      );
      expect(Result.isFailure(presentation)).toBe(true);
      if (!Result.isFailure(presentation)) throw new Error("Expected current membership refusal");
      expect(presentation.failure._tag).toBe("ActivityQualificationRejected");
      if (presentation.failure._tag !== "ActivityQualificationRejected")
        throw new Error("Unexpected storage failure");
      expect(presentation.failure.reason).toBe("persona-ineligible");
      const writes = await admin.query(`SELECT
        (SELECT count(*)::integer FROM karaoke_sessions) AS karaoke,
        (SELECT count(*)::integer FROM study_sessions_v2) AS study,
        (SELECT count(*)::integer FROM persona_activity_presentations) AS presentations,
        (SELECT count(*)::integer FROM posts) AS posts,
        (SELECT count(*)::integer FROM reward_eligibility_decisions) AS reward_decisions,
        (SELECT count(*)::integer FROM megapot_pool_shares) AS pool_shares`);
      expect(writes.rows).toEqual([
        {
          karaoke: 0,
          study: 0,
          presentations: 0,
          posts: 1,
          reward_decisions: 0,
          pool_shares: 0,
        },
      ]);
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  }, 30_000);
});
