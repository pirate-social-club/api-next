/**
 * Seeds the disposable local PostgreSQL with a synthetic, explicitly labelled
 * harness fixture: several synthetic learner accounts (each with one activity
 * persona bound to a synthetic community), and a published song with accepted
 * lyrics, four say-it-back exercises and a ready word-mode timing artifact.
 *
 * Nothing here is production content or a real identity. It also mints the
 * synthetic browser sessions the Playwright specs inject, using the same local
 * key pair the harness Worker reads from .dev.vars.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeSessionCrypto } from "@pirate/platform-cf/session-crypto";
import { makeRs256SessionTokenMinter } from "@pirate/platform-cf/session-tokens";
import { Effect } from "effect";
import pg from "pg";
import { ensureHarnessKeys, writeDevVars } from "./keys.ts";

const CONNECTION_STRING =
  process.env.HARNESS_POSTGRES_URL ??
  "postgres://postgres:postgres@127.0.0.1:5432/postgres?options=-c%20search_path%3Dapi_next";

const COMMUNITY_ID = "community_harness";
const POST_ID = "post_harness_song";
const SUBMISSION_ID = "submission_harness_song";
const OPERATION_ID = "operation_harness_song";
const POST_SLUG = "harness-practice-song";
const AUDIO_REVISION = 1;
const LYRICS_REVISION = 1;
const CANONICAL_AUDIO_SHA256 = "a".repeat(64);
const LEARNER_COUNT = Number(process.env.HARNESS_LEARNER_COUNT ?? "12");

const learnerAccountId = (index: number): string =>
  `usr_harness_learner_${String(index).padStart(2, "0")}`;

/** Five lines: four Study cards (one with a negation) and a full karaoke shape. */
const LYRIC_LINES = [
  "Hold the line",
  "Sing it back",
  "Never drop the beat",
  "Move with me",
  "Shine tonight",
] as const;
const NEGATION_LINE = "Never drop the beat";

const harnessDirectory = dirname(fileURLToPath(import.meta.url));
const localDirectory = join(harnessDirectory, ".local");

const digest = async (value: string): Promise<string> =>
  createHash("sha256").update(value, "utf8").digest("hex");

const SESSION_ISSUER = "api-next-session-harness";
const SESSION_AUDIENCE = "api-next-browser-harness";
const SESSION_SCOPE = "api-next-browser-session-harness";

function accountDocument(accountId: string, index: number) {
  const suffix = String(index);
  return {
    user: {
      user_id: accountId,
      primary_wallet_attachment_id: `wallet_harness_${suffix}`,
      capability_provider: null,
      verification_capabilities_json: null,
      verified_at: null,
      created_at: "2026-09-18T12:00:00.000Z",
    },
    profile: {
      user_id: accountId,
      display_name: `Harness learner ${suffix}`,
      bio: null,
      bio_source: "none",
      avatar_ref: null,
      avatar_source: "none",
      cover_ref: null,
      cover_source: "none",
      preferred_locale: "en",
      display_verified_nationality_badge: 0,
      global_handle_id: `handle_harness_${suffix}`,
      primary_linked_handle_id: null,
      xmtp_inbox_id: null,
      created_at: "2026-09-18T12:00:00.000Z",
    },
    global_handle: {
      global_handle_id: `handle_harness_${suffix}`,
      label_display: `harness-learner-${suffix}.pirate`,
      status: "active",
      tier: "generated",
      issuance_source: "generated_signup",
      redirect_target_global_handle_id: null,
      price_paid_cents: null,
      free_rename_consumed: 0,
      issued_at: "2026-09-18T12:00:00.000Z",
      replaced_at: null,
    },
    linked_handles: [],
    wallet_attachments: [
      {
        wallet_attachment_id: `wallet_harness_${suffix}`,
        chain_namespace: "eip155:1",
        wallet_address_display: `0x${suffix.padStart(1, "0").repeat(40).slice(0, 40)}`,
        is_primary: 1,
      },
    ],
    onboarding: {
      generated_handle_assigned: true,
      cleanup_rename_available: false,
      unique_human_verification_status: "not_started",
      namespace_verification_status: "not_started",
      community_creation_ready: false,
      missing_requirements: [],
      reddit_verification_status: "not_started",
      reddit_import_status: "not_started",
    },
  } as const;
}

function wordTimings(
  line: string,
  startMs: number,
): {
  readonly words: readonly {
    readonly text: string;
    readonly start_ms: number;
    readonly end_ms: number;
  }[];
  readonly endMs: number;
} {
  let cursor = startMs;
  const words = line.split(" ").map((text) => {
    const word = { text, start_ms: cursor, end_ms: cursor + 300 };
    cursor += 380;
    return word;
  });
  return { words, endMs: cursor - 80 };
}

/**
 * The account insert trigger provisions the first persona in pending_wallet;
 * this activates it in one deferred-constraint transaction (confirmed wallet +
 * public profile) so activity authority remains the real database one.
 */
async function provisionAccount(
  admin: pg.Client,
  accountId: string,
  index: number,
): Promise<string> {
  await admin.query(`INSERT INTO users (user_id, account) VALUES ($1, $2::jsonb)`, [
    accountId,
    JSON.stringify(accountDocument(accountId, index)),
  ]);
  await admin.query(
    `INSERT INTO account_minimum_age_attestations (
       account_id, version, minimum_age, affirmed
     ) VALUES ($1, 'minimum-age-attestation-v1', 16, true)`,
    [accountId],
  );
  await admin.query("BEGIN");
  try {
    await admin.query(
      `UPDATE persona_wallet_assignments
          SET status='active', address=$2, assigned_at=clock_timestamp(), updated_at=clock_timestamp()
        WHERE persona_id=(SELECT persona_id FROM personas
                          WHERE account_id=$1 AND is_first_persona)`,
      [accountId, `0x${"a".repeat(37)}${String(index).padStart(3, "0")}`],
    );
    await admin.query(
      `DELETE FROM persona_pending_profiles
        WHERE persona_id=(SELECT persona_id FROM personas
                           WHERE account_id=$1 AND is_first_persona)`,
      [accountId],
    );
    await admin.query(
      `INSERT INTO persona_profiles (persona_id, revision, display_name, created_at, updated_at)
       SELECT persona_id, 1, $2, clock_timestamp(), clock_timestamp()
         FROM personas WHERE account_id=$1 AND is_first_persona`,
      [accountId, `Harness learner ${String(index)}`],
    );
    await admin.query(
      `UPDATE personas SET status='active' WHERE account_id=$1 AND is_first_persona`,
      [accountId],
    );
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
  const personaRow = await admin.query(
    "SELECT persona_id FROM personas WHERE account_id=$1 AND is_first_persona",
    [accountId],
  );
  const personaId = personaRow.rows[0]?.persona_id;
  if (typeof personaId !== "string") throw new Error("harness first persona was not provisioned");
  return personaId;
}

async function bindPersona(admin: pg.Client, accountId: string, personaId: string): Promise<void> {
  await admin.query(
    `INSERT INTO persona_community_bindings (
       persona_id, account_id, community_id, binding_source
     ) VALUES ($1, $2, $3, 'activity_participation')
     ON CONFLICT DO NOTHING`,
    [personaId, accountId, COMMUNITY_ID],
  );
}

async function seedContent(
  admin: pg.Client,
  authorAccountId: string,
  authorPersonaId: string,
): Promise<void> {
  const lineHashes = await Promise.all(LYRIC_LINES.map((line) => digest(line)));
  await admin.query(
    `INSERT INTO communities (
       community_id, display_name, status, created_by_user_id, created_at, updated_at
     ) VALUES ($1, 'Harness practice', 'active', $2, clock_timestamp(), clock_timestamp())`,
    [COMMUNITY_ID, authorAccountId],
  );
  await admin.query(
    `INSERT INTO posts (
       community_id, post_id, author_user_id, author_persona_id, post_type,
       status, visibility, title, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, 'song', 'published', 'public',
       'Harness practice song', clock_timestamp(), clock_timestamp())`,
    [COMMUNITY_ID, POST_ID, authorAccountId, authorPersonaId],
  );
  await admin.query("UPDATE posts SET content_rating='general' WHERE post_id=$1", [POST_ID]);
  await admin.query(
    `INSERT INTO post_slug_aliases (slug, post_id, slug_policy_version)
     VALUES ($1, $2, 'post-slug-v1')`,
    [POST_SLUG, POST_ID],
  );
  // Content seeding below mirrors the repository's own PG fixture pattern:
  // raw publication rows are inserted with user triggers disabled on this
  // disposable database. Application-time guards are not bypassed anywhere the
  // harness Worker actually runs.
  await admin.query("SET session_replication_role = replica");
  try {
    await admin.query(
      `INSERT INTO media_post_submissions (
         submission_id, community_id, actor_user_id, operation_id, idempotency_key,
         request_hash, title, song_type, start_input, audio_reservation_id,
         creation_revision, audio_revision, analysis_revision, current_analysis_revision,
         current_immutable_ref, status, phase, post_id,
         response_snapshot_bytes, response_snapshot_sha256,
         author_persona_id, lyrics_revision, current_lyrics_revision
       ) VALUES ($1,$2,$3,$4,$5,$6,'Harness practice song','original','{}'::jsonb,
         'harness-reservation',1,$7,$7,$7,'audio-ref','published',NULL,$8,
         convert_to('snapshot','UTF8'),$9,$10,$11,$11)`,
      [
        SUBMISSION_ID,
        COMMUNITY_ID,
        authorAccountId,
        OPERATION_ID,
        "harness-idempotency",
        CANONICAL_AUDIO_SHA256,
        AUDIO_REVISION,
        POST_ID,
        await digest("snapshot"),
        authorPersonaId,
        LYRICS_REVISION,
      ],
    );
    const rawLyrics = `${LYRIC_LINES.join("\n")}\n`;
    await admin.query(
      `INSERT INTO media_publication_projections (
         submission_id, community_id, actor_user_id, operation_id, post_id,
         creation_revision, audio_revision, analysis_revision, decision_revision,
         canonical_audio_sha256, title, audio_asset_ref, language_status,
         primary_language_bcp47, lyrics_explicitness, alignment, data_registration,
         locked_delivery, projected_at, author_persona_id, lyrics_status,
         lyrics_revision, lyrics_text
       ) VALUES ($1,$2,$3,$4,$5,1,$6,$6,1,$7,'Harness practice song','/harness/instrumental.wav',
         'ready','en','not_explicit','ready','registered','not_required',
         clock_timestamp(),$8,'ready',$9,$10)`,
      [
        SUBMISSION_ID,
        COMMUNITY_ID,
        authorAccountId,
        OPERATION_ID,
        POST_ID,
        AUDIO_REVISION,
        CANONICAL_AUDIO_SHA256,
        authorPersonaId,
        LYRICS_REVISION,
        rawLyrics,
      ],
    );
    for (const [index, line] of LYRIC_LINES.entries()) {
      const ordinal = index + 1;
      const lineId = `harness-line-${ordinal}`;
      const unitId = `harness-unit-${ordinal}`;
      const lineHash = lineHashes[index] ?? "";
      await admin.query(
        `INSERT INTO localization_lyric_line_occurrences (community_id, post_id, lyric_line_id)
         VALUES ($1,$2,$3)`,
        [COMMUNITY_ID, POST_ID, lineId],
      );
      await admin.query(
        `INSERT INTO localization_lyric_line_versions (
           community_id, post_id, lyric_line_id, line_version, canonical_text,
           source_language, source_hash
         ) VALUES ($1,$2,$3,1,$4,'en',$5)`,
        [COMMUNITY_ID, POST_ID, lineId, line, lineHash],
      );
      await admin.query(
        `INSERT INTO localization_study_units (
           community_id, post_id, study_unit_id, identity_normalization_revision,
           normalized_source_hash
         ) VALUES ($1,$2,$3,'lyric_line_identity_normalization_v1',$4)`,
        [COMMUNITY_ID, POST_ID, unitId, lineHash],
      );
      await admin.query(
        `INSERT INTO localization_lyric_line_study_units (
           community_id, post_id, lyric_line_id, line_version, study_unit_id
         ) VALUES ($1,$2,$3,1,$4)`,
        [COMMUNITY_ID, POST_ID, lineId, unitId],
      );
      await admin.query(
        `INSERT INTO localization_lyrics_revision_lines (
           community_id, actor_user_id, post_id, submission_id, lyrics_revision,
           ordinal, lyric_line_id, line_version, source_hash
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8)`,
        [
          COMMUNITY_ID,
          authorAccountId,
          POST_ID,
          SUBMISSION_ID,
          LYRICS_REVISION,
          ordinal,
          lineId,
          lineHash,
        ],
      );
    }
    for (const [index, line] of LYRIC_LINES.slice(0, 4).entries()) {
      const ordinal = index + 1;
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
         ) VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,
           'say_it_back','spoken-recall-v2','en',NULL,NULL,1,$9::jsonb,$10::jsonb,$11,
           'always_visible','every_graded_attempt','script_aware_token_phonetic_v2',
           'spoken-feedback-v1','deterministic',$12,'accepted-lyrics-say-it-back-v2',NULL,
           'accepted-say-it-back-v2',$13,$7,'study-source-structure-v1',
           'study-source-semantic-v1','study-source-safety-v1','study-source-quality-v1',
           'accepted-source-v1',clock_timestamp(),clock_timestamp(),clock_timestamp())`,
        [
          `harness-exercise-${ordinal}`,
          COMMUNITY_ID,
          POST_ID,
          AUDIO_REVISION,
          LYRICS_REVISION,
          `harness-line-${ordinal}`,
          lineHashes[index] ?? "",
          `study-say-it-back:${POST_ID}:harness-unit-${ordinal}`,
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
          `harness-unit-${ordinal}`,
          `harness-run-${ordinal}`,
          await digest(`harness-exercise-${ordinal}`),
        ],
      );
    }
    let cursor = 500;
    const segments = LYRIC_LINES.flatMap((line) => {
      const timed = wordTimings(line, cursor);
      cursor = timed.endMs + 400;
      return timed.words;
    });
    const artifact = {
      version: "media-timed-lyrics-artifact-v1",
      mode: "word",
      segments,
    };
    await admin.query(
      `INSERT INTO media_alignment_projections (
         submission_id, community_id, actor_user_id, operation_id, post_id,
         audio_revision, analysis_revision, canonical_audio_sha256, alignment_revision,
         status, current_artifact_ref, current_artifact_revision, author_persona_id,
         lyrics_revision
       ) VALUES ($1,$2,$3,$4,$5,$6,$6,$7,1,'ready','harness-artifact',1,$8,$9)`,
      [
        SUBMISSION_ID,
        COMMUNITY_ID,
        authorAccountId,
        OPERATION_ID,
        POST_ID,
        AUDIO_REVISION,
        CANONICAL_AUDIO_SHA256,
        authorPersonaId,
        LYRICS_REVISION,
      ],
    );
    await admin.query(
      `INSERT INTO media_timed_lyrics_artifacts (
         artifact_ref, community_id, actor_user_id, submission_id, operation_id,
         post_id, audio_revision, analysis_revision, artifact_revision,
         canonical_audio_sha256, artifact_sha256, artifact, author_persona_id,
         lyrics_revision
       ) VALUES ('harness-artifact',$1,$2,$3,$4,$5,$6,$6,1,$7,
         encode(sha256(convert_to($8::jsonb::text,'UTF8')),'hex'),$8::jsonb,$9,$10)`,
      [
        COMMUNITY_ID,
        authorAccountId,
        SUBMISSION_ID,
        OPERATION_ID,
        POST_ID,
        AUDIO_REVISION,
        CANONICAL_AUDIO_SHA256,
        JSON.stringify(artifact),
        authorPersonaId,
        LYRICS_REVISION,
      ],
    );
  } finally {
    await admin.query("SET session_replication_role = origin");
  }
}

async function existingPersona(admin: pg.Client, accountId: string): Promise<string | null> {
  const row = await admin.query(
    "SELECT persona_id FROM personas WHERE account_id=$1 AND is_first_persona",
    [accountId],
  );
  return typeof row.rows[0]?.persona_id === "string" ? row.rows[0].persona_id : null;
}

async function writeHarnessManifest(
  keys: ReturnType<typeof ensureHarnessKeys>,
  learners: readonly Readonly<{ accountId: string; personaId: string }>[],
): Promise<string> {
  const sessionCrypto = await makeSessionCrypto({
    privateKeyPem: keys.privateKeyPem,
    publicKeyPem: keys.publicKeyPem,
    issuer: SESSION_ISSUER,
    audience: SESSION_AUDIENCE,
    defaultScope: SESSION_SCOPE,
    defaultTtlSeconds: 3_600,
  });
  const minter = makeRs256SessionTokenMinter(sessionCrypto);
  const accounts = [];
  for (const learner of learners) {
    const sessionToken = await Effect.runPromise(
      minter.mint({ subject: learner.accountId, scope: SESSION_SCOPE }),
    );
    accounts.push({ ...learner, sessionToken });
  }
  mkdirSync(localDirectory, { recursive: true });
  const manifestPath = join(localDirectory, "harness.json");
  const first = accounts[0];
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        accountId: first?.accountId ?? "",
        accounts,
        appOrigin: "http://127.0.0.1:8787",
        apiOrigin: "http://127.0.0.1:8788",
        communityId: COMMUNITY_ID,
        csrfCookieName: "__Host-pirate_csrf",
        csrfToken: keys.csrfToken,
        negationLine: NEGATION_LINE,
        personaId: first?.personaId ?? "",
        postId: POST_ID,
        postSlug: POST_SLUG,
        sessionCookieName: "__Host-pirate_session",
        sessionToken: first?.sessionToken ?? "",
        studyLines: LYRIC_LINES.slice(0, 4),
      },
      null,
      2,
    )}\n`,
  );
  return manifestPath;
}

async function main(): Promise<void> {
  const keys = ensureHarnessKeys();
  const devVarsPath = writeDevVars(keys);
  const admin = new pg.Client({ connectionString: CONNECTION_STRING });
  await admin.connect();
  const learners: { accountId: string; personaId: string }[] = [];
  try {
    const authorAccountId = learnerAccountId(1);
    let authorPersonaId = await existingPersona(admin, authorAccountId);
    let seeded = false;
    for (let index = 1; index <= LEARNER_COUNT; index += 1) {
      const accountId = learnerAccountId(index);
      let personaId = await existingPersona(admin, accountId);
      if (personaId === null) {
        personaId = await provisionAccount(admin, accountId, index);
        if (!seeded) seeded = true;
      }
      if (index === 1) authorPersonaId = personaId;
      learners.push({ accountId, personaId });
    }
    if (seeded && authorPersonaId !== null) {
      await seedContent(admin, authorAccountId, authorPersonaId);
      for (const learner of learners) {
        await bindPersona(admin, learner.accountId, learner.personaId);
      }
      console.log("harness fixture seeded");
    } else {
      console.log("harness fixture already present; not reseeding");
    }
  } finally {
    await admin.end();
  }
  const manifestPath = await writeHarnessManifest(keys, learners);
  console.log(`dev vars: ${devVarsPath}`);
  console.log(`harness manifest: ${manifestPath}`);
}

if (import.meta.main) {
  await main();
}
