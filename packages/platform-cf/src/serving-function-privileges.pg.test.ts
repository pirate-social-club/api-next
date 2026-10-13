import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { KaraokeSessionAuthority } from "@pirate/application";
import { Effect } from "effect";
import { Client } from "pg";
import { loadPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import { makeCapturedKaraokeBindings } from "./captured-karaoke-bindings.ts";
import { makeControlPlaneKaraokeRepository } from "./karaoke-repository.ts";
import { makeOwnedOrdinaryAccountBirthFixture } from "./ordinary-study-account-birth.pg-fixture.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import {
  assertServingFunctionPrivileges,
  SERVING_FUNCTION_EXECUTE_DENIALS,
  SERVING_FUNCTION_EXECUTE_GRANTS,
  SERVING_FUNCTION_PRIVILEGE_MIGRATIONS,
  SERVING_FUNCTION_PRIVILEGES_SQL,
  ServingFunctionPrivilegesRefused,
  servingFunctionPrivilegeParameters,
} from "./serving-function-privileges.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !connectionString)
  throw new Error("Postgres test URL required");
const suite = connectionString ? describe : describe.skip;
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.scoped(effect));

async function seedKaraokeSong(admin: Client) {
  await admin.query("SET session_replication_role = replica");
  try {
    await admin.query(
      `INSERT INTO communities (community_id, display_name, status, created_by_user_id, created_at, updated_at)
       VALUES ('grant-community','Grant community','active','grant-author',clock_timestamp(),clock_timestamp())`,
    );
    await admin.query(
      `INSERT INTO community_memberships (community_id, membership_id, user_id, status, joined_at, created_at, updated_at)
       VALUES ('grant-community','grant-membership','grant-account','member',clock_timestamp(),clock_timestamp(),clock_timestamp())`,
    );
    await admin.query(
      `INSERT INTO personas (persona_id, account_id, status, is_first_persona, created_at, retired_at) VALUES
         ('grant-persona','grant-account','active',false,clock_timestamp(),NULL),
         ('grant-author-persona','grant-author','active',false,clock_timestamp(),NULL)`,
    );
    await admin.query(
      `INSERT INTO persona_community_bindings (persona_id, account_id, community_id, binding_source) VALUES
         ('grant-persona','grant-account','grant-community','first_membership'),
         ('grant-author-persona','grant-author','grant-community','community_creation')`,
    );
    await admin.query(
      `INSERT INTO posts (community_id, post_id, author_user_id, author_persona_id, post_type,
         status, visibility, title, created_at, updated_at)
       VALUES ('grant-community','grant-post','grant-author','grant-author-persona','song',
         'published','public','Grant song',clock_timestamp(),clock_timestamp())`,
    );
    await admin.query("UPDATE posts SET content_rating='general' WHERE post_id='grant-post'");
    await admin.query(
      `INSERT INTO media_post_submissions (submission_id, community_id, actor_user_id, operation_id,
         idempotency_key, request_hash, title, song_type, start_input, audio_reservation_id,
         creation_revision, audio_revision, analysis_revision, current_analysis_revision,
         current_immutable_ref, status, phase, post_id, response_snapshot_bytes,
         response_snapshot_sha256, author_persona_id, lyrics_revision, current_lyrics_revision)
       VALUES ('grant-submission','grant-community','grant-author','grant-operation','grant-idempotency',
         $1,'Grant song','original','{}'::jsonb,'grant-reservation',1,1,1,1,'audio-ref','published',
         NULL,'grant-post',convert_to('snapshot','UTF8'),encode(sha256(convert_to('snapshot','UTF8')),'hex'),
         'grant-author-persona',1,1)`,
      ["3".repeat(64)],
    );
    for (const [slot, sha256] of [
      ["instrumental_audio", "8".repeat(64)],
      ["vocal_audio", "9".repeat(64)],
    ] as const)
      await admin.query(
        `INSERT INTO media_song_stems (submission_id, slot, community_id, actor_user_id, operation_id,
           reservation_id, immutable_ref, destination_ref, etag, object_version, size_bytes,
           content_type, canonical_sha256, author_persona_id)
         VALUES ('grant-submission',$1,'grant-community','grant-author',$2,$3,$4,$5,'etag','version',16,
           'audio/mpeg',$6,'grant-author-persona')`,
        [
          slot,
          `grant-operation-stem-${slot}`,
          `grant-submission-reservation-${slot}`,
          `media://immutable/grant-operation-stem-${slot}/audio/1`,
          `r2://immutable/grant-operation-stem-${slot}/audio/1`,
          sha256,
        ],
      );
    await admin.query(
      "UPDATE activity_registry SET status='active', current_policy_version_id='karaoke_qualification_v2@1' WHERE activity_key='karaoke'",
    );
    const words = ["Hello", "Pirate"];
    await admin.query(
      `INSERT INTO media_publication_projections (submission_id, community_id, actor_user_id,
         operation_id, post_id, creation_revision, audio_revision, analysis_revision,
         decision_revision, canonical_audio_sha256, title, audio_asset_ref, language_status,
         primary_language_bcp47, lyrics_explicitness, alignment, data_registration, locked_delivery,
         projected_at, author_persona_id, lyrics_status, lyrics_revision, lyrics_text)
       VALUES ('grant-submission','grant-community','grant-author','grant-operation','grant-post',
         1,1,1,1,$1,'Grant song','audio-ref','ready','en','not_explicit','ready','registered',
         'not_required',clock_timestamp(),'grant-author-persona','ready',1,$2)`,
      ["1".repeat(64), words.join("\n")],
    );
    await admin.query(
      `INSERT INTO media_alignment_projections (submission_id, community_id, actor_user_id,
         operation_id, post_id, audio_revision, analysis_revision, canonical_audio_sha256,
         alignment_revision, status, current_artifact_ref, current_artifact_revision,
         author_persona_id, lyrics_revision)
       VALUES ('grant-submission','grant-community','grant-author','grant-operation','grant-post',
         1,1,$1,1,'ready','grant-artifact',1,'grant-author-persona',1)`,
      ["1".repeat(64)],
    );
    const artifact = {
      version: "media-timed-lyrics-artifact-v1",
      alignment_source_ref: "media://immutable/grant-operation-stem-vocal_audio/audio/1",
      alignment_source_sha256: "9".repeat(64),
      mode: "word",
      segments: words.map((text, index) => ({
        text,
        start_ms: index * 1000,
        end_ms: index * 1000 + 500,
      })),
    };
    await admin.query(
      `INSERT INTO media_timed_lyrics_artifacts (artifact_ref, community_id, actor_user_id,
         submission_id, operation_id, post_id, audio_revision, analysis_revision, artifact_revision,
         canonical_audio_sha256, artifact_sha256, artifact, author_persona_id, lyrics_revision)
       VALUES ('grant-artifact','grant-community','grant-author','grant-submission','grant-operation',
         'grant-post',1,1,1,$1,encode(sha256(convert_to($2::jsonb::text,'UTF8')),'hex'),$2::jsonb,
         'grant-author-persona',1)`,
      ["1".repeat(64), JSON.stringify(artifact)],
    );
    for (const [index, text] of words.entries()) {
      const line = `grant-line-${index + 1}`;
      const sourceHash = `${index + 2}`.repeat(64);
      await admin.query(
        "INSERT INTO localization_lyric_line_occurrences (community_id, post_id, lyric_line_id) VALUES ('grant-community','grant-post',$1)",
        [line],
      );
      await admin.query(
        `INSERT INTO localization_lyric_line_versions (community_id, post_id, lyric_line_id,
           line_version, canonical_text, source_language, source_hash)
         VALUES ('grant-community','grant-post',$1,1,$2,'en',$3)`,
        [line, text, sourceHash],
      );
      await admin.query(
        `INSERT INTO localization_lyrics_revision_lines (community_id, actor_user_id, post_id,
           submission_id, lyrics_revision, ordinal, lyric_line_id, line_version, source_hash)
         VALUES ('grant-community','grant-author','grant-post','grant-submission',1,$1,$2,1,$3)`,
        [index + 1, line, sourceHash],
      );
    }
  } finally {
    await admin.query("SET session_replication_role = origin");
  }
}

suite("Ordinary serving-role function grants", () => {
  test("the reviewed block alone admits registration and the account Karaoke cancellation path", async () => {
    if (!connectionString) throw new Error("Postgres test URL required");
    const suffix = randomUUID().replaceAll("-", "");
    const schema = `serving_functions_${suffix}`;
    const role = `serving_runtime_${suffix}`;
    const scoped = (as?: string) => {
      const url = new URL(connectionString);
      url.searchParams.set(
        "options",
        `-c search_path=${schema},pg_temp${as === undefined ? "" : ` -c role=${as}`}`,
      );
      return url.toString();
    };
    const admin = new Client({ connectionString });
    const serving = new Client({ connectionString: scoped(role) });
    await admin.connect();
    let roleCreated = false;
    const bridge = `serving_bridge_${suffix}`;
    let bridgeCreated = false;
    try {
      // Staging's order: the serving role was provisioned before 0247, then
      // 0247-0265 revoked their functions from it, then the ceremony applies
      // only the incremental function block.
      await admin.query("BEGIN");
      await admin.query(`CREATE SCHEMA ${schema}`);
      await admin.query(`SET search_path TO ${schema}, pg_temp`);
      const migrations = await loadPostgresMigrations();
      const first = migrations.findIndex((m) => m.version.startsWith("0247_"));
      expect(first).toBe(246);
      expect(Number(migrations.at(-1)?.version.slice(0, 4))).toBe(
        SERVING_FUNCTION_PRIVILEGE_MIGRATIONS.last,
      );
      for (const migration of migrations.slice(0, first)) await admin.query(migration.sql);
      const template = await readFile(
        new URL("../../../db/postgres/roles.sql.example", import.meta.url),
        "utf8",
      );
      const provisioning = template.split("-- Canonical M3")[0];
      if (!provisioning) throw new Error("Runtime role provisioning is missing");
      await admin.query(
        provisioning
          .replaceAll("api_next_app", role)
          .replaceAll("SCHEMA public", `SCHEMA ${schema}`),
      );
      roleCreated = true;
      for (const migration of migrations.slice(first)) await admin.query(migration.sql);
      await admin.query("COMMIT");
      await serving.connect();
      expect((await serving.query("SELECT current_user AS role")).rows).toEqual([{ role }]);

      const facts = async () =>
        (
          await serving.query(SERVING_FUNCTION_PRIVILEGES_SQL, [
            ...servingFunctionPrivilegeParameters(schema),
          ])
        ).rows;

      // Every private function 0247-0265 define is classified exactly once.
      const defined = new Set<string>();
      for (const migration of migrations.slice(first))
        for (const match of migration.sql.matchAll(
          /CREATE (?:OR REPLACE )?FUNCTION ([a-z0-9_]+)\(/gu,
        ))
          if (match[1]) defined.add(match[1]);
      const ownerOnly = (
        await admin.query<{ signature: string }>(
          `SELECT p.oid::regprocedure::text AS signature FROM pg_proc p
            WHERE p.pronamespace=$1::regnamespace
              AND NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
                WHERE a.grantee=0 AND a.privilege_type='EXECUTE')`,
          [schema],
        )
      ).rows
        .map((row) => row.signature)
        .filter((signature) => defined.has(signature.split("(")[0] ?? ""));
      expect(ownerOnly.slice().sort()).toEqual(
        [
          ...SERVING_FUNCTION_EXECUTE_GRANTS.map((grant) => grant.signature),
          ...SERVING_FUNCTION_EXECUTE_DENIALS,
        ]
          .slice()
          .sort(),
      );

      // After migrating, the serving role executes none of them.
      try {
        assertServingFunctionPrivileges(await facts());
        throw new Error("admitted before the grant block");
      } catch (error) {
        expect(error).toBeInstanceOf(ServingFunctionPrivilegesRefused);
        const failures = (error as ServingFunctionPrivilegesRefused).failures;
        expect(failures).toHaveLength(SERVING_FUNCTION_EXECUTE_GRANTS.length);
        for (const failure of failures) expect(failure).toEndWith("EXECUTE missing");
      }

      // Without the block, ordinary registration itself is refused.
      const runtime = makeDirectPostgresControlPlaneLayer(scoped(role));
      const birth = makeOwnedOrdinaryAccountBirthFixture(runtime);
      await expect(birth("grant-before-block")).rejects.toBeDefined();
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM users WHERE user_id='grant-before-block'",
          )
        ).rows,
      ).toEqual([{ n: 0 }]);

      // The block names exactly the listed signatures, and replay is idempotent.
      const block = template
        .split("-- Ordinary account function grants begin")[1]
        ?.split("-- Ordinary account function grants end")[0];
      if (!block) throw new Error("Ordinary account function grant block is missing");
      expect(block).not.toMatch(/\b(?:ON TABLE|ON ALL|ON SCHEMA|CREATE ROLE|GRANT [a-z_]+ TO)\b/iu);
      const named = [...block.matchAll(/GRANT EXECUTE ON FUNCTION ([a-z0-9_]+)\(([^)]*)\)/gu)].map(
        (match) => `${match[1]}(${(match[2] ?? "").replace(/\s+/gu, " ").trim()})`,
      );
      const resolved = (
        await admin.query<{ signature: string }>(
          "SELECT to_regprocedure(s)::text AS signature FROM unnest($1::text[]) s",
          [named],
        )
      ).rows.map((row) => row.signature);
      expect(resolved.slice().sort()).toEqual(
        SERVING_FUNCTION_EXECUTE_GRANTS.map((grant) => grant.signature)
          .slice()
          .sort(),
      );
      await admin.query(block.replaceAll("api_next_app", role));
      await admin.query(block.replaceAll("api_next_app", role));
      expect(assertServingFunctionPrivileges(await facts())).toBe(role);

      // Owner membership the role cannot inherit still lets it SET ROLE to the
      // owner and run every denial: refuse it directly and through another role.
      const owner = (
        await admin.query<{ owner: string }>(
          "SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid=$1::regclass",
          [`${schema}.participation_owners`],
        )
      ).rows[0]?.owner;
      if (!owner) throw new Error("schema owner missing");
      const ownerRole = `"${owner.replaceAll('"', '""')}"`;
      await admin.query(`CREATE ROLE ${bridge} NOLOGIN NOINHERIT`);
      bridgeCreated = true;
      for (const [grant, revoke] of [
        [
          `GRANT ${ownerRole} TO ${role} WITH INHERIT FALSE, SET TRUE`,
          `REVOKE ${ownerRole} FROM ${role}`,
        ],
        [
          `GRANT ${ownerRole} TO ${bridge} WITH INHERIT FALSE, SET TRUE; GRANT ${bridge} TO ${role} WITH INHERIT FALSE, SET TRUE`,
          `REVOKE ${bridge} FROM ${role}; REVOKE ${ownerRole} FROM ${bridge}`,
        ],
      ] as const) {
        await admin.query(grant);
        const rows = await facts();
        // Immediate access is unchanged, so only membership reveals the escalation.
        expect(rows.every((row) => row.can_execute === row.expected_execute)).toBe(true);
        expect(() => assertServingFunctionPrivileges(rows)).toThrow(
          ServingFunctionPrivilegesRefused,
        );
        await admin.query(revoke);
      }
      await admin.query(`GRANT ${ownerRole} TO ${role} WITH INHERIT FALSE, SET TRUE`);
      await serving.query(`SET ROLE ${ownerRole}`);
      expect(
        (
          await serving.query(
            "SELECT has_function_privilege(current_user,'close_unclaimed_learner_audio_private_v1(text)','EXECUTE') AS allowed",
          )
        ).rows,
      ).toEqual([{ allowed: true }]);
      await serving.query(`SET ROLE ${role}`);
      await admin.query(`REVOKE ${ownerRole} FROM ${role}`);
      expect(assertServingFunctionPrivileges(await facts())).toBe(role);

      // The generic upload closure stays owner-only.
      await expect(
        serving.query("SELECT close_unclaimed_learner_audio_private_v1('lau_any')"),
      ).rejects.toMatchObject({ code: "42501" });

      // Real registration and the real Karaoke attempt-host bindings, as the serving role.
      for (const account of ["grant-account", "grant-other", "grant-author"]) await birth(account);
      await seedKaraokeSong(admin);
      const repository = makeControlPlaneKaraokeRepository();
      const reserve = (key: string) =>
        run(
          repository
            .reserveSession({
              accountId: "grant-account",
              artifactId: `grant-artifact-${key}`,
              attemptId: `grant-attempt-${key}`,
              clientContext: undefined,
              communityId: "grant-community",
              createdAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
              idempotencyKey: key,
              personaId: "grant-persona",
              postId: "grant-post",
              requestHash: "a".repeat(64),
              sessionId: `grant-session-${key}`,
              timezone: "UTC",
            })
            .pipe(Effect.provide(runtime)),
        );
      const bind = (authority: KaraokeSessionAuthority) =>
        run(makeCapturedKaraokeBindings(runtime, authority));
      const uploadState = async (uploadAttemptId: string) =>
        (
          await admin.query(
            "SELECT io_state, storage_disposition FROM learner_audio_upload_attempts WHERE upload_attempt_id=$1",
            [uploadAttemptId],
          )
        ).rows;

      // A registered upload with no I/O closes as absent through the bound entry point.
      const cancelled = await reserve("cancelled");
      const binding = await bind(cancelled);
      expect(binding.capture.sourceKind).toBe("karaoke");
      expect(await binding.cancelUnclaimed()).toBe(true);
      expect(await uploadState(binding.capture.uploadAttemptId)).toEqual([
        { io_state: "closed", storage_disposition: "absent" },
      ]);
      expect(await binding.cancelUnclaimed()).toBe(false);

      // A claimed writer is never closed by cancellation.
      const writing = await bind(await reserve("writing"));
      expect(await run(writing.ledger.claim(writing.capture))).toEqual({ state: "write" });
      expect(await writing.cancelUnclaimed()).toBe(false);
      expect(await uploadState(writing.capture.uploadAttemptId)).toEqual([
        { io_state: "writing", storage_disposition: null },
      ]);

      // The entry point refuses any other account, attempt or capture generation.
      const fresh = await reserve("refusals");
      const target = await bind(fresh);
      const cancel = (args: readonly unknown[]) =>
        serving.query(
          "SELECT cancel_unclaimed_account_karaoke_audio_private_v1($1,$2,$3,$4,$5::jsonb) AS result",
          [...args],
        );
      const exact = [
        fresh.accountId,
        fresh.sessionId,
        fresh.attemptId,
        fresh.artifactId,
        JSON.stringify(target.capture),
      ];
      for (const args of [
        ["grant-other", ...exact.slice(1)],
        [fresh.accountId, writing.capture.commandRef, ...exact.slice(2)],
        [...exact.slice(0, 2), "grant-attempt-writing", ...exact.slice(3)],
        [...exact.slice(0, 4), JSON.stringify(writing.capture)],
        [...exact.slice(0, 4), JSON.stringify({ ...target.capture, capturedRevision: 99 })],
        [...exact.slice(0, 4), null],
      ])
        await expect(cancel(args)).rejects.toBeDefined();
      expect(await uploadState(target.capture.uploadAttemptId)).toEqual([
        { io_state: "registered", storage_disposition: null },
      ]);

      // Cancellation and mandatory claim serialize: exactly one of them wins.
      const [claimed, closed] = await Promise.all([
        run(target.ledger.claim(target.capture)),
        target.cancelUnclaimed(),
      ]);
      const after = await uploadState(target.capture.uploadAttemptId);
      if (closed) {
        expect(claimed).toEqual({ state: "failed" });
        expect(after).toEqual([{ io_state: "closed", storage_disposition: "absent" }]);
      } else {
        expect(claimed).toEqual({ state: "write" });
        expect(after).toEqual([{ io_state: "writing", storage_disposition: null }]);
      }
    } finally {
      await admin.query("ROLLBACK").catch(() => undefined);
      await serving.end().catch(() => undefined);
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
      if (bridgeCreated) await admin.query(`DROP ROLE IF EXISTS ${bridge}`).catch(() => undefined);
      if (roleCreated) {
        await admin.query(`DROP OWNED BY ${role}`).catch(() => undefined);
        await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
      }
      await admin.end().catch(() => undefined);
    }
  }, 240_000);
});
