import { describe, expect, test } from "bun:test";
import { getKaraokePlaybackAccess } from "@pirate/application/use-cases/content/song-playback";
import { Effect } from "effect";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { authorizeKaraokePlayback } from "./karaoke-playback-authority.ts";
import { makeControlPlaneKaraokeReadinessStore } from "./karaoke-readiness-repository.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { authorizeSongPlayback } from "./song-playback-authority.ts";
import { insertStudySongFixture } from "./study-v2-ready-song.pg-fixture.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && connectionString === undefined)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
const suite = connectionString === undefined ? describe.skip : describe;
const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const scopedConnection = (raw: string, schema: string, role?: string) =>
  `${raw}${raw.includes("?") ? "&" : "?"}options=${encodeURIComponent(
    `-c search_path=${schema}${role === undefined ? "" : ` -c role=${role}`}`,
  )}`;

async function seedPlaybackAuthority(admin: Client, lines: readonly string[]) {
  const hash = "2".repeat(64);
  await admin.query("SET session_replication_role=replica");
  try {
    await admin.query(
      "UPDATE media_post_submissions SET creation_revision=2,current_decision_revision=1 WHERE submission_id='study-submission'",
    );
    await admin.query(
      "UPDATE media_publication_projections SET creation_revision=2,content_rating='general' WHERE submission_id='study-submission'",
    );
    await admin.query(
      `INSERT INTO media_publication_decisions
      (submission_id,community_id,actor_user_id,operation_id,decision_revision,creation_revision,
       audio_revision,analysis_revision,canonical_audio_sha256,outcome,policy_revision,evidence_ref,
       decision_snapshot,author_persona_id,lyrics_revision)
      VALUES ('study-submission','study-community','study-account','study-operation',1,2,1,1,$1,
        'allow','fixture-policy','fixture-evidence','{}','study-persona',1)`,
      [hash],
    );
    await admin.query(
      `INSERT INTO media_audio_revisions
      (submission_id,community_id,actor_user_id,operation_id,audio_revision,immutable_ref,
       canonical_sha256,content_type,size_bytes,author_persona_id)
      VALUES ('study-submission','study-community','study-account','study-operation',1,'audio-ref',
        $1,'audio/mpeg',1024,'study-persona')`,
      [hash],
    );
    await admin.query(
      `INSERT INTO media_immutable_objects
      (immutable_ref,community_id,actor_user_id,submission_id,operation_id,destination_ref,
       etag,object_version,size_bytes,content_type,canonical_sha256,author_persona_id)
      VALUES ('audio-ref','study-community','study-account','study-submission','study-operation',
        'r2://fixture/audio','etag','version',1024,'audio/mpeg',$1,'study-persona')`,
      [hash],
    );
    const artifact = {
      version: "media-timed-lyrics-artifact-v1",
      mode: "word",
      alignment_source_ref: "sealed-ref-vocal_audio",
      alignment_source_sha256: "b".repeat(64),
      segments: lines.flatMap((line, lineIndex) =>
        line.split(" ").map((text, wordIndex) => ({
          text,
          start_ms: lineIndex * 2000 + wordIndex * 200,
          end_ms: lineIndex * 2000 + wordIndex * 200 + 150,
        })),
      ),
    };
    await admin.query(
      `INSERT INTO media_timed_lyrics_artifacts
      (artifact_ref,community_id,actor_user_id,submission_id,operation_id,post_id,audio_revision,
       analysis_revision,artifact_revision,canonical_audio_sha256,artifact_sha256,artifact,
       author_persona_id,lyrics_revision)
      VALUES ('playback-artifact','study-community','study-account','study-submission','study-operation',
        'study-post',1,1,1,$1,$2,$3::jsonb,'study-persona',1)`,
      [hash, "c".repeat(64), JSON.stringify(artifact)],
    );
    await admin.query(
      `INSERT INTO media_alignment_projections
      (submission_id,community_id,actor_user_id,operation_id,post_id,audio_revision,analysis_revision,
       canonical_audio_sha256,alignment_revision,status,current_artifact_ref,current_artifact_revision,
       author_persona_id,lyrics_revision)
      VALUES ('study-submission','study-community','study-account','study-operation','study-post',1,1,
        $1,1,'ready','playback-artifact',1,'study-persona',1)`,
      [hash],
    );
  } finally {
    await admin.query("SET session_replication_role=origin");
  }
}

suite("Karaoke playback source binding under a restricted reader", () => {
  test("binds the accepted ready source and refuses stale, inaccessible or incomplete sources before signing", async () => {
    if (connectionString === undefined) throw new Error("test URL was not configured");
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const schema = `karaoke_playback_${suffix}`;
    const role = `karaoke_reader_${suffix}`;
    const admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    let roleCreated = false;
    try {
      await applyPostgresTestBaselineConnection({
        connectionString: scopedConnection(connectionString, schema),
      });
      const { lines } = await insertStudySongFixture(admin);
      await seedPlaybackAuthority(admin, lines);
      await admin.query(`CREATE ROLE ${quoteIdentifier(role)} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
      roleCreated = true;
      await admin.query(
        `GRANT USAGE ON SCHEMA ${quoteIdentifier(schema)} TO ${quoteIdentifier(role)}`,
      );
      await admin.query(
        `GRANT SELECT ON ALL TABLES IN SCHEMA ${quoteIdentifier(schema)} TO ${quoteIdentifier(role)}`,
      );
      await admin.query(
        `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${quoteIdentifier(schema)} TO ${quoteIdentifier(role)}`,
      );
      const runtime = makeDirectPostgresControlPlaneLayer(
        scopedConnection(connectionString, schema, role),
      );
      const readiness = await makeControlPlaneKaraokeReadinessStore(runtime).get({
        communityId: "study-community",
        postId: "study-post",
      });
      expect(readiness.state).toBe("ready");
      if (readiness.state !== "ready") throw new Error("fixture must be ready");
      const target = {
        postId: readiness.post_id,
        communityId: readiness.community_id,
        karaokeRevisionId: readiness.karaoke_revision_id,
        playbackRef: readiness.playback_audio.ref,
        trustedSource: "198.51.100.1",
      };
      let signs = 0;
      const grant = (overrides: Partial<typeof target> = {}) =>
        Effect.runPromise(
          Effect.scoped(
            getKaraokePlaybackAccess(
              { ...target, ...overrides },
              {
                authorize: (input) => authorizeKaraokePlayback(input).pipe(Effect.provide(runtime)),
                limit: () => Effect.succeed({ allowed: true, retryAfterSeconds: 0 }),
                nowMs: Effect.succeed(1_000_000),
                sign: ({ immutableRef }) =>
                  Effect.sync(() => {
                    signs++;
                    expect(immutableRef).toBe(target.playbackRef);
                    return "https://audio.example.test/signed";
                  }),
              },
            ),
          ),
        );
      const first = await grant();
      expect(first).toMatchObject({
        post_id: target.postId,
        community_id: target.communityId,
        karaoke_revision_id: target.karaokeRevisionId,
        playback_audio: { kind: "instrumental", ref: target.playbackRef },
        expires_at: 1900,
        renew_after: 1840,
      });
      expect(await grant()).toEqual(first);
      const refuse = async (overrides: Partial<typeof target> = {}) => {
        const before = signs;
        await expect(grant(overrides)).rejects.toMatchObject({ _tag: "NotFound" });
        expect(signs).toBe(before);
      };
      for (const overrides of [
        { postId: "foreign-post" },
        { communityId: "foreign-community" },
        { karaokeRevisionId: "stale-revision" },
        { playbackRef: "audio-ref" },
        { playbackRef: "media://immutable/unrelated" },
      ])
        await refuse(overrides);
      const mutate = async (sql: string, values: unknown[] = []) => {
        await admin.query("SET session_replication_role=replica");
        try {
          await admin.query(sql, values);
        } finally {
          await admin.query("SET session_replication_role=origin");
        }
      };
      for (const slot of ["vocal_audio", "instrumental_audio"]) {
        await mutate("DELETE FROM media_song_stems WHERE slot=$1", [slot]);
        await refuse();
        expect(
          await Effect.runPromise(
            Effect.scoped(
              authorizeSongPlayback({ postId: target.postId }).pipe(Effect.provide(runtime)),
            ),
          ),
        ).toEqual({ immutableRef: "audio-ref" });
        await mutate(
          `INSERT INTO media_song_stems
          (submission_id,slot,community_id,actor_user_id,operation_id,reservation_id,immutable_ref,
           destination_ref,etag,object_version,size_bytes,content_type,canonical_sha256,author_persona_id)
          VALUES ('study-submission',$1,'study-community','study-account','study-operation',$1,
            'sealed-ref-'||$1,'sealed-destination-'||$1,'etag','version',1024,'audio/mpeg',$2,'study-persona')`,
          [slot, "b".repeat(64)],
        );
      }
      for (const [change, restore] of [
        ["UPDATE posts SET visibility='members_only'", "UPDATE posts SET visibility='public'"],
        ["UPDATE posts SET content_rating='adult_18'", "UPDATE posts SET content_rating='general'"],
        [
          "UPDATE media_publication_projections SET content_rating='adult_18'",
          "UPDATE media_publication_projections SET content_rating='general'",
        ],
        [
          "UPDATE media_alignment_projections SET status='pending'",
          "UPDATE media_alignment_projections SET status='ready'",
        ],
        [
          "UPDATE media_publication_decisions SET outcome='block'",
          "UPDATE media_publication_decisions SET outcome='allow'",
        ],
        [
          "UPDATE media_timed_lyrics_artifacts SET artifact=jsonb_set(artifact,'{alignment_source_ref}','\"audio-ref\"')",
          "UPDATE media_timed_lyrics_artifacts SET artifact=jsonb_set(artifact,'{alignment_source_ref}','\"sealed-ref-vocal_audio\"')",
        ],
        [
          "UPDATE media_timed_lyrics_artifacts SET artifact=jsonb_set(artifact,'{alignment_source_sha256}','\"wrong\"')",
          `UPDATE media_timed_lyrics_artifacts SET artifact=jsonb_set(artifact,'{alignment_source_sha256}','"${"b".repeat(64)}"')`,
        ],
        [
          "UPDATE media_timed_lyrics_artifacts SET artifact_sha256=repeat('d',64)",
          "UPDATE media_timed_lyrics_artifacts SET artifact_sha256=repeat('c',64)",
        ],
      ]) {
        await mutate(change);
        await refuse();
        await mutate(restore);
      }
      expect(await grant()).toEqual(first);
      const restricted = new Client({
        connectionString: scopedConnection(connectionString, schema, role),
      });
      await restricted.connect();
      try {
        expect(
          (
            await restricted.query(
              "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
            )
          ).rows,
        ).toEqual([{ rolsuper: false, rolbypassrls: false }]);
        await expect(restricted.query("DELETE FROM media_song_stems")).rejects.toMatchObject({
          code: "42501",
        });
      } finally {
        await restricted.end();
      }
    } finally {
      if (roleCreated) await admin.query(`DROP OWNED BY ${quoteIdentifier(role)}`);
      if (roleCreated) await admin.query(`DROP ROLE ${quoteIdentifier(role)}`);
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      await admin.end();
    }
  }, 60_000);
});
