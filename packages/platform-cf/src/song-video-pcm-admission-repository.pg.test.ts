import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "pg";
import { runPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import {
  makeSongPcmAdmissionRepository,
  songPcmOutputKey,
} from "./song-video-pcm-admission-repository.ts";
import { SONG_VIDEO_PCM_DECODER_RECIPE } from "./song-video-pcm-job.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !connectionString)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
const suite = connectionString ? describe : describe.skip;
const sha = "a".repeat(64);
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("fixture claim missing");
  return value;
}

suite("automatic song timing and PCM admission", () => {
  const schema = `song_pcm_admission_${crypto.randomUUID().replaceAll("-", "")}`;
  const url = new URL(connectionString ?? "postgres://unused/unused");
  url.searchParams.set("options", `-c search_path=${schema}`);
  const admin = new Client({ connectionString });
  const client = new Client({ connectionString: url.toString() });
  const repository = makeSongPcmAdmissionRepository({
    connect: async () => {
      const c = new Client({ connectionString: url.toString() });
      await c.connect();
      return c;
    },
  });
  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await runPostgresMigrations({ connectionString: url.toString() });
    await client.connect();
  }, 180_000);
  afterAll(async () => {
    await client.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });
  async function pending(post: string) {
    const id = `song-pcm-${"0".repeat(64 - post.length)}${Buffer.from(post).toString("hex").slice(0, post.length)}`;
    await client.query(
      `INSERT INTO media_song_video_pcm_admissions
      (admission_id,song_post_id,song_community_id,audio_revision,canonical_audio_sha256,audio_asset_ref)
      VALUES ($1,$2,'crew',1,$3,'media://immutable/source.mp3')`,
      [id, post, sha],
    );
    await client.query(
      `INSERT INTO media_song_canonical_timings
      (song_post_id,song_community_id,audio_revision,canonical_audio_sha256,state)
      VALUES ($1,'crew',1,$2,'pending')`,
      [post, sha],
    );
    return id;
  }
  async function timing(post: string) {
    await client.query(
      `UPDATE media_song_canonical_timings SET state='ready',duration_samples=480000,
      prober_identity=$2,prober_policy_revision=1,measured_at=clock_timestamp()
      WHERE song_post_id=$1`,
      [post, SONG_VIDEO_PCM_DECODER_RECIPE],
    );
  }
  async function reference(post: string, id: string) {
    await client.query(
      `INSERT INTO media_song_video_pcm_references
      (song_post_id,audio_revision,canonical_audio_sha256,duration_samples,pcm_object_key,
       pcm_object_version,pcm_object_etag,pcm_sha256,pcm_byte_length,decoder_recipe)
      VALUES ($1,1,$2,480000,$3,'version','etag',$4,1920000,$5)`,
      [post, sha, songPcmOutputKey(id), "b".repeat(64), SONG_VIDEO_PCM_DECODER_RECIPE],
    );
  }

  test("publication admission starts disabled", async () => {
    expect(
      (await client.query("SELECT enabled FROM media_song_video_pcm_admission_policy")).rows,
    ).toEqual([{ enabled: false }]);
  });
  // Seed upstream publication facts with their unrelated causal triggers bypassed,
  // while the admission trigger under test stays live in the same transaction.
  async function publicationFixture(post: string, revision = 1) {
    await client.query("SET session_replication_role=replica");
    await client.query(
      "ALTER TABLE media_publication_projections ENABLE ALWAYS TRIGGER media_publication_song_pcm_admission",
    );
    try {
      await client.query("UPDATE media_song_video_pcm_admission_policy SET enabled=true");
      await client.query(
        `INSERT INTO media_publication_projections
        (submission_id,community_id,actor_user_id,operation_id,post_id,creation_revision,
         audio_revision,analysis_revision,decision_revision,canonical_audio_sha256,title,
         audio_asset_ref,language_status,primary_language_bcp47,lyrics_explicitness,
         alignment,data_registration,locked_delivery,author_persona_id,lyrics_status)
        VALUES ($1,'crew','actor',$2,$3,1,$4,1,1,$5,'PCM fixture',
          'media://immutable/source.mp3','ready','en','not_explicit','ready','registered',
          'not_required','persona','no_lyrics')`,
        [`submission-${post}`, `operation-${post}`, post, revision, sha],
      );
    } finally {
      await client.query(
        "ALTER TABLE media_publication_projections ENABLE TRIGGER media_publication_song_pcm_admission",
      );
      await client.query("SET session_replication_role=origin");
    }
  }

  test("publication requests pending timing and PCM together, including rollback", async () => {
    await client.query("BEGIN");
    try {
      await publicationFixture("rollback-publication");
      expect(
        (
          await client.query(
            "SELECT count(*)::int AS n FROM media_song_video_pcm_admissions WHERE song_post_id='rollback-publication'",
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        (
          await client.query(
            "SELECT state FROM media_song_canonical_timings WHERE song_post_id='rollback-publication'",
          )
        ).rows,
      ).toEqual([{ state: "pending" }]);
    } finally {
      await client.query("ROLLBACK");
    }
    expect(
      (
        await client.query(
          "SELECT count(*)::int AS n FROM media_song_video_pcm_admissions WHERE song_post_id='rollback-publication'",
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await client.query(
          "SELECT count(*)::int AS n FROM media_song_canonical_timings WHERE song_post_id='rollback-publication'",
        )
      ).rows[0].n,
    ).toBe(0);
  });

  test("repository admission commits exact timing and PCM for a current publication", async () => {
    await publicationFixture("repository-atomic");
    const id = (
      await client.query(
        "SELECT admission_id FROM media_song_video_pcm_admissions WHERE song_post_id='repository-atomic'",
      )
    ).rows[0].admission_id as string;
    const claim = required(await repository.claim(id, "worker"));
    const started = required(await repository.beginCreate(claim));
    await repository.attachJob(started, "job-repository-atomic");
    await repository.admit(started, {
      objectKey: songPcmOutputKey(id),
      objectVersion: "version",
      objectEtag: "etag",
      pcmSha256: "b".repeat(64),
      byteLength: 1_920_000,
      durationSamples: 480_000,
      decoderRecipe: SONG_VIDEO_PCM_DECODER_RECIPE,
    });
    const admitted = required(await repository.get(id));
    expect(admitted.state).toBe("admitted");
    await repository.cleaned(admitted);
    expect(
      (
        await client.query(`SELECT t.state,t.duration_samples::int,r.pcm_byte_length::int
      FROM media_song_canonical_timings t JOIN media_song_video_pcm_references r
      USING(song_post_id,audio_revision,canonical_audio_sha256,duration_samples)
      WHERE t.song_post_id='repository-atomic'`)
      ).rows,
    ).toEqual([{ state: "ready", duration_samples: 480_000, pcm_byte_length: 1_920_000 }]);
    await client.query("SET session_replication_role=replica");
    await client.query(
      "ALTER TABLE media_publication_projections ENABLE ALWAYS TRIGGER media_publication_song_pcm_admission",
    );
    try {
      await client.query(
        "UPDATE media_publication_projections SET audio_revision=2,canonical_audio_sha256=$1 WHERE post_id='repository-atomic'",
        ["c".repeat(64)],
      );
    } finally {
      await client.query(
        "ALTER TABLE media_publication_projections ENABLE TRIGGER media_publication_song_pcm_admission",
      );
      await client.query("SET session_replication_role=origin");
    }
    expect(
      (
        await client.query(`SELECT count(*)::int AS n FROM media_publication_projections p
      JOIN media_song_video_pcm_references r ON r.song_post_id=p.post_id
       AND r.audio_revision=p.audio_revision AND r.canonical_audio_sha256=p.canonical_audio_sha256
      WHERE p.post_id='repository-atomic'`)
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await client.query(
          "SELECT state FROM media_song_canonical_timings WHERE song_post_id='repository-atomic' AND audio_revision=2",
        )
      ).rows,
    ).toEqual([{ state: "pending" }]);
  });
  test("a timing cannot become ready before its PCM and admission commit", async () => {
    await pending("alone");
    await expect(timing("alone")).rejects.toThrow("admitted atomically");
    expect(
      (
        await client.query(
          "SELECT state FROM media_song_canonical_timings WHERE song_post_id='alone'",
        )
      ).rows[0].state,
    ).toBe("pending");
  });
  test("one transaction admits matching timing and PCM", async () => {
    const id = await pending("atomic");
    const a = await repository.claim(id, "test-worker");
    expect(a).not.toBeNull();
    const started = await repository.beginCreate(required(a));
    expect(started).not.toBeNull();
    await repository.attachJob(required(started), "job-atomic");
    await client.query("BEGIN");
    try {
      await timing("atomic");
      await reference("atomic", id);
      await client.query(
        "UPDATE media_song_video_pcm_admissions SET state='admitted' WHERE admission_id=$1",
        [id],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    expect(
      (
        await client.query(
          "SELECT state FROM media_song_canonical_timings WHERE song_post_id='atomic'",
        )
      ).rows[0].state,
    ).toBe("ready");
    expect(
      (
        await client.query(
          "SELECT state FROM media_song_video_pcm_admissions WHERE admission_id=$1",
          [id],
        )
      ).rows[0].state,
    ).toBe("admitted");
  });
  test("a deadline crossed before admission rolls back timing and reference", async () => {
    const id = await pending("late");
    await client.query(
      `UPDATE media_song_video_pcm_admissions SET state='processing',
      provider_create_started_at=clock_timestamp(),provider_wait_deadline=clock_timestamp()+interval '20 milliseconds',
      provider_job_id='job-late' WHERE admission_id=$1`,
      [id],
    );
    await client.query("BEGIN");
    await timing("late");
    await reference("late", id);
    await client.query("SELECT pg_sleep(0.05)");
    await expect(
      client.query(
        "UPDATE media_song_video_pcm_admissions SET state='admitted' WHERE admission_id=$1",
        [id],
      ),
    ).rejects.toThrow("expired");
    await client.query("ROLLBACK");
    expect(
      (
        await client.query(
          "SELECT state FROM media_song_canonical_timings WHERE song_post_id='late'",
        )
      ).rows[0].state,
    ).toBe("pending");
    expect(
      (
        await client.query(
          "SELECT 1 FROM media_song_video_pcm_references WHERE song_post_id='late'",
        )
      ).rowCount,
    ).toBe(0);
  });
  test("creation is claimed once and provider identity cannot be replaced", async () => {
    // Earlier finished and expired fixture intents are reconciled explicitly.
    await client.query(
      "UPDATE media_song_video_pcm_admissions SET state='reconciliation',failure_code='fixture_expired' WHERE state='processing'",
    );
    await client.query(
      "UPDATE media_song_video_pcm_admissions SET cleanup_completed_at=clock_timestamp() WHERE provider_create_started_at IS NOT NULL AND cleanup_completed_at IS NULL",
    );
    const id = await pending("once");
    const a = required(await repository.claim(id, "worker"));
    const results = await Promise.all([repository.beginCreate(a), repository.beginCreate(a)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const started = required(results.find(Boolean));
    await repository.attachJob(started, "job-once");
    await expect(repository.attachJob(started, "job-replacement")).rejects.toThrow("fence lost");
    await expect(
      client.query(
        "UPDATE media_song_video_pcm_admissions SET provider_wait_deadline=clock_timestamp() WHERE admission_id=$1",
        [id],
      ),
    ).rejects.toThrow("immutable");
  });
  test("a stale claim cannot begin provider creation", async () => {
    const id = await pending("fence");
    const stale = required(await repository.claim(id, "old"));
    await client.query(
      "UPDATE media_song_video_pcm_admissions SET claim_until=clock_timestamp()-interval '1 second' WHERE admission_id=$1",
      [id],
    );
    const current = required(await repository.claim(id, "new"));
    expect(await repository.beginCreate(stale)).toBeNull();
    expect(await repository.beginCreate(current)).not.toBeNull();
  });
});
