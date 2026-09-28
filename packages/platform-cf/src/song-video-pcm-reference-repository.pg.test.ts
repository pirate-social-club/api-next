import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PublishedCanonicalSong } from "@pirate/application/video/song-interval";
import { Client } from "pg";
import { runPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { makeControlPlaneSongVideoPcmReferenceStore } from "./song-video-pcm-reference-repository.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !connectionString)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
const suite = connectionString ? describe : describe.skip;

const SONG_SHA = "a".repeat(64);
const PCM_SHA = "b".repeat(64);
const DURATION_SAMPLES = 480_000;
const OBJECT_KEY = "song-video-pcm/post-pcm-r1.pcm";
const song: PublishedCanonicalSong = {
  songPostId: "post-pcm",
  songCommunityId: "community-pcm",
  audioRevision: 1,
  canonicalAudioSha256: SONG_SHA,
  songAssetId: "immutable/song-pcm.mp3",
};

suite("admitted song-video PCM reference", () => {
  const schema = `video_pcm_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString });
  const scoped = new URL(connectionString ?? "postgresql://unused/unused");
  scoped.searchParams.set("options", `-c search_path=${schema}`);
  const client = new Client({ connectionString: scoped.toString() });
  let head: { version: string; etag: string; size: number } | null = null;
  const reads: string[] = [];
  const store = makeControlPlaneSongVideoPcmReferenceStore(
    makeDirectPostgresControlPlaneLayer(scoped.toString()),
    {
      head: async (key) => {
        reads.push(key);
        return head;
      },
    },
  );

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await runPostgresMigrations({ connectionString: scoped.toString() });
    await client.connect();
    await client.query(
      `INSERT INTO media_song_canonical_timings
         (song_post_id,audio_revision,song_community_id,canonical_audio_sha256,
          state,duration_samples,prober_identity,prober_policy_revision,measured_at)
       VALUES ($1,1,$2,$3,'ready',$4,'pinned-ffmpeg-6.1.1',1,clock_timestamp())`,
      [song.songPostId, song.songCommunityId, SONG_SHA, DURATION_SAMPLES],
    );
  }, 180_000);

  afterAll(async () => {
    await client.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  test("requires a measured exact revision and never reads R2 when no fact exists", async () => {
    expect(await store.getReady(song, DURATION_SAMPLES)).toBeNull();
    expect(reads).toEqual([]);
    await expect(
      client.query(
        `INSERT INTO media_song_video_pcm_references
           (song_post_id,audio_revision,canonical_audio_sha256,duration_samples,
            pcm_object_key,pcm_object_version,pcm_object_etag,pcm_sha256,
            pcm_byte_length,decoder_recipe)
         VALUES ($1,1,$2,$3,$4,'version-1','etag-1',$5,$6,'pinned-ffmpeg-6.1.1')`,
        [
          song.songPostId,
          "c".repeat(64),
          DURATION_SAMPLES,
          OBJECT_KEY,
          PCM_SHA,
          DURATION_SAMPLES * 4,
        ],
      ),
    ).rejects.toMatchObject({ constraint: "song_video_pcm_reference_timing_fk" });
  });

  test("readiness requires the exact durable fact and object identity", async () => {
    await client.query(
      `INSERT INTO media_song_video_pcm_references
         (song_post_id,audio_revision,canonical_audio_sha256,duration_samples,
          pcm_object_key,pcm_object_version,pcm_object_etag,pcm_sha256,
          pcm_byte_length,decoder_recipe)
       VALUES ($1,1,$2,$3,$4,'version-1','etag-1',$5,$6,'pinned-ffmpeg-6.1.1')`,
      [song.songPostId, SONG_SHA, DURATION_SAMPLES, OBJECT_KEY, PCM_SHA, DURATION_SAMPLES * 4],
    );
    head = { version: "version-1", etag: "etag-1", size: DURATION_SAMPLES * 4 };
    expect(await store.getReady(song, DURATION_SAMPLES)).toMatchObject({
      objectKey: OBJECT_KEY,
      pcmSha256: PCM_SHA,
      byteLength: DURATION_SAMPLES * 4,
    });
    expect(reads).toEqual([OBJECT_KEY]);
    expect(
      await store.getReady({ ...song, canonicalAudioSha256: "c".repeat(64) }, DURATION_SAMPLES),
    ).toBeNull();
    expect(await store.getReady(song, DURATION_SAMPLES - 1)).toBeNull();
    for (const changed of [
      null,
      { version: "version-2", etag: "etag-1", size: DURATION_SAMPLES * 4 },
      { version: "version-1", etag: "etag-2", size: DURATION_SAMPLES * 4 },
      { version: "version-1", etag: "etag-1", size: DURATION_SAMPLES * 4 - 1 },
    ]) {
      head = changed;
      expect(await store.getReady(song, DURATION_SAMPLES)).toBeNull();
    }
  });

  test("an admitted reference cannot be changed or removed", async () => {
    await expect(
      client.query(
        "UPDATE media_song_video_pcm_references SET pcm_sha256=$1 WHERE song_post_id=$2",
        ["c".repeat(64), song.songPostId],
      ),
    ).rejects.toThrow("immutable");
    await expect(
      client.query("DELETE FROM media_song_video_pcm_references WHERE song_post_id=$1", [
        song.songPostId,
      ]),
    ).rejects.toThrow("immutable");
  });
});
