import { describe, expect, test } from "bun:test";
import { prepareActivityPersona } from "@pirate/application";
import { Effect } from "effect";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { makeControlPlanePersonaStore } from "./persona-repository.ts";
import { type ControlPlaneDb, makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { makeControlPlaneStudyV2Repository } from "./study-v2-repository.ts";
import { defaultStudySpokenEvidence } from "./study-v2-spoken-test-evidence.ts";

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
const connectionForSchemaAndRole = (raw: string, schema: string, role: string): string => {
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}options=${encodeURIComponent(
    `-c search_path=${schema} -c role=${role}`,
  )}`;
};
const digest = async (value: string): Promise<string> =>
  Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString(
    "hex",
  );

type PersonaServices = Parameters<typeof prepareActivityPersona>[1];

const personaServices = (layer: ReturnType<typeof makeDirectPostgresControlPlaneLayer>) =>
  ({
    store: makeControlPlanePersonaStore(layer),
    nextPersonaId: () => Effect.sync(() => `persona_${crypto.randomUUID().replaceAll("-", "")}`),
    nowIso: () => Effect.sync(() => new Date().toISOString()),
  }) satisfies PersonaServices;

const prepare = (
  services: PersonaServices,
  input: { accountId: string; communityId: string; idempotencyKey: string; choice: unknown },
) =>
  Effect.runPromise(
    prepareActivityPersona(
      {
        accountId: input.accountId,
        communityId: input.communityId,
        body: {
          idempotency_key: input.idempotencyKey,
          choice: input.choice as Parameters<typeof prepareActivityPersona>[0]["body"]["choice"],
        },
      },
      services,
    ),
  );

async function seedStudyV2Lyrics(admin: Client): Promise<readonly string[]> {
  const lines = [
    "I can love you",
    "We keep moving forward",
    "Hold the rhythm closer",
    "Sing the night together",
  ];
  const lyrics = lines.join("\n");
  const lineHashes = await Promise.all(lines.map(digest));
  await admin.query(
    `INSERT INTO media_post_submissions (
       submission_id, community_id, actor_user_id, operation_id, idempotency_key,
       request_hash, title, song_type, start_input, audio_reservation_id,
       creation_revision, audio_revision, analysis_revision, current_analysis_revision,
       current_immutable_ref, status, phase, post_id,
       response_snapshot_bytes, response_snapshot_sha256,
       author_persona_id, lyrics_revision, current_lyrics_revision
     ) VALUES ('participation-submission','participation-community','participation-author',
       'participation-operation','participation-idempotency',$1,'Study song','original',
       '{}'::jsonb,'participation-reservation',1,1,1,1,'audio-ref','published',NULL,
       'participation-post',convert_to('snapshot','UTF8'),$2,
       'participation-author-persona',1,1)`,
    ["2".repeat(64), await digest("snapshot")],
  );
  await admin.query(
    `INSERT INTO media_publication_projections (
       submission_id, community_id, actor_user_id, operation_id, post_id,
       creation_revision, audio_revision, analysis_revision, decision_revision,
       canonical_audio_sha256, title, audio_asset_ref, language_status,
       primary_language_bcp47, lyrics_explicitness, alignment, data_registration,
       locked_delivery, projected_at, author_persona_id, lyrics_status,
       lyrics_revision, lyrics_text
     ) VALUES ('participation-submission','participation-community','participation-author',
       'participation-operation','participation-post',1,1,1,1,$1,'Study song','audio-ref',
       'ready','en','not_explicit','ready','registered','not_required',clock_timestamp(),
       'participation-author-persona','ready',1,$2)`,
    ["2".repeat(64), lyrics],
  );
  for (const [index, line] of lines.entries()) {
    const ordinal = index + 1;
    await admin.query(
      `INSERT INTO localization_lyric_line_occurrences (
         community_id, post_id, lyric_line_id
       ) VALUES ('participation-community','participation-post',$1)`,
      [`participation-line-${ordinal}`],
    );
    await admin.query(
      `INSERT INTO localization_lyric_line_versions (
         community_id, post_id, lyric_line_id, line_version, canonical_text,
         source_language, source_hash
       ) VALUES ('participation-community','participation-post',$1,1,$2,'en',$3)`,
      [`participation-line-${ordinal}`, line, lineHashes[index]],
    );
    await admin.query(
      `INSERT INTO localization_study_units (
         community_id, post_id, study_unit_id, identity_normalization_revision,
         normalized_source_hash
       ) VALUES ('participation-community','participation-post',$1,
         'lyric_line_identity_normalization_v1',$2)`,
      [`participation-unit-${ordinal}`, lineHashes[index]],
    );
    await admin.query(
      `INSERT INTO localization_lyric_line_study_units (
         community_id, post_id, lyric_line_id, line_version, study_unit_id
       ) VALUES ('participation-community','participation-post',$1,1,$2)`,
      [`participation-line-${ordinal}`, `participation-unit-${ordinal}`],
    );
    await admin.query(
      `INSERT INTO localization_lyrics_revision_lines (
         community_id, actor_user_id, post_id, submission_id, lyrics_revision,
         ordinal, lyric_line_id, line_version, source_hash
       ) VALUES ('participation-community','participation-author','participation-post',
         'participation-submission',1,$1,$2,1,$3)`,
      [ordinal, `participation-line-${ordinal}`, lineHashes[index]],
    );
    await admin.query(
      `INSERT INTO study_exercise_versions (
         exercise_version_id, community_id, post_id, audio_revision, lyrics_revision,
         lyric_line_id, line_version, line_source_hash, exercise_review_key,
         exercise_type, exercise_variant, learning_language, target_language,
         learner_band, content_revision, presentation, private_grader, study_unit_id,
         answer_visibility, feedback_release, grader_policy_revision,
         feedback_policy_revision, generation_kind, generation_run_id, producer_id,
         provider_model, prompt_revision, request_hash, raw_result_digest,
         structural_validator_revision, semantic_validator_revision,
         safety_validator_revision, quality_validator_revision,
         quality_policy_revision, generated_at, validated_at, accepted_at
       ) VALUES ($1,'participation-community','participation-post',1,1,$2,1,$3,$4,
         'say_it_back','spoken-recall-v2','en',NULL,NULL,1,$5::jsonb,$6::jsonb,$7,
         'always_visible','every_graded_attempt','script_aware_token_phonetic_v2',
         'spoken-feedback-v1','deterministic',$8,'accepted-lyrics-say-it-back-v2',NULL,
         'accepted-say-it-back-v2',$9,$3,'study-source-structure-v1',
         'study-source-semantic-v1','study-source-safety-v1','study-source-quality-v1',
         'accepted-source-v1',clock_timestamp(),clock_timestamp(),clock_timestamp())`,
      [
        `participation-exercise-${ordinal}`,
        `participation-line-${ordinal}`,
        lineHashes[index],
        `study-say-it-back:participation-post:participation-unit-${ordinal}`,
        JSON.stringify({
          kind: "say_it_back",
          reference_text: line,
          capture: "microphone_audio",
        }),
        JSON.stringify({
          kind: "source_token_phonetic_v2",
          reference_text: line,
          tokenizer_policy_revision: "script_aware_token_phonetic_v2",
        }),
        `participation-unit-${ordinal}`,
        `participation-run-${ordinal}`,
        await digest(`participation-exercise-${ordinal}`),
      ],
    );
  }
  return lines;
}

suite("Activity persona preparation", () => {
  test("selects, binds or mints an exact-community persona without joining and stays idempotent", async () => {
    if (connectionString === undefined) throw new Error("test URL was not configured");
    const schema = `api_next_preparation_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const scoped = connectionForSchema(connectionString, schema);
    const admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    try {
      await applyPostgresTestBaselineConnection({ connectionString: scoped });
      await admin.query("SET session_replication_role = replica");
      try {
        await admin.query("INSERT INTO users (user_id) VALUES ('participant'),('foreign-account')");
        await admin.query(
          `INSERT INTO communities (
             community_id, display_name, status, created_by_user_id, created_at, updated_at
           ) VALUES ('practice-community','Practice','active','participant',
             clock_timestamp(),clock_timestamp()),
             ('other-community','Other','active','participant',clock_timestamp(),clock_timestamp())`,
        );
        await admin.query(
          `INSERT INTO personas (
             persona_id, account_id, status, is_first_persona, created_at, retired_at
           ) VALUES
             ('bound-persona','participant','active',false,clock_timestamp(),NULL),
             ('unbound-persona','participant','active',false,clock_timestamp(),NULL),
             ('elsewhere-persona','participant','active',false,clock_timestamp(),NULL),
             ('presentation-persona','participant','active',false,clock_timestamp(),NULL),
             ('foreign-persona','foreign-account','active',false,clock_timestamp(),NULL)`,
        );
        await admin.query(
          `INSERT INTO persona_community_bindings (
             persona_id, account_id, community_id, binding_source
           ) VALUES
             ('bound-persona','participant','practice-community','first_membership'),
             ('elsewhere-persona','participant','other-community','first_membership'),
             ('foreign-persona','foreign-account','practice-community','first_membership')`,
        );
      } finally {
        await admin.query("SET session_replication_role = origin");
      }

      const layer = makeDirectPostgresControlPlaneLayer(scoped);
      const services = personaServices(layer);

      const selected = await prepare(services, {
        accountId: "participant",
        communityId: "practice-community",
        idempotencyKey: "prepare-selected",
        choice: { kind: "existing", persona_id: "bound-persona" },
      });
      expect(selected).toMatchObject({
        object: "activity_persona_preparation",
        community_id: "practice-community",
        persona_id: "bound-persona",
        persona_status: "active",
      });
      expect(selected.activity_presentation?.persona_id).toBe("bound-persona");
      expect(
        await prepare(services, {
          accountId: "participant",
          communityId: "practice-community",
          idempotencyKey: "prepare-selected",
          choice: { kind: "existing", persona_id: "bound-persona" },
        }),
      ).toEqual(selected);
      await expect(
        prepare(services, {
          accountId: "participant",
          communityId: "practice-community",
          idempotencyKey: "prepare-selected",
          choice: { kind: "existing", persona_id: "unbound-persona" },
        }),
      ).rejects.toMatchObject({ _tag: "Conflict" });

      const bound = await prepare(services, {
        accountId: "participant",
        communityId: "practice-community",
        idempotencyKey: "prepare-unbound",
        choice: { kind: "existing", persona_id: "unbound-persona" },
      });
      expect(bound.persona_id).toBe("unbound-persona");
      expect(
        (
          await admin.query(
            `SELECT community_id, binding_source FROM persona_community_bindings
              WHERE persona_id='unbound-persona'`,
          )
        ).rows,
      ).toEqual([{ community_id: "practice-community", binding_source: "activity_participation" }]);
      // An existing explicit presentation is preserved by preparation.
      await admin.query("SET session_replication_role = replica");
      try {
        await admin.query(
          `INSERT INTO persona_community_bindings (
             persona_id, account_id, community_id, binding_source
           ) VALUES ('presentation-persona','participant','practice-community',
             'first_membership')`,
        );
      } finally {
        await admin.query("SET session_replication_role = origin");
      }
      await admin.query(
        `INSERT INTO persona_activity_presentations (
           community_id, account_id, persona_id, created_at, updated_at
         ) VALUES ('practice-community','participant','presentation-persona',
           clock_timestamp(),clock_timestamp())
         ON CONFLICT (community_id, account_id) DO UPDATE SET
           persona_id=EXCLUDED.persona_id, updated_at=EXCLUDED.updated_at`,
      );
      const preserved = await prepare(services, {
        accountId: "participant",
        communityId: "practice-community",
        idempotencyKey: "prepare-preserved",
        choice: { kind: "existing", persona_id: "bound-persona" },
      });
      expect(preserved.activity_presentation?.persona_id).toBe("presentation-persona");

      await expect(
        prepare(services, {
          accountId: "participant",
          communityId: "practice-community",
          idempotencyKey: "prepare-elsewhere",
          choice: { kind: "existing", persona_id: "elsewhere-persona" },
        }),
      ).rejects.toMatchObject({ _tag: "Conflict" });
      await expect(
        prepare(services, {
          accountId: "participant",
          communityId: "practice-community",
          idempotencyKey: "prepare-foreign",
          choice: { kind: "existing", persona_id: "foreign-persona" },
        }),
      ).rejects.toMatchObject({ _tag: "NotFound" });

      const minted = await prepare(services, {
        accountId: "participant",
        communityId: "practice-community",
        idempotencyKey: "prepare-minted",
        choice: { kind: "create_new" },
      });
      expect(minted.persona_id).toMatch(/^persona_/u);
      expect(minted.persona_status).toBe("pending_wallet");
      // Minting never establishes a presentation, but the account's existing
      // explicit one is still the current fact and must appear identically on
      // an exact replay.
      expect(minted.activity_presentation?.persona_id).toBe("presentation-persona");
      // Exact replay returns the same prepared identity and never mints twice.
      const mintedReplay = await prepare(services, {
        accountId: "participant",
        communityId: "practice-community",
        idempotencyKey: "prepare-minted",
        choice: { kind: "create_new" },
      });
      expect(mintedReplay).toEqual(minted);
      expect(
        (
          await admin.query(
            `SELECT count(*)::integer AS actions FROM persona_activity_preparation_actions
              WHERE account_id='participant' AND idempotency_key='prepare-minted'`,
          )
        ).rows,
      ).toEqual([{ actions: 1 }]);
      expect(
        (
          await admin.query(
            `SELECT persona.status, binding.binding_source, count(profile.persona_id)::integer AS drafts
               FROM personas AS persona
               JOIN persona_community_bindings AS binding USING (persona_id)
               JOIN persona_pending_profiles AS profile USING (persona_id)
              WHERE persona.persona_id=$1
              GROUP BY persona.status, binding.binding_source`,
            [minted.persona_id],
          )
        ).rows,
      ).toEqual([
        { status: "pending_wallet", binding_source: "activity_participation", drafts: 1 },
      ]);
      expect(
        (
          await admin.query(
            `SELECT
               (SELECT count(*)::integer FROM personas WHERE account_id='participant') AS personas,
               (SELECT count(*)::integer FROM community_memberships
                 WHERE user_id='participant') AS memberships,
               (SELECT count(*)::integer FROM community_follows
                 WHERE user_id='participant') AS follows,
               (SELECT count(*)::integer FROM posts
                 WHERE author_user_id='participant') AS posts,
               (SELECT count(*)::integer FROM data_registration_operations
                 WHERE actor_user_id='participant') AS data_operations`,
          )
        ).rows,
      ).toEqual([{ personas: 5, memberships: 0, follows: 0, posts: 0, data_operations: 0 }]);
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      await admin.end();
    }
  }, 60_000);

  test("concurrent preparation serializes one-time binding and exact mint replay", async () => {
    if (connectionString === undefined) throw new Error("test URL was not configured");
    const schema = `api_next_preparation_race_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const scoped = connectionForSchema(connectionString, schema);
    const admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    try {
      await applyPostgresTestBaselineConnection({ connectionString: scoped });
      await admin.query("SET session_replication_role = replica");
      try {
        await admin.query("INSERT INTO users (user_id) VALUES ('racer')");
        await admin.query(
          `INSERT INTO communities (
             community_id, display_name, status, created_by_user_id, created_at, updated_at
           ) VALUES ('race-community-a','Race A','active','racer',clock_timestamp(),clock_timestamp()),
             ('race-community-b','Race B','active','racer',clock_timestamp(),clock_timestamp()),
             ('race-community-c','Race C','active','racer',clock_timestamp(),clock_timestamp())`,
        );
        await admin.query(
          `INSERT INTO personas (
             persona_id, account_id, status, is_first_persona, created_at, retired_at
           ) VALUES ('race-persona','racer','active',false,clock_timestamp(),NULL)`,
        );
      } finally {
        await admin.query("SET session_replication_role = origin");
      }

      const services = personaServices(makeDirectPostgresControlPlaneLayer(scoped));
      const raced = await Promise.allSettled([
        prepare(services, {
          accountId: "racer",
          communityId: "race-community-a",
          idempotencyKey: "race-bind-a",
          choice: { kind: "existing", persona_id: "race-persona" },
        }),
        prepare(services, {
          accountId: "racer",
          communityId: "race-community-b",
          idempotencyKey: "race-bind-b",
          choice: { kind: "existing", persona_id: "race-persona" },
        }),
      ]);
      const fulfilled = raced.filter((result) => result.status === "fulfilled");
      const rejected = raced.find((result) => result.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toBeDefined();
      if (rejected?.status !== "rejected") throw new Error("expected one losing racer");
      expect(rejected.reason).toMatchObject({ _tag: "Conflict" });
      // The persona-row lock admits exactly one one-time binding and one
      // presentation; the loser is rejected before writing anything.
      const binding = (
        await admin.query(
          `SELECT community_id, binding_source FROM persona_community_bindings
            WHERE persona_id='race-persona'`,
        )
      ).rows;
      expect(binding).toHaveLength(1);
      expect(binding[0]?.binding_source).toBe("activity_participation");
      const presentations = (
        await admin.query(
          `SELECT community_id, persona_id FROM persona_activity_presentations
            WHERE account_id='racer'`,
        )
      ).rows;
      expect(presentations).toEqual([
        { community_id: binding[0]?.community_id, persona_id: "race-persona" },
      ]);

      // Two identical create-new commands under one idempotency key mint once
      // and both return the same pending identity in one clean community.
      const [mintA, mintB] = await Promise.all([
        prepare(services, {
          accountId: "racer",
          communityId: "race-community-c",
          idempotencyKey: "race-mint",
          choice: { kind: "create_new" },
        }),
        prepare(services, {
          accountId: "racer",
          communityId: "race-community-c",
          idempotencyKey: "race-mint",
          choice: { kind: "create_new" },
        }),
      ]);
      expect(mintA).toMatchObject({
        persona_status: "pending_wallet",
        activity_presentation: null,
      });
      expect(mintB).toEqual(mintA);
      expect(
        (
          await admin.query(
            `SELECT
               (SELECT count(*)::integer FROM persona_activity_preparation_actions
                 WHERE idempotency_key='race-mint') AS actions,
               (SELECT count(*)::integer FROM persona_community_bindings
                 WHERE persona_id=$1 AND binding_source='activity_participation') AS bindings`,
            [mintA.persona_id],
          )
        ).rows,
      ).toEqual([{ actions: 1, bindings: 1 }]);
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      await admin.end();
    }
  }, 60_000);

  test("a restricted runtime role prepares and never-joined Study v2 completes, resumes and replays", async () => {
    if (connectionString === undefined) throw new Error("test URL was not configured");
    const schema = `api_next_preparation_journey_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const scoped = connectionForSchema(connectionString, schema);
    const restricted = connectionForSchemaAndRole(connectionString, schema, "api_next_app");
    let createdRuntimeRole = false;
    const admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    try {
      await applyPostgresTestBaselineConnection({ connectionString: scoped });
      await admin.query("SET session_replication_role = replica");
      let lines: readonly string[] = [];
      try {
        await admin.query(
          "INSERT INTO users (user_id) VALUES ('participant'),('participation-author')",
        );
        await admin.query(
          `INSERT INTO communities (
             community_id, display_name, status, created_by_user_id, created_at, updated_at
           ) VALUES ('participation-community','Practice','active','participation-author',
             clock_timestamp(),clock_timestamp())`,
        );
        await admin.query(
          `INSERT INTO personas (
             persona_id, account_id, status, is_first_persona, created_at, retired_at
           ) VALUES
             ('participation-author-persona','participation-author','active',true,
               clock_timestamp(),NULL),
             ('participant-persona','participant','active',false,clock_timestamp(),NULL)`,
        );
        await admin.query(
          `INSERT INTO persona_community_bindings (
             persona_id, account_id, community_id, binding_source
           ) VALUES ('participation-author-persona','participation-author',
             'participation-community','community_creation')`,
        );
        await admin.query(
          `INSERT INTO posts (
             community_id, post_id, author_user_id, author_persona_id, post_type,
             status, visibility, title, created_at, updated_at
           ) VALUES ('participation-community','participation-post','participation-author',
             'participation-author-persona','song','published','public','Study song',
             clock_timestamp(),clock_timestamp())`,
        );
        await admin.query(
          "UPDATE posts SET content_rating='general' WHERE post_id='participation-post'",
        );
        lines = await seedStudyV2Lyrics(admin);
      } finally {
        await admin.query("SET session_replication_role = origin");
      }

      // The runtime role is cluster-global. Create it only when absent and
      // remove it again so this file cannot break suites that assert the
      // deployment role template has not been applied yet.
      const existingRole = await admin.query("SELECT 1 FROM pg_roles WHERE rolname='api_next_app'");
      createdRuntimeRole = existingRole.rows.length === 0;
      await admin.query(`DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='api_next_app') THEN
            CREATE ROLE api_next_app NOLOGIN;
          END IF;
        END
      $$`);
      await admin.query(`GRANT USAGE ON SCHEMA ${quoteIdentifier(schema)} TO api_next_app`);
      await admin.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${quoteIdentifier(schema)} TO api_next_app`,
      );
      await admin.query(
        `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${quoteIdentifier(schema)} TO api_next_app`,
      );

      // Preparation, session start, reload/resume, completion and replay all
      // run through the restricted runtime role, not the schema owner.
      const runtime = makeDirectPostgresControlPlaneLayer(restricted);
      const services = personaServices(runtime);
      const prepared = await prepare(services, {
        accountId: "participant",
        communityId: "participation-community",
        idempotencyKey: "journey-prepare",
        choice: { kind: "existing", persona_id: "participant-persona" },
      });
      expect(prepared).toMatchObject({
        persona_id: "participant-persona",
        persona_status: "active",
      });
      expect(prepared.activity_presentation?.persona_id).toBe("participant-persona");

      const study = makeControlPlaneStudyV2Repository();
      const run = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
        Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(runtime))));
      const session = await run(
        study.startSession({
          accountId: "participant",
          communityId: "participation-community",
          createdAt: "2026-09-01T12:00:00.000Z",
          targetLanguage: null,
          idempotencyKey: "journey-session-command",
          learnerBand: null,
          personaId: "participant-persona",
          postId: "participation-post",
          requestHash: "5".repeat(64),
          sessionId: "journey-session",
          timezone: "UTC",
        }),
      );
      expect(session.items).toHaveLength(4);
      const itemId = (index: number) => session.items[index]?.session_item_id ?? "";

      let commandCounter = 0;
      const answerSpoken = async (
        sessionItemId: string,
        attemptNumber: number,
        correct: boolean,
      ) => {
        commandCounter += 1;
        const counter = commandCounter;
        const keys = {
          audioDigest: `${counter}`.repeat(64),
          idempotencyKey: `journey-spoken-command-${counter}`,
          requestHash: `${counter}`.repeat(64),
        };
        await run(
          study.loadSpokenAnswerContext({
            accountId: "participant",
            communityId: "participation-community",
            idempotencyKey: keys.idempotencyKey,
            sessionId: session.session_id,
            sessionItemId,
          }),
        );
        const reservation = await run(
          study.reserveSpokenAnswer({
            accountId: "participant",
            attemptNumber,
            audioByteSize: 100,
            audioContentType: "audio/webm",
            audioDigest: keys.audioDigest,
            audioDurationMs: 1000,
            attemptId: `journey-attempt-${counter}`,
            artifactId: `journey-artifact-${counter}`,
            commandId: `journey-command-${counter}`,
            idempotencyKey: keys.idempotencyKey,
            leaseToken: `journey-lease-${counter}`,
            providerRetention: "stored",
            requestHash: keys.requestHash,
            sessionId: session.session_id,
            sessionItemId,
          }),
        );
        if (reservation.state === "completed") return reservation.result;
        return run(
          study.completeSpokenAnswer({
            ...defaultStudySpokenEvidence,
            accountId: "participant",
            acceptedAt: `2026-09-01T12:0${counter}:00.000Z`,
            archive: {
              state: "stored",
              objectRef: `learner-audio/study/journey-attempt-${counter}/${keys.audioDigest}`,
            },
            artifactId: reservation.artifactId,
            attemptId: reservation.attemptId,
            attemptNumber,
            audioByteSize: 100,
            audioContentType: "audio/webm",
            audioDigest: keys.audioDigest,
            audioDurationMs: 1000,
            commandId: reservation.commandId,
            leaseToken: reservation.leaseToken,
            communityId: "participation-community",
            grade: {
              correct,
              matchKind: correct ? "exact" : "none",
              heardTranscript: correct ? (lines[0] ?? "") : "unrecognized murmur",
              matched: [],
              missing: [],
              extra: [],
              substituted: [],
              policyRevision: "script_aware_token_phonetic_v2",
            },
            providerDetectedLanguage: "en",
            providerDetectedLanguageConfidence: 0.99,
            qualificationId: `journey-qualification-${counter}`,
            requestHash: keys.requestHash,
            sessionId: session.session_id,
            sessionItemId,
          }),
        );
      };

      const miss = await answerSpoken(itemId(0), 1, false);
      expect(miss).toMatchObject({ outcome: "incorrect" });
      const reloaded = await run(
        study.getSession({
          accountId: "participant",
          communityId: "participation-community",
          sessionId: session.session_id,
        }),
      );
      expect(reloaded?.lesson.current?.session_item_id).toBe(itemId(1));
      for (const index of [1, 2, 3]) {
        const answered = await answerSpoken(itemId(index), 1, true);
        expect(answered).toMatchObject({ outcome: "correct" });
      }
      const final = await answerSpoken(itemId(0), 2, true);
      expect(final.session).toMatchObject({
        status: "completed",
        lesson: { resolved_card_count: 4, completion_reason: "all_resolved" },
      });

      expect(
        (
          await admin.query(
            `SELECT
               (SELECT count(*)::integer FROM community_memberships
                 WHERE user_id='participant') AS memberships,
               (SELECT count(*)::integer FROM community_follows
                 WHERE user_id='participant') AS follows,
               (SELECT count(*)::integer FROM posts
                 WHERE author_user_id='participant') AS posts,
               (SELECT count(*)::integer FROM data_registration_operations
                 WHERE actor_user_id='participant') AS data_operations,
               (SELECT count(*)::integer FROM megapot_pool_shares
                 WHERE account_id='participant') AS shares,
               (SELECT count(*)::integer FROM reward_ledger_credits
                 WHERE account_id='participant') AS credits,
               (SELECT count(*)::integer FROM persona_activity_preparation_actions
                 WHERE account_id='participant') AS preparation_actions`,
          )
        ).rows,
      ).toEqual([
        {
          memberships: 0,
          follows: 0,
          posts: 0,
          data_operations: 0,
          shares: 0,
          credits: 0,
          preparation_actions: 1,
        },
      ]);

      // The preparation action log is append-only for every role, including
      // the restricted runtime role that wrote it.
      await expect(
        admin.query(
          "UPDATE persona_activity_preparation_actions SET request_hash=$1 WHERE account_id='participant'",
          ["f".repeat(64)],
        ),
      ).rejects.toThrow(/append-only/u);
      const runtimeUpdate = new Client({ connectionString: restricted });
      await runtimeUpdate.connect();
      try {
        await expect(
          runtimeUpdate.query(
            "UPDATE persona_activity_preparation_actions SET request_hash=$1 WHERE account_id='participant'",
            ["f".repeat(64)],
          ),
        ).rejects.toThrow(/append-only/u);
      } finally {
        await runtimeUpdate.end();
      }
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      if (createdRuntimeRole) {
        // Remove every grant this run made before dropping the cluster-global
        // role, including grants made outside this test's schema.
        await admin.query("DROP OWNED BY api_next_app");
        await admin.query("DROP ROLE IF EXISTS api_next_app");
      }
      await admin.end();
    }
  }, 90_000);
});
