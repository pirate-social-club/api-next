import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
import {
  assertRenderHostFixturePrivileges,
  decodedSampleCount,
  ffmpegTool,
  grantRenderHostFixturePrivileges,
} from "./song-video-render-host.pg-fixture.ts";

/**
 * Exercises the actual host entry point against real PostgreSQL, real pinned
 * FFmpeg and a fake S3 endpoint: a real render, the atomic claim, a duplicate
 * invocation, and the object identity downstream consumers resolve. The host
 * runs under a per-run restricted login whose grants cover only this suite's
 * schema, so the suite also proves the production role shape.
 */

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !connectionString)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
const ffmpegRequired = process.env.SONG_VIDEO_FFMPEG_REQUIRED === "1";
const ffmpegAvailable = Bun.which("ffmpeg") !== null;
const ffprobeAvailable = Bun.which("ffprobe") !== null;
const version = ffmpegAvailable
  ? Bun.spawnSync(["ffmpeg", "-version"], { stdout: "pipe", stderr: "ignore" })
  : null;
const ffprobeVersion = ffprobeAvailable
  ? Bun.spawnSync(["ffprobe", "-version"], { stdout: "pipe", stderr: "ignore" })
  : null;
const pinned =
  version !== null &&
  version.exitCode === 0 &&
  ffprobeVersion !== null &&
  ffprobeVersion.exitCode === 0 &&
  new TextDecoder().decode(version.stdout).startsWith("ffmpeg version 6.1.1") &&
  new TextDecoder().decode(ffprobeVersion.stdout).startsWith("ffprobe version 6.1.1");
if (ffmpegRequired && !pinned) {
  throw new Error("SONG_VIDEO_FFMPEG_REQUIRED=1 requires pinned FFmpeg and ffprobe 6.1.1 on PATH");
}
const sentinelPath =
  process.env.CONTROL_PLANE_POSTGRES_SONG_VIDEO_RENDER_HOST_TEST_SENTINEL ??
  "/tmp/api-next-control-plane-postgres-song-video-render-host-suite-complete";
const sentinelContents = "api-next-control-plane-postgres-song-video-render-host-suite-complete\n";
const suite = connectionString !== undefined && pinned ? describe : describe.skip;
let completedTestCount = 0;

const SONG_POST = "post-son-video-host";
const SONG_ASSET = "media://immutable/media-operation-song-host/audio/1";
const LOOP_SONG_POST = "post-son-video-host-loop";
const LOOP_SONG_ASSET = "media://immutable/media-operation-song-host-loop/audio/1";
const MEASURE_SONG_POST = "post-son-video-host-measure";
const MEASURE_SONG_ASSET = "media://immutable/media-operation-song-host-measure/audio/1";
const LOOP_RESERVATION = "media-reservation-00000000-0000-4000-8000-0000000000e2";
const LOOP_SUBMISSION = "media-submission-host-loop";
const LOOP_OPERATION = "media-operation-host-loop";
const LOOP_PLAN = "plan-host-loop";
const LOOP_ATTEMPT = "attempt-host-loop";
const LOOP_MASTER_KEY = "media://immutable/song-video-masters/plan-host-loop/g1";
const BUCKET = "media-immutable-originals";
const CLIP_DURATION = 4 * 48_000;

type StoredObject = { bytes: Uint8Array; etag: string; version: string };

suite("song-video render host entry point", () => {
  const schema = `render_host_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString });
  const scoped = new URL(connectionString ?? "postgresql://unused/unused");
  scoped.searchParams.set("options", `-c search_path=${schema}`);
  // PostgreSQL roles are cluster-wide, so the name is unique to this run's
  // schema and the throwaway password never leaves the process. No shared or
  // fixed role is ever dropped.
  const hostRole = `${schema}_host`;
  const hostPassword = crypto.randomUUID().replaceAll("-", "");
  const roleScoped = new URL(scoped.toString());
  roleScoped.username = hostRole;
  roleScoped.password = hostPassword;
  const client = new Client({ connectionString: scoped.toString() });
  const objects = new Map<string, StoredObject>();
  const masterKey = `media://immutable/song-video-masters/plan-host-entry/g1`;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let adminConnected = false;
  let clientConnectAttempted = false;
  let schemaCreated = false;
  let roleCreated = false;
  let schemaOid: string | undefined;
  let roleOid: string | undefined;
  let disposalStarted = false;
  const activeWork = new Set<Promise<void>>();
  const workFailures: unknown[] = [];
  const children = new Set<Bun.Subprocess<"ignore", "pipe", "pipe">>();
  let endpoint = "";
  let putCount = 0;
  // Which access key signed each request the fake bucket received.
  const signedBy: { method: string; key: string; accessKeyId: string }[] = [];
  let directory = "";
  let planId = "";
  let attemptId = "";
  let songSha = "";
  let songDurationSamples = 0;
  let operationId = "";
  let captureSha = "";
  let captureSize = 0;

  // Bun's timeout does not cancel an async callback. Keep its actual lifetime
  // owned until teardown, including setup that fails after creating resources.
  function fixtureWork(run: () => Promise<void>): () => Promise<void> {
    return () => {
      if (disposalStarted) throw new Error("render-host fixture is disposing");
      const work = run();
      activeWork.add(work);
      void work.then(
        () => activeWork.delete(work),
        (error) => {
          activeWork.delete(work);
          workFailures.push(error);
        },
      );
      return work;
    };
  }

  beforeAll(
    fixtureWork(async () => {
      await admin.connect();
      adminConnected = true;
      await admin.query(`CREATE SCHEMA "${schema}"`);
      schemaCreated = true;
      schemaOid = (
        await admin.query<{ oid: string }>(
          "SELECT oid::text FROM pg_namespace WHERE nspname=$1 AND nspowner=current_user::regrole",
          [schema],
        )
      ).rows[0]?.oid;
      if (schemaOid === undefined)
        throw new Error("created render-host schema identity is missing");
      await admin.query(`SET search_path TO "${schema}"`);
      await runPostgresMigrations({ connectionString: scoped.toString() });
      await admin.query(`CREATE ROLE "${hostRole}" LOGIN PASSWORD '${hostPassword}'`);
      roleCreated = true;
      roleOid = (
        await admin.query<{ oid: string }>("SELECT oid::text FROM pg_roles WHERE rolname=$1", [
          hostRole,
        ])
      ).rows[0]?.oid;
      if (roleOid === undefined) throw new Error("created render-host role identity is missing");
      await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${hostRole}"`);
      await grantRenderHostFixturePrivileges(admin, schema, hostRole);
      clientConnectAttempted = true;
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
          signedBy.push({
            method: request.method,
            key,
            accessKeyId:
              /Credential=([^/]+)\//u.exec(request.headers.get("authorization") ?? "")?.[1] ?? "",
          });
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
    }),
    180_000,
  );

  afterAll(async () => {
    disposalStarted = true;
    const cleanupErrors: unknown[] = [];
    const clean = async (run: () => void | Promise<void>) => {
      try {
        await run();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };
    // Stop only our children, then await callback/pipe completion before closing
    // their HTTP endpoint or database. Never drop underneath timed-out work.
    const stoppingChildren = [...children];
    for (const child of stoppingChildren) await clean(() => child.kill("SIGTERM"));
    await Promise.all(
      stoppingChildren.map((child) =>
        clean(async () => {
          await child.exited;
        }),
      ),
    );
    await Promise.allSettled([...activeWork]);
    await clean(async () => {
      await server?.stop(false);
    });
    if (clientConnectAttempted) await clean(() => client.end());
    if (adminConnected) {
      if (schemaCreated)
        await clean(async () => {
          const identity = await admin.query<{ oid: string; owned: boolean }>(
            "SELECT oid::text, nspowner=current_user::regrole AS owned FROM pg_namespace WHERE nspname=$1",
            [schema],
          );
          if (
            schemaOid === undefined ||
            identity.rows[0]?.oid !== schemaOid ||
            identity.rows[0]?.owned !== true
          ) {
            throw new Error("refusing to drop an unverified render-host schema");
          }
          await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
          const remaining = await admin.query<{ present: boolean }>(
            "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname=$1) AS present",
            [schema],
          );
          if (remaining.rows[0]?.present !== false)
            throw new Error(`the render-host schema survived cleanup: ${schema}`);
        });
      if (roleCreated)
        await clean(async () => {
          const identity = await admin.query<{ oid: string }>(
            "SELECT oid::text FROM pg_roles WHERE rolname=$1",
            [hostRole],
          );
          if (roleOid === undefined || identity.rows[0]?.oid !== roleOid) {
            throw new Error("refusing to drop an unverified render-host role");
          }
          await admin.query(`DROP ROLE "${hostRole}"`);
          const remaining = await admin.query<{ present: boolean }>(
            "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=$1) AS present",
            [hostRole],
          );
          if (remaining.rows[0]?.present !== false)
            throw new Error(`the restricted host role survived cleanup: ${hostRole}`);
        });
    }
    await clean(() => admin.end());
    if (directory.length > 0) await clean(() => rm(directory, { recursive: true, force: true }));
    if (workFailures.length > 0 || cleanupErrors.length > 0) {
      throw new AggregateError(
        [...workFailures, ...cleanupErrors],
        "render-host fixture work or cleanup failed",
      );
    }
    if (completedTestCount === 4) await Bun.write(sentinelPath, sentinelContents);
  });

  function hostEnv(): Record<string, string> {
    return {
      ...(process.env as Record<string, string>),
      SONG_VIDEO_RENDER_PLAN_ID: planId,
      SONG_VIDEO_RENDER_ATTEMPT_ID: attemptId,
      SONG_VIDEO_RENDER_HOST_ID: "host-entry-test",
      SONG_VIDEO_RENDER_DATABASE_URL: roleScoped.toString(),
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

  function spawnHost(env: Record<string, string>) {
    if (disposalStarted) throw new Error("cannot spawn a host during fixture disposal");
    const child = Bun.spawn([process.execPath, "scripts/song-video-render-host.ts"], {
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    children.add(child);
    void child.exited.then(
      () => children.delete(child),
      () => children.delete(child),
    );
    return child;
  }

  async function drainHost(
    child: ReturnType<typeof spawnHost>,
    stderr = new Response(child.stderr).text(),
    stdout = new Response(child.stdout).text(),
  ) {
    const results = await Promise.allSettled([child.exited, stdout, stderr]);
    const failures = results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) throw new AggregateError(failures, "render-host child drain failed");
    return { exit: await child.exited, stdout: await stdout, stderr: await stderr };
  }

  async function runHost(
    extra: Record<string, string> = {},
  ): Promise<{ exit: number; stdout: string }> {
    const { exit, stdout, stderr } = await drainHost(spawnHost({ ...hostEnv(), ...extra }));
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

  /** Own stdout's reader through acceptance, the deadline, SIGTERM and EOF. */
  async function runHostLoop(): Promise<{ exit: number; stdout: string }> {
    const child = spawnHost(loopEnv());
    const stderr = new Response(child.stderr).text();
    const stderrSettled = Promise.allSettled([stderr]);
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let stdout = "";
    let pendingRead: ReturnType<typeof reader.read> | undefined;
    const failures: unknown[] = [];
    try {
      const deadline = Date.now() + 300_000;
      while (Date.now() < deadline) {
        const remaining = Math.max(1, deadline - Date.now());
        let timer: ReturnType<typeof setTimeout> | undefined;
        pendingRead = reader.read();
        const chunk = await Promise.race([
          pendingRead,
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), remaining);
          }),
        ]).finally(() => {
          if (timer !== undefined) clearTimeout(timer);
        });
        if (chunk === null) throw new Error("host loop printed nothing before the deadline");
        pendingRead = undefined;
        if (chunk.done) break;
        stdout += decoder.decode(chunk.value, { stream: true });
        const accepted = stdout
          .split("\n")
          .some((line) => line.includes('"status":"accepted"') && line.trimEnd().endsWith("}"));
        if (accepted) break;
      }
    } catch (error) {
      failures.push(error);
    }
    try {
      child.kill("SIGTERM");
    } catch (error) {
      failures.push(error);
    }
    const stdoutDone = (async () => {
      for (let chunk = await (pendingRead ?? reader.read()); ; chunk = await reader.read()) {
        if (chunk.done) return stdout + decoder.decode();
        stdout += decoder.decode(chunk.value, { stream: true });
      }
    })().finally(() => reader.releaseLock());
    const drained = await Promise.allSettled([drainHost(child, stderr, stdoutDone), stderrSettled]);
    const result = drained[0];
    if (result.status === "rejected") failures.push(result.reason);
    if (failures.length > 0) throw new AggregateError(failures, "render-host loop or drain failed");
    if (result.status !== "fulfilled") throw new Error("render-host loop drain did not complete");
    const { exit } = result.value;
    if (exit !== 0) throw new Error(`host loop failed: ${result.value.stderr.slice(0, 200)}`);
    return { exit, stdout: result.value.stdout.trim() };
  }

  test(
    "renders once, seals the master and refuses a duplicate invocation",
    fixtureWork(async () => {
      // A separate input pair must sign every read of the render inputs, and the
      // output pair every request for the master, so an operator can give the
      // inputs a read-only credential.
      const signedBefore = signedBy.length;
      const first = await runHost({
        SONG_VIDEO_RENDER_R2_INPUT_ACCESS_KEY_ID: "test-input-access-key",
        SONG_VIDEO_RENDER_R2_INPUT_SECRET_ACCESS_KEY: "test-input-secret-key",
      });
      const firstRequests = signedBy.slice(signedBefore);
      const masterPhysicalKey = masterKey.replace("media://immutable/", "immutable/");
      const inputRequests = firstRequests.filter((request) => request.key !== masterPhysicalKey);
      const masterRequests = firstRequests.filter((request) => request.key === masterPhysicalKey);
      expect(new Set(inputRequests.map((request) => request.key))).toEqual(
        new Set([
          `immutable/${operationId}/video/1`,
          SONG_ASSET.replace("media://immutable/", "immutable/"),
        ]),
      );
      expect(inputRequests.every((request) => request.method === "GET")).toBe(true);
      expect(
        inputRequests.every((request) => request.accessKeyId === "test-input-access-key"),
      ).toBe(true);
      expect(masterRequests.some((request) => request.method === "PUT")).toBe(true);
      expect(masterRequests.every((request) => request.accessKeyId === "test-access-key")).toBe(
        true,
      );
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
      completedTestCount += 1;
    }),
    600_000,
  );

  test(
    "a targeted measurement measures only the named song and replays as nothing",
    fixtureWork(async () => {
      await seedPublishedSongFixture(admin, {
        songPostId: MEASURE_SONG_POST,
        communityId: videoCommunity,
        audioAssetRef: MEASURE_SONG_ASSET,
        canonicalAudioSha256: songSha,
        durationSamples: null,
        title: "Host suite measured song",
        contentRating: "general",
        derivativeVideo: "allowed",
        licensePreset: "commercial-remix",
        commercialRemixShareBps: 1_000,
      });
      await admin.query(
        `INSERT INTO media_song_canonical_timings
         (song_post_id,audio_revision,song_community_id,canonical_audio_sha256,state)
       VALUES ($1,1,$2,$3,'pending')`,
        [MEASURE_SONG_POST, videoCommunity, songSha],
      );
      const songObject = objects.get(SONG_ASSET.replace("media://immutable/", "immutable/"));
      if (songObject === undefined) throw new Error("song object missing");
      const measureKey = MEASURE_SONG_ASSET.replace("media://immutable/", "immutable/");
      objects.set(measureKey, { ...songObject, etag: "measure-song-etag" });

      const timing = async (postId: string) =>
        (
          await client.query("SELECT * FROM media_song_canonical_timings WHERE song_post_id=$1", [
            postId,
          ])
        ).rows[0];
      const snapshot = async () => ({
        loop: await timing(LOOP_SONG_POST),
        attempts: (
          await client.query("SELECT * FROM media_song_video_render_attempts ORDER BY attempt_id")
        ).rows,
        masters: (
          await client.query("SELECT * FROM media_song_video_masters ORDER BY master_revision_id")
        ).rows,
      });
      const unrelated = await snapshot();
      expect(unrelated.loop.state).toBe("pending");
      // The render selectors from the shared environment are cleared, and only
      // a read credential is given: measuring needs no writing credential.
      const measureEnv = {
        SONG_VIDEO_RENDER_PLAN_ID: "",
        SONG_VIDEO_RENDER_ATTEMPT_ID: "",
        SONG_VIDEO_RENDER_R2_ACCESS_KEY_ID: "",
        SONG_VIDEO_RENDER_R2_SECRET_ACCESS_KEY: "",
        SONG_VIDEO_RENDER_R2_INPUT_ACCESS_KEY_ID: "test-input-access-key",
        SONG_VIDEO_RENDER_R2_INPUT_SECRET_ACCESS_KEY: "test-input-secret-key",
        SONG_VIDEO_RENDER_MEASURE_SONG_POST_ID: MEASURE_SONG_POST,
        SONG_VIDEO_RENDER_MEASURE_AUDIO_REVISION: "1",
      };
      const signedBefore = signedBy.length;
      const putsBefore = putCount;
      const first = await runHost(measureEnv);
      expect(first.exit).toBe(0);
      expect(JSON.parse(first.stdout)).toEqual({
        song_post_id: MEASURE_SONG_POST,
        audio_revision: 1,
        status: "measured",
        duration_samples: songDurationSamples,
      });
      const measured = await timing(MEASURE_SONG_POST);
      expect(measured).toMatchObject({
        state: "ready",
        duration_samples: String(songDurationSamples),
        canonical_audio_sha256: songSha,
        attempts: 1,
        lease_expires_at: null,
      });
      const requests = signedBy.slice(signedBefore);
      expect(requests.length).toBeGreaterThan(0);
      expect(
        requests.every(
          (request) =>
            request.method === "GET" &&
            request.key === measureKey &&
            request.accessKeyId === "test-input-access-key",
        ),
      ).toBe(true);
      expect(putCount).toBe(putsBefore);
      expect(await snapshot()).toEqual(unrelated);

      // Replay: the revision is concluded, so nothing is claimed, read or written.
      const signedBeforeReplay = signedBy.length;
      const replay = await runHost(measureEnv);
      expect(replay.exit).toBe(0);
      expect(JSON.parse(replay.stdout)).toEqual({
        song_post_id: MEASURE_SONG_POST,
        audio_revision: 1,
        status: "not_claimed",
      });
      expect(await timing(MEASURE_SONG_POST)).toEqual(measured);
      expect(signedBy.length).toBe(signedBeforeReplay);
      expect(await snapshot()).toEqual(unrelated);

      // A measurement combined with a render selector is refused before any
      // database or bucket access, with the operator-facing reason intact.
      const { exit: conflictExit, stderr: conflictErr } = await drainHost(
        spawnHost({
          ...hostEnv(),
          ...measureEnv,
          SONG_VIDEO_RENDER_PLAN_ID: planId,
        }),
      );
      expect(conflictExit).toBe(1);
      expect(conflictErr.trim()).toBe(
        "SONG_VIDEO_RENDER_MEASURE_SONG_POST_ID conflicts with SONG_VIDEO_RENDER_PLAN_ID",
      );
      expect(signedBy.length).toBe(signedBeforeReplay);
      completedTestCount += 1;
    }),
    300_000,
  );

  test(
    "the loop measures a pending song and claims without a plan id until signalled",
    fixtureWork(async () => {
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
      completedTestCount += 1;
    }),
    600_000,
  );

  test(
    "the host role cannot rewrite a sealed immutable object",
    fixtureWork(async () => {
      await assertRenderHostFixturePrivileges(roleScoped.toString(), hostRole, operationId);
      completedTestCount += 1;
    }),
    600_000,
  );
});
