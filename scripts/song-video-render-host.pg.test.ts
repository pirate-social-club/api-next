import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mediaSha256Bytes } from "@pirate/application/media/submission-service";
import { Client } from "pg";
import { makeDirectPostgresControlPlaneLayer } from "../packages/platform-cf/src/postgres.ts";
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
import {
  makeVideoSourceGateway,
  type VideoSourceBucket,
} from "../packages/platform-cf/src/video-source-gateway.ts";
import { makeVideoSourceGrantIssuer } from "../packages/platform-cf/src/video-source-grant-issuer.ts";
import { makeVideoSourceGrantResolver } from "../packages/platform-cf/src/video-source-grant-resolver.ts";
import { runPostgresMigrations } from "./postgres-migrations.ts";

/**
 * Exercises the actual host entry point against real PostgreSQL, real pinned
 * FFmpeg and a fake S3 endpoint: a real render, the atomic claim, a duplicate
 * invocation, and the object identity downstream consumers resolve.
 */

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !connectionString)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
const ffmpegAvailable = Bun.which("ffmpeg") !== null;
const version = ffmpegAvailable
  ? Bun.spawnSync(["ffmpeg", "-version"], { stdout: "pipe", stderr: "ignore" })
  : null;
const pinned =
  version !== null &&
  version.exitCode === 0 &&
  new TextDecoder().decode(version.stdout).startsWith("ffmpeg version 6.1.1");
const suite = connectionString !== undefined && pinned ? describe : describe.skip;

const SONG_POST = "post-son-video-host";
const SONG_ASSET = "media://immutable/media-operation-song-host/audio/1";
const LOOP_SONG_POST = "post-son-video-host-loop";
const LOOP_SONG_ASSET = "media://immutable/media-operation-song-host-loop/audio/1";
const LOOP_RESERVATION = "media-reservation-00000000-0000-4000-8000-0000000000e2";
const LOOP_SUBMISSION = "media-submission-host-loop";
const LOOP_OPERATION = "media-operation-host-loop";
const LOOP_PLAN = "plan-host-loop";
const LOOP_ATTEMPT = "attempt-host-loop";
const LOOP_MASTER_KEY = "media://immutable/song-video-masters/plan-host-loop/g1";
const BUCKET = "media-immutable-originals";
const CLIP_DURATION = 4 * 48_000;

type StoredObject = { bytes: Uint8Array; etag: string; version: string };

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
  let songDurationSamples = 0;
  let operationId = "";
  let captureSha = "";
  let captureSize = 0;

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
    captureSha = await mediaSha256Bytes(capture);
    captureSize = capture.byteLength;
    const songDuration = await decodedSampleCount(directory, song);
    songDurationSamples = songDuration;
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
    // A second song is left unmeasured and a second plan is finalized, so the
    // no-plan-id loop must measure first, then claim the submitted attempt.
    const loopSong: PublishedSongFixture = {
      ...songFixture,
      songPostId: LOOP_SONG_POST,
      audioAssetRef: LOOP_SONG_ASSET,
      title: "Host suite loop song",
      durationSamples: null,
    };
    await seedPublishedSongFixture(admin, loopSong);
    await admin.query(
      `INSERT INTO media_song_canonical_timings
         (song_post_id,audio_revision,song_community_id,canonical_audio_sha256,state)
       VALUES ($1,1,$2,$3,'pending')`,
      [LOOP_SONG_POST, videoCommunity, songSha],
    );
    const loopIdentity = {
      reservationId: LOOP_RESERVATION,
      submissionId: LOOP_SUBMISSION,
      operationId: LOOP_OPERATION,
    };
    await songReferenceFinalizedFixture(scoped.toString(), {
      identity: loopIdentity,
      planId: LOOP_PLAN,
      song: songFixture,
      clipStartSamples: 0,
      clipDurationSamples: CLIP_DURATION,
      source: { sha256: captureSha, sizeBytes: capture.byteLength },
    });
    await startRenderAttempt(
      client,
      { attemptId: LOOP_ATTEMPT, planId: LOOP_PLAN, generation: 1 },
      {
        outputObjectKey: LOOP_MASTER_KEY,
        rendererIdentity: "ffmpeg-6.1.1-song-video-v1",
        rendererPolicyRevision: 1,
      },
    );
    await client.query(
      `UPDATE media_song_video_render_attempts
          SET execution_phase='submitting', execution_started_at=clock_timestamp()
        WHERE attempt_id=$1`,
      [LOOP_ATTEMPT],
    );
    // The guard admits the Worker's real transition, submitting -> submitted.
    await client.query(
      `UPDATE media_song_video_render_attempts SET execution_phase='submitted'
        WHERE attempt_id=$1 AND execution_phase='submitting'`,
      [LOOP_ATTEMPT],
    );
    objects.set(LOOP_SONG_ASSET.replace("media://immutable/", "immutable/"), {
      bytes: song,
      etag: "loop-song-etag",
      version: "loop-song-version",
    });
    objects.set(`immutable/${LOOP_OPERATION}/video/1`, {
      bytes: capture,
      etag: `immutable-etag-${LOOP_SUBMISSION}`,
      version: `immutable-version-${LOOP_SUBMISSION}`,
    });
    planId = "plan-host-entry";
    attemptId = "attempt-host-entry";
    const identity = {
      reservationId: "media-reservation-00000000-0000-4000-8000-0000000000e1",
      submissionId: "media-submission-host-entry",
      operationId: "media-operation-host-entry",
    };
    operationId = identity.operationId;
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
    // The fixture's sealed capture carries its recorded upload identity; the
    // fake bucket must expose exactly those values for the original check.
    objects.set(`immutable/${identity.operationId}/video/1`, {
      bytes: capture,
      etag: `immutable-etag-${identity.submissionId}`,
      version: `immutable-version-${identity.submissionId}`,
    });
    objects.set(SONG_ASSET.replace("media://immutable/", "immutable/"), {
      bytes: song,
      etag: "song-etag",
      version: "song-version",
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
          const etag = createHash("sha256").update(bytes).digest("hex");
          objects.set(key, { bytes, etag, version: `r2-upload-${putCount}` });
          return new Response(null, { status: 200, headers: { etag: `"${etag}"` } });
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

  function sourceBucket(): VideoSourceBucket {
    const identity = (key: string) => {
      const entry = objects.get(key);
      if (entry === undefined) return null;
      return {
        key,
        version: entry.version,
        etag: entry.etag,
        size: entry.bytes.byteLength,
        httpMetadata: { contentType: "video/mp4" as const },
      };
    };
    return {
      head: async (key) => identity(key),
      get: async (key, options) => {
        const id = identity(key);
        if (id === null || id.etag !== options.onlyIf.etagMatches) return null;
        const bytes = objects.get(key)?.bytes ?? new Uint8Array();
        const range = options.range;
        const selected =
          range === undefined ? bytes : bytes.slice(range.offset, range.offset + range.length);
        return {
          ...id,
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(selected);
              controller.close();
            },
          }),
        };
      },
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

  function loopEnv(): Record<string, string> {
    const env = hostEnv();
    delete env.SONG_VIDEO_RENDER_PLAN_ID;
    delete env.SONG_VIDEO_RENDER_ATTEMPT_ID;
    env.SONG_VIDEO_RENDER_HOST_ID = "host-loop-test";
    env.SONG_VIDEO_RENDER_POLL_MS = "1000";
    return env;
  }

  /** Runs the no-plan-id loop until it accepts, then stops it with SIGTERM. */
  async function runHostLoop(): Promise<{ exit: number; stdout: string }> {
    const child = Bun.spawn([process.execPath, "scripts/song-video-render-host.ts"], {
      env: loopEnv(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let stdout = "";
    try {
      const deadline = Date.now() + 300_000;
      while (Date.now() < deadline) {
        // The read is raced against the remaining deadline so a child that
        // stays alive without printing cannot hold the test open.
        const remaining = Math.max(1, deadline - Date.now());
        let timer: ReturnType<typeof setTimeout> | undefined;
        const chunk = await Promise.race([
          reader.read(),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), remaining);
          }),
        ]).finally(() => {
          if (timer !== undefined) clearTimeout(timer);
        });
        if (chunk === null) throw new Error("host loop printed nothing before the deadline");
        if (chunk.done) break;
        stdout += decoder.decode(chunk.value, { stream: true });
        const accepted = stdout
          .split("\n")
          .some((line) => line.includes('"status":"accepted"') && line.trimEnd().endsWith("}"));
        if (accepted) break;
      }
    } finally {
      // The kill is unconditional, so a thrown assertion never leaves the host
      // running past the test.
      child.kill("SIGTERM");
    }
    const exit = await child.exited;
    const stderr = await new Response(child.stderr).text();
    if (exit !== 0) throw new Error(`host loop failed: ${stderr.slice(0, 200)}`);
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

    // The real grant and gateway path. Publication registers the accepted
    // master as a content-identified immutable object; a stream grant is
    // issued for it; the gateway HEADs and range-reads the accepted bytes.
    const layer = makeDirectPostgresControlPlaneLayer(scoped.toString());
    const captureRef = `media://immutable/${operationId}/video/1`;
    const capturePhysical = `immutable/${operationId}/video/1`;
    const masterPhysical = masterKey.replace("media://immutable/", "immutable/");
    const masterSha = await mediaSha256Bytes(stored.bytes);
    await client.query(
      `INSERT INTO media_immutable_objects
         (immutable_ref,community_id,actor_user_id,reservation_id,submission_id,operation_id,
          destination_ref,etag,object_version,size_bytes,content_type,canonical_sha256,
          author_persona_id,identity_kind)
       SELECT $1,community_id,actor_user_id,NULL,submission_id,operation_id,$2,$3,$4,$5,
              'video/mp4',$6,author_persona_id,'content_etag'
         FROM media_immutable_objects WHERE immutable_ref=$7
       ON CONFLICT (immutable_ref) DO NOTHING`,
      [
        masterKey,
        `r2://${masterPhysical}`,
        stored.etag,
        stored.etag,
        stored.bytes.byteLength,
        masterSha,
        captureRef,
      ],
    );
    const issuer = makeVideoSourceGrantIssuer(layer, "https://media.example", "stream");
    const grant = await issuer.issue({
      objectKey: masterPhysical,
      sha256: masterSha,
      byteLength: stored.bytes.byteLength,
      mediaType: "video/mp4",
      requestId: "host-entry-stream",
      expiresAtMs: Date.now() + 60_000,
    });
    const gateway = makeVideoSourceGateway({
      bucket: sourceBucket(),
      grants: makeVideoSourceGrantResolver(layer),
      now: Date.now,
    });
    const head = await gateway(new Request(grant.url, { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(stored.bytes.byteLength));
    const ranged = await gateway(new Request(grant.url, { headers: { range: "bytes=0-9" } }));
    expect(ranged.status).toBe(206);
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(stored.bytes.slice(0, 10));
    // Changed content at the master's address is refused.
    const masterEntry = objects.get(masterPhysical);
    if (masterEntry === undefined) throw new Error("master object missing");
    masterEntry.etag = "mutated-etag";
    expect((await gateway(new Request(grant.url, { method: "HEAD" }))).status).toBe(409);
    masterEntry.etag = stored.etag;

    // An original upload keeps its version check: a replacement version with
    // the same ETag is still refused.
    const captureGrant = await issuer.issue({
      objectKey: capturePhysical,
      sha256: captureSha,
      byteLength: captureSize,
      mediaType: "video/mp4",
      requestId: "host-entry-capture",
      expiresAtMs: Date.now() + 60_000,
    });
    expect((await gateway(new Request(captureGrant.url, { method: "HEAD" }))).status).toBe(200);
    const captureEntry = objects.get(capturePhysical);
    if (captureEntry === undefined) throw new Error("capture object missing");
    captureEntry.version = "replacement-version";
    expect((await gateway(new Request(captureGrant.url, { method: "HEAD" }))).status).toBe(409);
  }, 600_000);

  test("the loop measures a pending song and claims without a plan id until signalled", async () => {
    const result = await runHostLoop();
    expect(result.exit).toBe(0);
    const lines = result.stdout
      .split("\n")
      .filter((line) => line.trimEnd().endsWith("}"))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    // The first pass measured the unmeasured song, then claimed the submitted
    // attempt with no plan id, and the signal stopped the loop cleanly.
    expect(lines).toContainEqual(expect.objectContaining({ status: "measured", measured: 1 }));
    expect(lines).toContainEqual(
      expect.objectContaining({ plan_id: LOOP_PLAN, status: "accepted" }),
    );
    const timing = await client.query<{ state: string; duration_samples: string }>(
      `SELECT state,duration_samples::text FROM media_song_canonical_timings
        WHERE song_post_id=$1`,
      [LOOP_SONG_POST],
    );
    expect(timing.rows[0]).toEqual({
      state: "ready",
      duration_samples: String(songDurationSamples),
    });
    const masters = await client.query(
      "SELECT count(*)::int AS n FROM media_song_video_masters WHERE plan_id=$1",
      [LOOP_PLAN],
    );
    expect(masters.rows[0]?.n).toBe(1);
    const attempts = await client.query<{ state: string; execution_phase: string }>(
      `SELECT state,execution_phase FROM media_song_video_render_attempts
        WHERE attempt_id=$1`,
      [LOOP_ATTEMPT],
    );
    expect(attempts.rows[0]).toEqual({ state: "accepted", execution_phase: "submitted" });
  }, 600_000);
});
