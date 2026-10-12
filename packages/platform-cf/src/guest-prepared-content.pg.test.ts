// Real immutable 0001..0247 + actual private248, through the maintained runner.
// No rendered/regenerated baseline and no249 or guest authority producer.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import type { PreparedGuestStudyContentStore } from "@pirate/application";
import { GuestStudyPreparedContentV1 } from "@pirate/contracts";
import { Effect, Schema } from "effect";
import { Client } from "pg";
import { runPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import type { PostgresMigration } from "./postgres-migrations.ts";
import { makeControlPlanePreparedGuestStudyContentStore } from "./guest-prepared-study-content-store.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { insertStudySongFixture } from "./study-v2-ready-song.pg-fixture.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !connectionString) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the PostgreSQL17 suite");
}
const suite = connectionString ? describe : describe.skip;
const q = (value: string) => `"${value.replaceAll('"', '""')}"`;
const digest = async (value: string) =>
  Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString(
    "hex",
  );
const input: Parameters<PreparedGuestStudyContentStore["get"]>[0] = {
  communityId: "study-community",
  postId: "study-post",
  targetLanguage: null,
  learnerBand: null,
};
const disclosure = {
  version: "pg-fixture-disclosure-v1",
  text: "Synthetic fixture; reviewed runtime policy is supplied separately.",
};

// Same historical loader/fences as the populated preservation fixture. A
// draft248 is measured from its actual bytes; if declared, its manifest hash
// must also match. Historical hashes are never synthesized or overwritten.
async function migrationPacket() {
  const directory = new URL("../../../db/postgres/migrations/", import.meta.url);
  const manifest = JSON.parse(await readFile(new URL("checksums.json", directory), "utf8")) as {
    algorithm: string;
    migrations: Record<string, string>;
  };
  expect(manifest.algorithm).toBe("sha256");
  const names = (await readdir(directory))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name) && Number(name.slice(0, 4)) <= 247)
    .sort();
  expect(names).toHaveLength(247);
  expect(names.map((name) => Number(name.slice(0, 4)))).toEqual(
    Array.from({ length: 247 }, (_, i) => i + 1),
  );
  expect(names.at(-1)).toBe("0247_karaoke_instrumental_qualification_policy.sql");
  const readMigration = async (version: string): Promise<PostgresMigration> => {
    const sql = await readFile(new URL(version, directory), "utf8");
    return { version, sql, checksum: createHash("sha256").update(sql).digest("hex") };
  };
  const historical = await Promise.all(names.map(readMigration));
  for (const migration of historical) {
    const declared = manifest.migrations[migration.version];
    if (typeof declared !== "string") throw new Error("historical checksum missing");
    expect(migration.checksum).toBe(declared);
  }
  const foundation = await readMigration("0248_guest_learning_authority_foundation.sql");
  const declared = manifest.migrations[foundation.version];
  if (declared !== undefined) expect(foundation.checksum).toBe(declared);
  return { historical, foundation, through248: [...historical, foundation] };
}

// Only columns referenced by the real snapshot reader or public predicate.
// In particular, this does not grant prepared presentation/private-grader access.
const readColumns: Readonly<Record<string, readonly string[]>> = {
  posts: ["community_id", "post_id", "post_type", "status", "visibility", "content_rating"],
  communities: ["community_id", "status"],
  media_publication_projections: [
    "submission_id",
    "community_id",
    "post_id",
    "audio_revision",
    "lyrics_revision",
    "lyrics_status",
    "language_status",
  ],
  media_post_submissions: [
    "submission_id",
    "community_id",
    "post_id",
    "audio_revision",
    "current_lyrics_revision",
    "status",
  ],
  media_song_lyrics_revisions: ["submission_id", "lyrics_revision", "lyrics_sha256"],
  media_song_stems: ["submission_id", "community_id", "slot"],
  study_exercise_versions: [
    "exercise_review_key",
    "exercise_type",
    "learning_language",
    "target_language",
    "learner_band",
    "community_id",
    "post_id",
    "audio_revision",
    "lyrics_revision",
    "lyric_line_id",
    "line_version",
    "line_source_hash",
    "study_unit_id",
    "language_profile_revision",
    "retired_at",
    "content_revision",
  ],
  localization_lyrics_revision_lines: [
    "community_id",
    "post_id",
    "lyrics_revision",
    "lyric_line_id",
    "line_version",
  ],
  localization_lyric_line_versions: [
    "community_id",
    "post_id",
    "lyric_line_id",
    "line_version",
    "source_hash",
  ],
  localization_lyric_line_study_units: [
    "community_id",
    "post_id",
    "lyric_line_id",
    "line_version",
    "study_unit_id",
  ],
  study_language_profiles: [
    "community_id",
    "post_id",
    "lyrics_revision",
    "source_hash",
    "language_profile_revision",
  ],
  study_language_profile_units: [
    "community_id",
    "post_id",
    "lyrics_revision",
    "study_unit_id",
    "language_profile_revision",
  ],
};
const untouched = [
  "users",
  "personas",
  "community_memberships",
  "participation_owners",
  "guest_credentials",
  "guest_participation_operations",
  "study_sessions_v2",
  "study_attempts_v2",
  "study_spoken_answer_commands",
  "learner_audio_artifacts",
  "study_translation_generation_runs",
] as const;
const fingerprints = async (admin: Client) => {
  const result: Record<string, unknown> = {};
  for (const table of untouched) {
    result[table] = (
      await admin.query(`SELECT count(*)::int AS n,
      encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(t)
        ORDER BY to_jsonb(t)::text)::text,'[]'),'UTF8')),'hex') AS digest
      FROM ${q(table)} t`)
    ).rows[0];
  }
  return result;
};

// Adversarial data edits are confined to this test's fresh schema. The inherited
// shared fixture uses this same convention; the actual restricted reader never
// receives trigger-disabling, write, account, owner or provider capabilities.
async function editFixture(admin: Client, text: string, values: readonly unknown[] = []) {
  await admin.query("SET session_replication_role=replica");
  try {
    await admin.query(text, [...values]);
  } finally {
    await admin.query("SET session_replication_role=origin");
  }
}

async function withFixture(
  use: (f: {
    admin: Client;
    reader: Client;
    store: PreparedGuestStudyContentStore;
    schema: string;
    role: string;
    lyricsHash: string;
    lines: readonly string[];
  }) => Promise<void>,
) {
  if (!connectionString) throw new Error("test URL missing");
  const suffix = `${process.pid}_${crypto.randomUUID().replaceAll("-", "")}`;
  const schema = `gp_prepared_${suffix}`,
    role = `gp_reader_${suffix}`;
  const password =
    crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  const admin = new Client({
    connectionString,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 15_000,
  });
  let reader: Client | undefined;
  let schemaCreated = false,
    roleCreated = false;
  await admin.connect();
  try {
    await admin.query(`CREATE SCHEMA ${q(schema)}`);
    schemaCreated = true;
    await admin.query(`SET search_path TO ${q(schema)},pg_catalog`);
    const scoped = new URL(connectionString);
    scoped.searchParams.set("options", `-c search_path=${schema}`);
    const packet = await migrationPacket();
    await runPostgresMigrations({
      connectionString: scoped.toString(),
      migrations: packet.historical,
      expectedLedger: [],
    });
    await runPostgresMigrations({
      connectionString: scoped.toString(),
      migrations: packet.through248,
      expectedLedger: packet.historical,
    });
    expect(
      (await admin.query("SELECT version,checksum FROM schema_migrations ORDER BY version")).rows,
    ).toEqual(packet.through248.map(({ version, checksum }) => ({ version, checksum })));
    const { lines } = await insertStudySongFixture(admin);
    const lyrics = lines.join("\n"),
      lyricsHash = await digest(lyrics);
    // The ordinary shared fixture omits the accepted lyrics/profile records.
    // Use the same real immutable source keys and digest, not the Telegram dummy hash.
    await editFixture(
      admin,
      `INSERT INTO media_song_lyrics_revisions (
      submission_id,community_id,actor_user_id,author_persona_id,operation_id,
      lyrics_revision,creation_revision,audio_revision,canonical_audio_sha256,
      lyrics_text,lyrics_sha256,provenance
    ) VALUES ('study-submission','study-community','study-account','study-persona',
      'study-operation',1,2,1,$1,$2,$3,'pasted')`,
      ["2".repeat(64), lyrics, lyricsHash],
    );
    await editFixture(
      admin,
      `INSERT INTO study_language_profiles (
      community_id,post_id,lyrics_revision,language_profile_revision,source_hash,
      provider_id,provider_model,prompt_revision,validator_revision,request_hash,accepted_at
    ) VALUES ('study-community','study-post',1,1,$1,'fixture','fixture','fixture','fixture',$1,clock_timestamp())`,
      [lyricsHash],
    );
    for (let ordinal = 1; ordinal <= 4; ordinal++) {
      await editFixture(
        admin,
        `INSERT INTO study_language_profile_units (
        community_id,post_id,lyrics_revision,language_profile_revision,study_unit_id,
        detected_languages,dominant_language,mixed,vocable_only,proper_name_only,confidence
      ) VALUES ('study-community','study-post',1,1,$1,'["en"]','en',FALSE,FALSE,FALSE,0.99)`,
        [`unit-${ordinal}`],
      );
    }
    await admin.query(`CREATE ROLE ${q(role)} LOGIN PASSWORD '${password}'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    roleCreated = true;
    await admin.query(`ALTER ROLE ${q(role)} SET default_transaction_read_only=on`);
    await admin.query(`ALTER ROLE ${q(role)} SET statement_timeout='2s'`);
    await admin.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${q(schema)} FROM PUBLIC,${q(role)};
      REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${q(schema)} FROM PUBLIC,${q(role)};
      GRANT USAGE ON SCHEMA ${q(schema)} TO ${q(role)}`);
    for (const [table, columns] of Object.entries(readColumns)) {
      await admin.query(
        `GRANT SELECT(${columns.map(q).join(",")}) ON ${q(schema)}.${q(table)} TO ${q(role)}`,
      );
    }
    await admin.query(
      `GRANT EXECUTE ON FUNCTION ${q(schema)}.can_guest_access_activity_song_v1(text,text) TO ${q(role)}`,
    );
    const readerUrl = new URL(scoped);
    readerUrl.username = role;
    readerUrl.password = password;
    reader = new Client({
      connectionString: readerUrl.toString(),
      connectionTimeoutMillis: 5_000,
      statement_timeout: 2_000,
    });
    await reader.connect();
    const runtime = makeDirectPostgresControlPlaneLayer(readerUrl.toString(), {
      statementTimeoutMs: 2_000,
      closeTimeoutMs: 2_000,
    });
    const store = makeControlPlanePreparedGuestStudyContentStore(runtime, disclosure);
    await use({ admin, reader, store, schema, role, lyricsHash, lines });
  } finally {
    if (reader) await reader.end();
    await admin.query("ROLLBACK").catch(() => undefined);
    try {
      if (schemaCreated) await admin.query(`DROP SCHEMA ${q(schema)} CASCADE`);
      if (roleCreated) await admin.query(`DROP OWNED BY ${q(role)}; DROP ROLE ${q(role)}`);
    } finally {
      await admin.end();
    }
  }
}

const get = (store: PreparedGuestStudyContentStore, selection = input) =>
  Effect.runPromise(Effect.scoped(store.get(selection)));
const unavailable = (reason: string) => ({ state: "unavailable", reason });
async function notFound(store: PreparedGuestStudyContentStore) {
  const error = await Effect.runPromise(Effect.scoped(Effect.flip(store.get(input))));
  expect(error._tag).toBe("GuestParticipationStoreRejected");
  if (error._tag !== "GuestParticipationStoreRejected") throw new Error("expected public refusal");
  expect(error.reason).toBe("not-found");
}

async function translation(admin: Client, ordinal: number, helper: string, band: "A1" | "B1") {
  const id = `prepared-${helper}-${band}-${ordinal}`;
  const patch = {
    exercise_version_id: id,
    exercise_review_key: `translation:${helper}:${band}:unit-${ordinal}`,
    exercise_type: "translation_choice",
    exercise_variant: "whole-line-v1",
    target_language: helper,
    learner_band: band,
    language_profile_revision: 1,
    retired_at: null,
    answer_visibility: "secret_until_spent",
    feedback_release: "spent_only",
    grader_policy_revision: "exact_choice_v1",
    feedback_policy_revision: "choice-reveal-v1",
    generation_kind: "provider_generated",
    provider_model: "fixture-model",
    generation_run_id: `fixture-${id}`,
    producer_id: "fixture-prepared-translation",
    presentation: {
      kind: "translation_choice",
      source_text: "Synthetic prepared line",
      question: "Choose the prepared meaning",
      capture: "choice_selection",
      choices: ["a", "b", "c", "d"].map((choice_key) => ({
        choice_key,
        text: `Fixture ${choice_key}`,
      })),
    },
    private_grader: {
      kind: "exact_choice_v1",
      correct_choice_key: "a",
      correct_text: "Fixture a",
      explanation: "Fixture only",
    },
  };
  // Copy the exact current accepted line/unit/source provenance. No generator runs.
  await admin.query(
    `INSERT INTO study_exercise_versions
    SELECT (jsonb_populate_record(NULL::study_exercise_versions,to_jsonb(source)||$2::jsonb)).*
      FROM study_exercise_versions source WHERE exercise_version_id=$1`,
    [`exercise-${ordinal}`, JSON.stringify(patch)],
  );
}

suite("public prepared guest Study real PostgreSQL query", () => {
  test("source-only readiness needs no caller account or guest authority and only minimal read privileges", async () => {
    await withFixture(async ({ admin, reader, store, schema, role }) => {
      expect(
        (
          await reader.query(
            "SELECT current_user,session_user,current_setting('default_transaction_read_only') AS ro",
          )
        ).rows,
      ).toEqual([{ current_user: role, session_user: role, ro: "on" }]);
      expect(
        (
          await reader.query(
            "SELECT rolsuper,rolcreaterole,rolcreatedb,rolbypassrls FROM pg_roles WHERE rolname=current_user",
          )
        ).rows,
      ).toEqual([
        { rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false },
      ]);
      expect(
        (
          await reader.query("SELECT has_schema_privilege(current_user,$1,'CREATE') AS allowed", [
            schema,
          ])
        ).rows[0]?.allowed,
      ).toBe(false);
      for (const table of [
        "users",
        "personas",
        "community_memberships",
        "participation_owners",
        "guest_credentials",
      ]) {
        await expect(reader.query(`SELECT * FROM ${q(table)} LIMIT 1`)).rejects.toMatchObject({
          code: "42501",
        });
      }
      await expect(
        reader.query("SELECT private_grader FROM study_exercise_versions LIMIT 1"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        reader.query(
          "SELECT read_guest_credential_proof_matches_v1('https://fixture.example','[]',FALSE)",
        ),
      ).rejects.toMatchObject({ code: "42501" });
      expect(
        (
          await reader.query(
            "SELECT has_column_privilege(current_user,'posts','visibility','UPDATE') AS allowed",
          )
        ).rows[0]?.allowed,
      ).toBe(false);
      const denied = await reader
        .query("UPDATE posts SET visibility='members_only' WHERE post_id='study-post'")
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(denied).not.toBeNull();
      expect(["42501", "25006"]).toContain((denied as { code: string }).code);
      const before = await fingerprints(admin);
      const result = await get(store);
      expect(result).toEqual({
        object: "guest_study_prepared_content_v1",
        availability: {
          state: "ready",
          available_exercise_types: ["say_it_back"],
          learning_language: "en",
          target_languages: [],
          learner_bands: [],
        },
        disclosure,
        reward_preview: null,
      });
      expect(Schema.decodeUnknownSync(GuestStudyPreparedContentV1)(result)).toEqual(result);
      expect(await fingerprints(admin)).toEqual(before);
    });
  }, 90_000);

  test("compatible helper/band groups are real prepared rows; a band-only query cannot drop its matching helpers", async () => {
    await withFixture(async ({ admin, store }) => {
      await editFixture(
        admin,
        "UPDATE study_exercise_versions SET retired_at=clock_timestamp() WHERE exercise_version_id IN('exercise-3','exercise-4')",
      );
      await translation(admin, 1, "ar", "B1");
      await translation(admin, 2, "ar", "B1");
      await translation(admin, 1, "zh", "A1");
      const before = await fingerprints(admin);
      expect(
        (await get(store, { ...input, targetLanguage: "ar", learnerBand: "B1" })).availability
          .state,
      ).toBe("ready");
      expect(
        (await get(store, { ...input, targetLanguage: "zh", learnerBand: "A1" })).availability
          .state,
      ).toBe("processing");
      expect(
        (await get(store, { ...input, targetLanguage: "zh", learnerBand: "B1" })).availability
          .state,
      ).toBe("processing");
      expect((await get(store, { ...input, learnerBand: "B1" })).availability.state).toBe("ready");
      await translation(admin, 3, "ar", "B1");
      await translation(admin, 4, "ar", "B1");
      for (const ordinal of [2, 3, 4]) await translation(admin, ordinal, "zh", "A1");
      await editFixture(
        admin,
        "UPDATE study_exercise_versions SET retired_at=clock_timestamp() WHERE exercise_type='say_it_back'",
      );
      expect((await get(store, { ...input, learnerBand: "B1" })).availability).toEqual({
        state: "ready",
        available_exercise_types: ["translation_choice"],
        learning_language: "en",
        target_languages: ["ar", "zh"],
        learner_bands: ["A1", "B1"],
      });
      expect((await get(store, { ...input, learnerBand: "C2" })).availability).toEqual(
        unavailable("insufficient_exercises"),
      );
      expect(
        (await get(store, { ...input, targetLanguage: "zh", learnerBand: "B1" })).availability,
      ).toEqual(unavailable("insufficient_exercises"));
      // Remove a real profile/unit closure for one matching B1 card. Three
      // remaining translations cannot become four through another band/helper.
      await editFixture(
        admin,
        "UPDATE study_exercise_versions SET study_unit_id='unit-2' WHERE exercise_version_id='prepared-ar-B1-1'",
      );
      expect((await get(store, { ...input, learnerBand: "B1" })).availability.state).toBe(
        "processing",
      );
      expect(await fingerprints(admin)).toEqual(before);
    });
  }, 90_000);

  test("current accepted profile and line/version/hash/Study-unit identities filter stale or mismatched exercises", async () => {
    await withFixture(async ({ admin, store, lyricsHash, lines }) => {
      expect((await get(store)).availability.state).toBe("ready");
      const lineHash = await digest(lines[0] ?? "");
      const variants: readonly [string, readonly unknown[], string, readonly unknown[]][] = [
        [
          "UPDATE study_exercise_versions SET audio_revision=2 WHERE exercise_version_id='exercise-1'",
          [],
          "UPDATE study_exercise_versions SET audio_revision=1 WHERE exercise_version_id='exercise-1'",
          [],
        ],
        [
          "UPDATE study_exercise_versions SET line_version=2 WHERE exercise_version_id='exercise-1'",
          [],
          "UPDATE study_exercise_versions SET line_version=1 WHERE exercise_version_id='exercise-1'",
          [],
        ],
        [
          "UPDATE study_exercise_versions SET line_source_hash=$1 WHERE exercise_version_id='exercise-1'",
          ["e".repeat(64)],
          "UPDATE study_exercise_versions SET line_source_hash=$1 WHERE exercise_version_id='exercise-1'",
          [lineHash],
        ],
        [
          "UPDATE study_exercise_versions SET study_unit_id='unit-2' WHERE exercise_version_id='exercise-1'",
          [],
          "UPDATE study_exercise_versions SET study_unit_id='unit-1' WHERE exercise_version_id='exercise-1'",
          [],
        ],
        [
          "UPDATE study_exercise_versions SET language_profile_revision=2 WHERE exercise_version_id='exercise-1'",
          [],
          "UPDATE study_exercise_versions SET language_profile_revision=NULL WHERE exercise_version_id='exercise-1'",
          [],
        ],
      ];
      const before = await fingerprints(admin);
      for (const [change, values, restore, restoreValues] of variants) {
        await editFixture(admin, change, values);
        expect((await get(store)).availability.state).toBe("processing");
        await editFixture(admin, restore, restoreValues);
        expect((await get(store)).availability.state).toBe("ready");
      }
      await editFixture(admin, "UPDATE study_language_profiles SET source_hash=$1", [
        "e".repeat(64),
      ]);
      expect((await get(store)).availability).toEqual(unavailable("insufficient_exercises"));
      await editFixture(admin, "UPDATE study_language_profiles SET source_hash=$1", [lyricsHash]);
      expect((await get(store)).availability.state).toBe("ready");
      await editFixture(
        admin,
        "UPDATE study_language_profile_units SET language_profile_revision=2 WHERE study_unit_id='unit-1'",
      );
      expect((await get(store)).availability.state).toBe("processing");
      await editFixture(
        admin,
        "UPDATE study_language_profile_units SET language_profile_revision=1 WHERE study_unit_id='unit-1'",
      );
      await editFixture(
        admin,
        "UPDATE study_exercise_versions SET retired_at=clock_timestamp() WHERE exercise_version_id='exercise-4'",
      );
      await admin.query(`INSERT INTO study_exercise_versions
        SELECT (jsonb_populate_record(NULL::study_exercise_versions,to_jsonb(source)||
          '{"exercise_version_id":"duplicate-source-version","content_revision":2}'::jsonb)).*
          FROM study_exercise_versions source WHERE exercise_version_id='exercise-1'`);
      // There are four active version rows but only three unique review keys.
      expect((await get(store)).availability.state).toBe("processing");
      expect(await fingerprints(admin)).toEqual(before);
    });
  }, 90_000);

  test("the real public predicate and publication/current lyrics/audio/stem checks cannot advertise stale readiness", async () => {
    await withFixture(async ({ admin, store }) => {
      const before = await fingerprints(admin);
      for (const [column, hidden, visible] of [
        ["visibility", "members_only", "public"],
        ["status", "draft", "published"],
        ["content_rating", "adult_18", "general"],
        ["post_type", "text", "song"],
      ]) {
        await editFixture(
          admin,
          `UPDATE posts SET ${q(column as string)}=$1 WHERE post_id='study-post'`,
          [hidden],
        );
        await notFound(store);
        await editFixture(
          admin,
          `UPDATE posts SET ${q(column as string)}=$1 WHERE post_id='study-post'`,
          [visible],
        );
        expect((await get(store)).availability.state).toBe("ready");
      }
      await editFixture(
        admin,
        "UPDATE media_publication_projections SET audio_revision=2 WHERE post_id='study-post'",
      );
      expect((await get(store)).availability).toEqual(unavailable("lyrics_not_accepted"));
      await editFixture(
        admin,
        "UPDATE media_publication_projections SET audio_revision=1,lyrics_revision=2 WHERE post_id='study-post'",
      );
      expect((await get(store)).availability).toEqual(unavailable("lyrics_not_accepted"));
      await editFixture(
        admin,
        "UPDATE media_publication_projections SET lyrics_revision=1 WHERE post_id='study-post'",
      );
      expect((await get(store)).availability.state).toBe("ready");
      await editFixture(
        admin,
        "DELETE FROM media_song_stems WHERE submission_id='study-submission' AND slot='vocal_audio'",
      );
      expect((await get(store)).availability).toEqual(unavailable("stems_missing"));
      expect(await fingerprints(admin)).toEqual(before);
    });
  }, 90_000);
});
