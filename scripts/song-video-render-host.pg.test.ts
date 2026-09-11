import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mediaSha256Bytes } from "@pirate/application/media/submission-service";
import { Client } from "pg";
import { makeR2SongVideoOutputStore } from "../packages/platform-cf/src/song-video-master-store.ts";
import { startRenderAttempt } from "../packages/platform-cf/src/song-video-render-repository.ts";
import {
  type PublishedSongFixture,
  seedPublishedSongFixture,
  seedSongOwner,
  seedVideoActors,
  songReferenceFinalizedFixture,
  community as videoCommunity,
} from "../packages/platform-cf/src/video-publication.pg-fixture.ts";
import { runPostgresMigrations } from "./postgres-migrations.ts";

/**
 * Exercises the actual host entry point against real PostgreSQL, real pinned
 * FFmpeg and a fake S3 endpoint: a real render, the atomic claim, a duplicate
 * invocation, and the object identity downstream consumers resolve.
 */

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !connectionString)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
const suite = connectionString ? describe : describe.skip;

const SONG_POST = "post-son-video-host";
const SONG_ASSET = "media://immutable/media-operation-song-host/audio/1";
const BUCKET = "media-immutable-originals";
const CLIP_DURATION = 4 * 48_000;

type StoredObject = { bytes: Uint8Array; etag: string };

async function ffmpegTool(args: readonly string[]): Promise<void> {
  const child = Bun.spawn(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", ...args], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = await new Response(child.stderr).text();
  if ((await child.exited) !== 0) throw new Error(`ffmpeg failed: ${stderr.slice(0, 200)}`);
}

async function decodedSampleCount(directory: string, bytes: Uint8Array): Promise<number> {
  const input = join(directory, "measure.bin");
  const output = `${input}.pcm`;
  await writeFile(input, bytes);
  await ffmpegTool([
    "-y",
    "-i",
    input,
    "-map",
    "0:a:0",
    "-af",
    "aresample=48000,aformat=sample_fmts=s16:channel_layouts=stereo",
    "-c:a",
    "pcm_s16le",
    "-f",
    "s16le",
    output,
  ]);
  return (await readFile(output)).byteLength / 4;
}

suite("song-video render host entry point", () => {
  const schema = `render_host_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString });
  const scoped = new URL(connectionString ?? "postgresql://unused/unused");
  scoped.searchParams.set("options", `-c search_path=${schema}`);
  const client = new Client({ connectionString: scoped.toString() });
  const objects = new Map<string, StoredObject>();
  const masterKey = `media://immutable/song-video-masters/plan-host-entry/g1`;
  let server: ReturnType<typeof Bun.serve>;
  let endpoint = "";
  let putCount = 0;
  let directory = "";
  let planId = "";
  let attemptId = "";
  let songSha = "";

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    await runPostgresMigrations({ connectionString: scoped.toString() });
    await client.connect();
    await seedVideoActors(admin);
    await seedSongOwner(admin);
    directory = await mkdtemp(join(tmpdir(), "pirate-render-host-"));
    await ffmpegTool([
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=44100:duration=6",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "128k",
      join(directory, "song.mp3"),
    ]);
    await ffmpegTool([
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=320x480:rate=30:duration=4",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=220:duration=4",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      "-movflags",
      "+faststart",
      join(directory, "capture.mp4"),
    ]);
    const song = new Uint8Array(await readFile(join(directory, "song.mp3")));
    const capture = new Uint8Array(await readFile(join(directory, "capture.mp4")));
    songSha = await mediaSha256Bytes(song);
    const songDuration = await decodedSampleCount(directory, song);
    const captureSha = await mediaSha256Bytes(capture);
    const songFixture: PublishedSongFixture = {
      songPostId: SONG_POST,
      communityId: videoCommunity,
      audioAssetRef: SONG_ASSET,
      canonicalAudioSha256: songSha,
      durationSamples: songDuration,
      title: "Host suite song",
      contentRating: "general",
      derivativeVideo: "allowed",
      licensePreset: "commercial-remix",
      commercialRemixShareBps: 1_000,
    };
    await seedPublishedSongFixture(admin, songFixture);
    planId = "plan-host-entry";
    attemptId = "attempt-host-entry";
    const identity = {
      reservationId: "media-reservation-00000000-0000-4000-8000-0000000000e1",
      submissionId: "media-submission-host-entry",
      operationId: "media-operation-host-entry",
    };
    await songReferenceFinalizedFixture(scoped.toString(), {
      identity,
      planId,
      song: songFixture,
      clipStartSamples: 0,
      clipDurationSamples: CLIP_DURATION,
      source: { sha256: captureSha, sizeBytes: capture.byteLength },
    });
    await startRenderAttempt(
      client,
      { attemptId, planId, generation: 1 },
      {
        outputObjectKey: masterKey,
        rendererIdentity: "ffmpeg-6.1.1-song-video-v1",
        rendererPolicyRevision: 1,
      },
    );
    await client.query(
      `UPDATE media_song_video_render_attempts
          SET execution_phase='submitting', execution_started_at=clock_timestamp()
        WHERE attempt_id=$1`,
      [attemptId],
    );
    // The bucket holds the sealed capture and the canonical song under the same
    // physical keys the production adapters derive from their references.
    objects.set(`immutable/${identity.operationId}/video/1`, {
      bytes: capture,
      etag: "capture-etag",
    });
    objects.set(SONG_ASSET.replace("media://immutable/", "immutable/"), {
      bytes: song,
      etag: "song-etag",
    });
    server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        const path = url.pathname.replace(/^\//u, "");
        const separator = path.indexOf("/");
        const bucket = separator < 0 ? path : path.slice(0, separator);
        const key = separator < 0 ? "" : path.slice(separator + 1);
        const stored = bucket === BUCKET ? objects.get(key) : undefined;
        if (request.method === "GET" || request.method === "HEAD") {
          if (stored === undefined) return new Response(null, { status: 404 });
          return new Response(request.method === "HEAD" ? null : stored.bytes, {
            status: 200,
            headers: {
              etag: `"${stored.etag}"`,
              "content-length": String(stored.bytes.byteLength),
            },
          });
        }
        if (request.method === "PUT") {
          if (stored !== undefined) return new Response(null, { status: 412 });
          const bytes = new Uint8Array(await request.arrayBuffer());
          putCount += 1;
          objects.set(key, { bytes, etag: createHash("sha256").update(bytes).digest("hex") });
          return new Response(null, {
            status: 200,
            headers: { etag: `"${createHash("sha256").update(bytes).digest("hex")}"` },
          });
        }
        return new Response(null, { status: 405 });
      },
    });
    endpoint = `http://127.0.0.1:${server.port}`;
  }, 180_000);

  afterAll(async () => {
    server?.stop(true);
    await client.end().catch(() => undefined);
    await admin.end().catch(() => undefined);
    if (directory.length > 0) await rm(directory, { recursive: true, force: true });
  });

  function hostEnv(): Record<string, string> {
    return {
      ...(process.env as Record<string, string>),
      SONG_VIDEO_RENDER_PLAN_ID: planId,
      SONG_VIDEO_RENDER_ATTEMPT_ID: attemptId,
      SONG_VIDEO_RENDER_HOST_ID: "host-entry-test",
      SONG_VIDEO_RENDER_DATABASE_URL: scoped.toString(),
      SONG_VIDEO_RENDER_R2_ACCOUNT_ID: "a".repeat(32),
      SONG_VIDEO_RENDER_R2_BUCKET: BUCKET,
      SONG_VIDEO_RENDER_R2_ACCESS_KEY_ID: "test-access-key",
      SONG_VIDEO_RENDER_R2_SECRET_ACCESS_KEY: "test-secret-key",
      SONG_VIDEO_RENDER_R2_ENDPOINT: endpoint,
    };
  }

  async function runHost(): Promise<{ exit: number; stdout: string }> {
    const child = Bun.spawn([process.execPath, "scripts/song-video-render-host.ts"], {
      env: hostEnv(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exit !== 0 && exit !== 2) throw new Error(`host failed: ${stderr.slice(0, 200)}`);
    return { exit, stdout: stdout.trim() };
  }

  test("renders once, seals the master and refuses a duplicate invocation", async () => {
    const first = await runHost();
    expect(first.exit).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({ plan_id: planId, status: "accepted" });

    const master = await client.query<{
      master_sha256: string;
      master_byte_length: string;
      verified_object_key: string;
      verified_object_version: string;
      verified_object_etag: string;
    }>(
      `SELECT master_sha256,master_byte_length::text,verified_object_key,
              verified_object_version,verified_object_etag
         FROM media_song_video_masters WHERE plan_id=$1`,
      [planId],
    );
    const row = master.rows[0];
    if (row === undefined) throw new Error("master missing");
    const stored = objects.get(masterKey.replace("media://immutable/", "immutable/"));
    if (stored === undefined) throw new Error("written master missing from the bucket");
    expect(row.verified_object_key).toBe(masterKey);
    expect(row.master_byte_length).toBe(String(stored.bytes.byteLength));
    expect(row.master_sha256).toBe(await mediaSha256Bytes(stored.bytes));
    // The recorded identity is the normalized ETag, and the Worker adapter
    // resolves the same bytes through that identity rather than an assumed
    // version field.
    expect(row.verified_object_etag).toBe(stored.etag);
    expect(row.verified_object_version).toBe(stored.etag);
    const workerStore = makeR2SongVideoOutputStore({
      get: async (key: string) => {
        const entry = objects.get(key);
        if (entry === undefined) return null;
        return {
          version: "",
          etag: `"${entry.etag}"`,
          size: entry.bytes.byteLength,
          arrayBuffer: async () => entry.bytes.slice().buffer,
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(entry.bytes);
              controller.close();
            },
          }),
        };
      },
    } as unknown as R2Bucket);
    expect(await workerStore.readVersion(masterKey, row.verified_object_version)).toEqual(
      stored.bytes,
    );

    const before = putCount;
    const second = await runHost();
    expect(second.exit).toBe(0);
    expect(JSON.parse(second.stdout)).toMatchObject({ status: "not_claimed" });
    expect(putCount).toBe(before);
    const count = await client.query(
      "SELECT count(*)::int AS n FROM media_song_video_masters WHERE plan_id=$1",
      [planId],
    );
    expect(count.rows[0]?.n).toBe(1);
  }, 600_000);
});
