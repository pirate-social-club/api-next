import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MediaUploadSealer } from "@pirate/application/media/submission-sealing";
import { mediaSha256Bytes } from "@pirate/application/media/submission-service";
import { VIDEO_POSTER_POLICY_V1, type VideoStreamObservation } from "@pirate/domain";
import { Effect } from "effect";
import type { Client } from "pg";
import { Client as PgClient } from "pg";
import { getVideoPlaybackAccess } from "../packages/application/src/video/playback-access.ts";
import {
  createVideoSubmission,
  finalizeVideoSubmission,
  getVideoSubmission,
  reserveVideoUpload,
  retryVideoSubmission,
  type VideoMultipartUploadGateway,
  type VideoPublicationServices,
  videoIngressObjectKey,
} from "../packages/application/src/video/publication.ts";
import { measurePendingSongTimings } from "../packages/application/src/video/song-canonical-timing.ts";
import { preflightSongVideoInterval } from "../packages/application/src/video/song-interval.ts";
import type { SongVideoRenderer } from "../packages/application/src/video/song-render.ts";
import { consumeVideoStreamIngest } from "../packages/application/src/video/stream-ingest.ts";
import { consumeVideoThumbnail } from "../packages/application/src/video/thumbnail-enrichment.ts";
import {
  runVideoAnalysisWorkflow,
  type VideoWorkflowServices,
  type VideoWorkflowStep,
} from "../packages/application/src/video/workflow.ts";
import { VideoWorkflowTerminalError } from "../packages/application/src/video/workflow-errors.ts";
import { makeControlPlaneContentStore } from "../packages/platform-cf/src/content-repository.ts";
import { makeControlPlanePersonaStore } from "../packages/platform-cf/src/persona-repository.ts";
import { makeDirectPostgresControlPlaneLayer } from "../packages/platform-cf/src/postgres.ts";
import { makeControlPlaneSongVideoIntervalStore } from "../packages/platform-cf/src/song-video-interval-repository.ts";
import { verifyAndSealMaster } from "../packages/platform-cf/src/song-video-render-repository.ts";
import { makeSongVideoRenderStore } from "../packages/platform-cf/src/song-video-render-store.ts";
import { makeVideoPublicationAuthorization } from "../packages/platform-cf/src/video-access-authorization.ts";
import { makeControlPlaneVideoAnalysisOutboxRepository } from "../packages/platform-cf/src/video-analysis-outbox-repository.ts";
import { makeVideoPlaybackAuthority } from "../packages/platform-cf/src/video-playback-authority.ts";
import { makeVideoPosterAuthority } from "../packages/platform-cf/src/video-poster-authority.ts";
import { streamVideoPoster } from "../packages/platform-cf/src/video-poster-stream.ts";
import {
  actor,
  community,
  persona,
  seedPublishedSongFixture,
  seedSongOwner,
  seedVideoActors,
  songOwner,
  songOwnerPersona,
} from "../packages/platform-cf/src/video-publication.pg-fixture.ts";
import { makeControlPlaneVideoPublicationStore } from "../packages/platform-cf/src/video-publication-repository.ts";
import { makeVideoSealedSourceVerifier } from "../packages/platform-cf/src/video-sealed-source-verifier.ts";
import {
  makeVideoStageArtifactHead,
  videoDerivedArtifactKey,
} from "../packages/platform-cf/src/video-stage-artifact-head.ts";
import { makeControlPlaneVideoStageFactStore } from "../packages/platform-cf/src/video-stage-fact-repository.ts";
import { makeVideoStreamIngestStore } from "../packages/platform-cf/src/video-stream-ingest-repository.ts";
import { makeVideoThumbnailStore } from "../packages/platform-cf/src/video-thumbnail-repository.ts";
import { makeVideoThumbnailVerifier } from "../packages/platform-cf/src/video-thumbnail-verifier.ts";
import {
  applyPostgresTestBaselineConnection,
  withReusablePostgresTestSchema,
} from "./postgres-test-baseline.ts";
import {
  makeLocalPinnedFfmpegSongVideoEngine,
  SONG_VIDEO_DECODE_CHAIN,
} from "./song-video-ffmpeg.ts";
import {
  makeLocalSongVideoRenderer,
  makeLocalVersionedMasterStore,
} from "./song-video-local-render.ts";
import { makeLocalPinnedFfmpegVideoAnalysisEngine } from "./video-analysis-ffmpeg.ts";

/**
 * The composed song-backed video path, end to end on one machine: interval
 * preflight and lazy measurement, reservation, upload, submission, analysis,
 * decision, rendering, sealing, atomic publication, Stream ingest of the
 * master, and playback after a reload.
 *
 * PostgreSQL is real, with every trigger live. FFmpeg is real and pinned: it
 * measures the canonical song, probes and frames the capture, and renders and
 * verifies the master. Only external providers are fakes: object storage,
 * the safety classifier and Cloudflare Stream. Skipped where either the
 * database or the pinned FFmpeg is absent, so a skip is never read as a pass.
 */
const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
const version = Bun.spawnSync(["ffmpeg", "-version"], { stdout: "pipe", stderr: "ignore" });
const pinned =
  version.exitCode === 0 &&
  new TextDecoder().decode(version.stdout).startsWith("ffmpeg version 6.1.1");
const suite = connectionString !== undefined && pinned ? describe : describe.skip;

const SECOND = 48_000;
const SONG_POST = "post-song-composed";
const SONG_ASSET = "media://immutable/media-operation-song-composed/audio/1";
const CLIP_START = 2 * SECOND + 123;
const CLIP_DURATION = 4 * SECOND + 777;

function scopedConnection(raw: string, schema: string): string {
  return `${raw}${raw.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}

async function ffmpeg(args: readonly string[]): Promise<void> {
  const child = Bun.spawn(["ffmpeg", "-v", "error", "-nostdin", "-y", ...args], {
    stdout: "ignore",
    stderr: "pipe",
  });
  if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text());
}

/** Real media: a 12 s song as a 44.1 kHz MP3, and a 6 s phone-like capture with its own sound. */
async function makeMedia(directory: string) {
  await ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=44100:duration=12",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "128k",
    join(directory, "song.mp3"),
  ]);
  await ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=360x640:rate=30:duration=6",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:duration=6",
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
  return {
    song: new Uint8Array(await readFile(join(directory, "song.mp3"))),
    capture: new Uint8Array(await readFile(join(directory, "capture.mp4"))),
  };
}

/** An independent decode of bytes' first audio track, optionally through the chain and a trim. */
async function decodedDigest(
  directory: string,
  bytes: Uint8Array,
  filter: string | null,
): Promise<string> {
  const input = join(directory, `decode-${crypto.randomUUID()}.bin`);
  const output = `${input}.pcm`;
  await writeFile(input, bytes);
  await ffmpeg([
    "-i",
    input,
    "-map",
    "0:a:0",
    ...(filter === null ? [] : ["-af", filter]),
    "-c:a",
    "pcm_s16le",
    "-f",
    "s16le",
    output,
  ]);
  return mediaSha256Bytes(new Uint8Array(await readFile(output)));
}

/** Local object storage: multipart ingress, sealed originals and derived artifacts. */
function makeLocalObjects() {
  const ingress = new Map<string, Uint8Array>();
  const immutable = new Map<string, { bytes: Uint8Array; etag: string; version: string }>();
  const derived = new Map<string, { bytes: Uint8Array; sha256: string; contentType: string }>();
  const multipart: VideoMultipartUploadGateway = {
    create: async (input) => ({
      uploadId: `upload-${input.objectKey}`,
      partSizeBytes: input.partSizeBytes,
      partCount: input.partCount,
      parts: Array.from({ length: input.partCount }, (_, index) => ({
        partNumber: index + 1,
        url: `https://upload.invalid/${encodeURIComponent(input.objectKey)}/${index + 1}`,
        expiresAt: new Date(Date.now() + input.expiresInSeconds * 1_000).toISOString(),
      })),
      expiresAt: new Date(Date.now() + input.expiresInSeconds * 1_000).toISOString(),
    }),
    renew: async () => [],
    completeOrInspect: async (input) => {
      if (!ingress.has(input.objectKey)) throw new Error("nothing was uploaded");
      return { completed: true };
    },
    abort: async () => undefined,
  };
  const sealer: MediaUploadSealer = {
    inspect: async (input) => {
      const bytes = ingress.get(input.sourceKey);
      if (bytes === undefined) return { outcome: "source_missing" };
      if (bytes.byteLength !== input.expectedSizeBytes) return { outcome: "expectation_mismatch" };
      return {
        outcome: "ready",
        source: {
          key: input.sourceKey,
          version: "ingress-v1",
          etag: "ingress-etag",
          size: bytes.byteLength,
          contentType: input.expectedContentType,
          ownerMarker: null,
          sourceVersion: null,
          checksums: {},
        },
      };
    },
    seal: async (input) => {
      const bytes = ingress.get(input.source.key);
      if (bytes === undefined) return { result: { outcome: "source_precondition_failed" } };
      const canonicalSha256 = await mediaSha256Bytes(bytes);
      if (input.expectedSha256 !== undefined && input.expectedSha256 !== canonicalSha256)
        return { result: { outcome: "expectation_mismatch" } };
      immutable.set(input.immutableRef, {
        bytes,
        etag: `etag-${canonicalSha256.slice(0, 16)}`,
        version: "immutable-v1",
      });
      return {
        result: {
          outcome: "sealed",
          immutable_ref: input.immutableRef,
          destination_ref: `r2://${input.destinationKey}`,
          etag: `etag-${canonicalSha256.slice(0, 16)}`,
          version: "immutable-v1",
          size_bytes: bytes.byteLength,
          canonical_sha256: canonicalSha256,
        },
      };
    },
  };
  return { ingress, immutable, derived, multipart, sealer };
}

const plainStep: VideoWorkflowStep = {
  do: (_name, run) => run(),
  sleep: async () => undefined,
  waitForEvent: async () => {
    throw new Error("the composed flow holds no review");
  },
};

/** Retries a thrown step the way the Worker's step options do; terminal errors stop. */
const retryingStep: VideoWorkflowStep = {
  ...plainStep,
  do: async (_name, run) => {
    let failure: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await run();
      } catch (error) {
        if (error instanceof VideoWorkflowTerminalError) throw error;
        failure = error;
      }
    }
    throw failure;
  },
};

/** Counts every call the render stage makes into the renderer. */
function countingRenderer(
  inner: SongVideoRenderer,
  override: Partial<Pick<SongVideoRenderer, "submit" | "observe">> = {},
) {
  const calls = { submit: 0, observe: 0 };
  const renderer: SongVideoRenderer = {
    identity: inner.identity,
    policyRevision: inner.policyRevision,
    submit: async (request) => {
      calls.submit += 1;
      return (override.submit ?? inner.submit)(request);
    },
    observe: async (input) => {
      calls.observe += 1;
      return (override.observe ?? inner.observe)(input);
    },
  };
  return { renderer, calls };
}

function withRenderer(composed: Composed, renderer: SongVideoRenderer): VideoWorkflowServices {
  const render = composed.workflow.songRender;
  if (render === undefined) throw new Error("render stage is not composed");
  return { ...composed.workflow, songRender: { ...render, renderer } };
}

async function attemptsOf(composed: Composed) {
  const result = await composed.admin.query<{ state: string; execution_phase: string }>(
    `SELECT state,execution_phase FROM "${composed.schema}".media_song_video_render_attempts
      ORDER BY generation`,
  );
  return result.rows.map((row) => `${row.state}:${row.execution_phase}`);
}

/**
 * Delivery after publication, through the real stores and authorities: Stream
 * encodes the accepted master (a fake that verifies it was handed the master),
 * the sealed poster is verified for the thumbnail, then a viewer asks for
 * playback and for the poster as the HTTP routes do.
 */
async function deliver(composed: Composed, operationId: string, postId: string) {
  const providerVideoId = "0123456789abcdef0123456789abcdef";
  const copied: string[] = [];
  const ingest = await consumeVideoStreamIngest(`video-enrichment:${operationId}:stream`, {
    store: makeVideoStreamIngestStore(composed.layer, { leaseOwner: "composed", leaseMs: 60_000 }),
    transport: {
      copy: async (input) => {
        const object = await composed.masters.read(input.sealedSourceRef);
        if (object === null) throw new Error("Stream was handed a ref with no master");
        if ((await mediaSha256Bytes(object.bytes)) !== input.identity.sourceSha256)
          throw new Error("Stream was handed bytes that are not the identity");
        copied.push(input.identity.sourceSha256);
      },
      observe: async (identity): Promise<readonly VideoStreamObservation[]> => [
        {
          providerVideoId,
          creator: identity.creator,
          sourceSha256: identity.sourceSha256,
          encoding: "ready",
          requireSignedURLs: true,
          downloadsEnabled: false,
        },
      ],
    },
    nowMs: () => Date.now(),
    deadlines: (now) => ({
      acceptanceDeadlineMs: now + 600_000,
      encodingDeadlineMs: now + 3_600_000,
    }),
  });
  // The derived bucket as sealed: poster metadata names the capture as source.
  const sealed = (key: string) => {
    const artifact = composed.objects.derived.get(key);
    if (artifact === undefined) return null;
    return {
      artifact,
      metadata: {
        key,
        size: artifact.bytes.byteLength,
        httpEtag: `"${artifact.sha256.slice(0, 16)}"`,
        httpMetadata: { contentType: artifact.contentType },
        customMetadata: {
          sha256: artifact.sha256,
          sourceSha256: composed.captureSha256,
          policyRevision: String(VIDEO_POSTER_POLICY_V1.policyRevision),
        },
      },
    };
  };
  const resolveArtifact = makeVideoPosterAuthority(composed.layer);
  const thumbnail = await consumeVideoThumbnail(`video-enrichment:${operationId}:thumbnail`, {
    store: makeVideoThumbnailStore(composed.layer, { leaseMs: 60_000 }),
    verify: makeVideoThumbnailVerifier({
      resolveArtifact,
      bucket: { head: async (key) => sealed(key)?.metadata ?? null },
    }),
  });
  const contentStore = makeControlPlaneContentStore(composed.layer);
  const authorizePublication = makeVideoPublicationAuthorization(composed.layer);
  const playback = await Effect.runPromise(
    getVideoPlaybackAccess(
      { postId, viewerUserId: actor, trustedSource: "composed-test" },
      {
        contentStore,
        authorizePublication,
        resolveApprovedPlayback: makeVideoPlaybackAuthority(composed.layer),
        customerHost: "customer-composed123.cloudflarestream.com",
        nowMs: Effect.sync(() => Date.now()),
        limit: () => Effect.succeed({ allowed: true, retryAfterSeconds: 0 }),
        sign: () => Effect.succeed("header.payload.signature"),
      },
    ),
  );
  const poster = await Effect.runPromise(
    streamVideoPoster(
      { postId, viewerUserId: actor },
      {
        contentStore,
        authorizePublication,
        resolveArtifact,
        bucket: {
          get: async (key) => {
            const found = sealed(key);
            return found === null
              ? null
              : {
                  ...found.metadata,
                  body: new Response(found.artifact.bytes).body as ReadableStream<Uint8Array>,
                };
          },
        },
      },
    ),
  );
  return { ingest, copied, thumbnail, playbackUrl: playback.playback_url, poster };
}

async function loseMembership(composed: Composed) {
  await composed.admin.query(
    `UPDATE "${composed.schema}".community_memberships SET status='left',left_at=clock_timestamp()
      WHERE community_id=$1 AND user_id=$2`,
    [community, actor],
  );
}

async function rejoin(composed: Composed) {
  await composed.admin.query(
    `UPDATE "${composed.schema}".community_memberships SET status='member',left_at=NULL
      WHERE community_id=$1 AND user_id=$2`,
    [community, actor],
  );
}

type Composed = Awaited<ReturnType<typeof compose>>;

/**
 * One schema, one published song, real media and every service the path uses.
 * Each scenario gets its own, so no scenario can pass on another's state.
 */
async function compose(admin: Client, schema: string, directory: string) {
  if (connectionString === undefined) throw new Error("unreachable");
  const connection = scopedConnection(connectionString, schema);
  await admin.query(`SET search_path TO "${schema}"`);
  await applyPostgresTestBaselineConnection({ connectionString: connection });
  await seedVideoActors(admin);
  await seedSongOwner(admin);
  const media = await makeMedia(directory);
  const songSha256 = await mediaSha256Bytes(media.song);
  const captureSha256 = await mediaSha256Bytes(media.capture);
  // Published, licensed, owner policy allowing derivative video, and not yet
  // measured: the flow must measure it itself.
  await seedPublishedSongFixture(admin, {
    songPostId: SONG_POST,
    communityId: community,
    audioAssetRef: SONG_ASSET,
    canonicalAudioSha256: songSha256,
    durationSamples: null,
    title: "Composed song",
    contentRating: "general",
    derivativeVideo: "allowed",
    licensePreset: "commercial-remix",
    commercialRemixShareBps: 1_500,
  });

  const layer = makeDirectPostgresControlPlaneLayer(connection);
  const objects = makeLocalObjects();
  const mediaReader = {
    read: async (reference: string) => {
      if (reference === SONG_ASSET) return media.song;
      const sealed = objects.immutable.get(reference);
      if (sealed === undefined) throw new Error(`no immutable media at ${reference}`);
      return sealed.bytes;
    },
  };
  const songEngine = makeLocalPinnedFfmpegSongVideoEngine({ mediaReader });
  const analysisEngine = makeLocalPinnedFfmpegVideoAnalysisEngine({
    sourceReader: { read: (source) => mediaReader.read(source.objectKey) },
    artifactWriter: {
      write: async (artifact) => {
        const artifactRef = `media://derived/${artifact.artifactKey}`;
        objects.derived.set(videoDerivedArtifactKey(artifactRef), {
          bytes: artifact.bytes,
          sha256: artifact.canonicalSha256,
          contentType: artifact.mediaType,
        });
        return { artifactRef };
      },
    },
  });
  const intervalStore = makeControlPlaneSongVideoIntervalStore(layer);
  const contentStore = makeControlPlaneContentStore(layer);
  const store = makeControlPlaneVideoPublicationStore(layer);
  const songInterval = { store: intervalStore, contentStore };
  const services: VideoPublicationServices = {
    store,
    songInterval,
    multipart: objects.multipart,
    sealer: objects.sealer,
    personaServices: { personaStore: makeControlPlanePersonaStore(layer) },
    nowIso: () => new Date().toISOString(),
  };
  const outbox = makeControlPlaneVideoAnalysisOutboxRepository(layer);
  const masters = makeLocalVersionedMasterStore();
  const moderated: number[][] = [];
  const workflow: VideoWorkflowServices = {
    store,
    nowIso: () => new Date().toISOString(),
    outbox,
    reconciliation: store,
    stageFacts: makeControlPlaneVideoStageFactStore(layer),
    verifySource: makeVideoSealedSourceVerifier(layer, async (reference) => {
      const sealed = objects.immutable.get(reference);
      return sealed === undefined
        ? null
        : {
            etag: sealed.etag,
            version: sealed.version,
            size: sealed.bytes.byteLength,
            httpMetadata: { contentType: "video/mp4" },
          };
    }),
    artifactHead: makeVideoStageArtifactHead({
      head: async (key) => {
        const artifact = objects.derived.get(key);
        return artifact === undefined
          ? null
          : {
              size: artifact.bytes.byteLength,
              customMetadata: { sha256: artifact.sha256 },
              httpMetadata: { contentType: artifact.contentType },
            };
      },
    }),
    analysisProviders: {
      identifySoundtrack: async () => {
        throw new Error("a song-reference capture is never recognized");
      },
      moderate: async (input) => {
        moderated.push(input.frames.map((frame) => frame.timestampMs));
        return {
          requestId: `safety-${input.operationId}`,
          evidenceRef: `safety-evidence-${input.operationId}`,
          minorSafetyEvidenceRef: `minor-safety-${input.operationId}`,
          mediaSafety: "allow",
          captionSafety: input.caption === null ? "not_applicable" : "allow",
          automatedRating: "general",
          policyRevision: "fake-safety-v1",
          adapterRevision: "fake-safety-adapter-v1",
        };
      },
    },
    transform: analysisEngine,
    transformAttempts: outbox,
    songRender: {
      store: makeSongVideoRenderStore({
        connect: async () => {
          const client = new PgClient({ connectionString: connection });
          await client.connect();
          return client;
        },
        output: masters,
        prober: { probe: (bytes) => songEngine.probeMaster(bytes) },
        soundtrack: songEngine,
      }),
      renderer: makeLocalSongVideoRenderer({ engine: songEngine, output: masters }),
    },
  };
  return {
    admin,
    schema,
    connection,
    directory,
    layer,
    media,
    captureSha256,
    songEngine,
    intervalStore,
    songInterval,
    store,
    services,
    workflow,
    masters,
    moderated,
    objects,
    author: { userId: actor, kind: "user" as const },
  };
}

/** Measure, preflight, reserve, upload, create and finalize, through the real commands. */
async function submitCapture(composed: Composed, label: string) {
  const { services, songInterval, intervalStore, songEngine, media, captureSha256, author } =
    composed;
  const pending = await intervalStore.getOrRequestTiming({
    songPostId: SONG_POST,
    songCommunityId: community,
    audioRevision: 1,
    canonicalAudioSha256: await mediaSha256Bytes(media.song),
    songAssetId: SONG_ASSET,
  });
  if (pending.state === "pending")
    await measurePendingSongTimings({ store: intervalStore, prober: songEngine.prober });
  await preflightSongVideoInterval(
    { communityId: community, actor: author, body: { song_post_id: SONG_POST } },
    songInterval,
  );
  const reservation = await reserveVideoUpload(
    {
      communityId: community,
      actor: author,
      body: {
        persona_id: persona,
        idempotency_key: `${label}-reserve`,
        track: "video",
        slot: "primary_video",
        expected_content_type: "video/mp4",
        expected_size_bytes: media.capture.byteLength,
        expected_sha256: captureSha256,
        intent: "song_reference",
        song_post_id: SONG_POST,
        selected_from: { kind: "library" },
        audio_revision: 1,
        clip_start_samples: CLIP_START,
        clip_duration_samples: CLIP_DURATION,
      },
    },
    services,
  );
  const created = await createVideoSubmission(
    {
      communityId: community,
      actor: author,
      body: {
        persona_id: persona,
        version: "video-start-input-v1",
        video_reservation_id: reservation.reservation_id,
        idempotency_key: `${label}-create`,
      },
    },
    services,
  );
  composed.objects.ingress.set(videoIngressObjectKey(reservation.reservation_id), media.capture);
  await finalizeVideoSubmission(
    {
      submissionId: created.submission_id,
      actor: author,
      body: {
        persona_id: persona,
        idempotency_key: `${label}-finalize`,
        expected_creation_revision: 1,
        reservation_id: reservation.reservation_id,
        parts: [{ part_number: 1, etag: "etag-1" }],
      },
    },
    services,
  );
  return {
    submissionId: created.submission_id,
    effectIdentity: await analysisIdentity(composed, created.submission_id),
    operationId: await operationOf(composed, created.submission_id),
  };
}

async function analysisIdentity(composed: Composed, submissionId: string): Promise<string> {
  const intent = await composed.admin.query<{ effect_identity: string }>(
    `SELECT effect_identity FROM "${composed.schema}".media_video_analysis_outbox WHERE submission_id=$1`,
    [submissionId],
  );
  const identity = intent.rows[0]?.effect_identity;
  if (identity === undefined) throw new Error("no analysis intent was recorded");
  return identity;
}

async function operationOf(composed: Composed, submissionId: string): Promise<string> {
  const record = await composed.store.getSubmissionForAccount({
    submissionId,
    actorAccountId: actor,
  });
  if (record === null) throw new Error("no submission");
  return record.state.operationId;
}

async function inSchema(use: (admin: Client, schema: string, directory: string) => Promise<void>) {
  if (connectionString === undefined) throw new Error("unreachable");
  await withReusablePostgresTestSchema({
    baseConnectionString: connectionString,
    schemaName: "scripts_song_video_composed_flow_pg_test_ts",
    use: async ({ admin, schema }) => {
      const directory = await mkdtemp(join(tmpdir(), "pirate-song-composed-"));
      try {
        await use(admin, schema, directory);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  });
}

suite("composed song-backed video: reserve, render, publish, play", () => {
  test("publishes the canonical interval over the capture and plays it after a reload", async () => {
    await inSchema(async (admin, schema, directory) => {
      const composed = await compose(admin, schema, directory);
      const {
        connection,
        layer,
        media,
        captureSha256,
        songEngine,
        intervalStore,
        store,
        services,
        workflow,
        masters,
        moderated,
        objects,
        author,
      } = composed;
      // 1. Preflight: unmeasured, so it answers measuring and requests it.
      const preflight = { song_post_id: SONG_POST };
      expect(
        await preflightSongVideoInterval(
          { communityId: community, actor: author, body: preflight },
          services.songInterval ?? (undefined as never),
        ),
      ).toMatchObject({ state: "measuring", song_post_id: SONG_POST });
      // The renderer's own decode measures it, once, from the exact bytes.
      const measured = await measurePendingSongTimings({
        store: intervalStore,
        prober: songEngine.prober,
      });
      expect(measured).toMatchObject({ measured: 1 });
      const ready = await preflightSongVideoInterval(
        {
          communityId: community,
          actor: author,
          body: {
            ...preflight,
            interval: { clip_start_samples: CLIP_START, clip_duration_samples: CLIP_DURATION },
          },
        },
        services.songInterval ?? (undefined as never),
      );
      expect(ready).toMatchObject({
        state: "ready",
        audio_revision: 1,
        canonical_duration_samples: 12 * SECOND,
        interval: { accepted: true },
      });

      // 2. Reservation freezes the interval against that revision.
      const reservation = await reserveVideoUpload(
        {
          communityId: community,
          actor: author,
          body: {
            persona_id: persona,
            idempotency_key: "composed-reserve",
            track: "video",
            slot: "primary_video",
            expected_content_type: "video/mp4",
            expected_size_bytes: media.capture.byteLength,
            expected_sha256: captureSha256,
            intent: "song_reference",
            song_post_id: SONG_POST,
            selected_from: { kind: "library" },
            audio_revision: 1,
            clip_start_samples: CLIP_START,
            clip_duration_samples: CLIP_DURATION,
          },
        },
        services,
      );
      expect(reservation).toMatchObject({ intent: "song_reference" });
      const reservationId = reservation.reservation_id;

      // 3. Upload, submission and finalize, through the real commands.
      objects.ingress.set(videoIngressObjectKey(reservationId), media.capture);
      const created = await createVideoSubmission(
        {
          communityId: community,
          actor: author,
          body: {
            persona_id: persona,
            version: "video-start-input-v1",
            video_reservation_id: reservationId,
            caption: "Dancing to the composed song",
            idempotency_key: "composed-create",
          },
        },
        services,
      );
      expect(created).toMatchObject({ intent: "song_reference", status: "processing" });
      const finalized = await finalizeVideoSubmission(
        {
          submissionId: created.submission_id,
          actor: author,
          body: {
            persona_id: persona,
            idempotency_key: "composed-finalize",
            expected_creation_revision: 1,
            reservation_id: reservationId,
            parts: [{ part_number: 1, etag: "etag-1" }],
          },
        },
        services,
      );
      expect(finalized).toMatchObject({ status: "processing", phase: "analysis" });

      const effectIdentity = await analysisIdentity(composed, created.submission_id);
      const step = plainStep;
      expect(await runVideoAnalysisWorkflow(effectIdentity, step, workflow)).toEqual({
        status: "published",
      });
      // Every moderated frame lies inside the interval the master carries.
      expect(moderated).toEqual([[1_000, 0, Math.floor(Math.ceil(CLIP_DURATION / 48) / 2)]]);

      const published = await getVideoSubmission(
        { submissionId: created.submission_id, actor: author },
        services,
      );
      expect(published).toMatchObject({ status: "published", intent: "song_reference" });
      if (published.status !== "published") throw new Error("unreachable");
      const postId = published.published_resource.post_id;
      const operationId = (
        await store.getSubmissionForAccount({
          submissionId: created.submission_id,
          actorAccountId: actor,
        })
      )?.state.operationId;
      if (operationId === undefined) throw new Error("no operation");

      // 5. What was published is the accepted master, not the capture.
      const row = await admin.query<{
        video_asset_ref: string;
        canonical_video_sha256: string;
        original_sound_id: string | null;
        master_revision_id: string;
        soundtrack_sha256: string;
        measured_audio_duration_samples: string;
        measured_video_duration_samples: string;
      }>(
        `SELECT p.video_asset_ref,p.canonical_video_sha256,p.original_sound_id,
                m.master_revision_id,m.soundtrack_sha256,
                m.measured_audio_duration_samples,m.measured_video_duration_samples
           FROM "${schema}".media_publication_projections p
           JOIN "${schema}".media_song_video_masters m
             ON m.master_revision_id=p.song_video_master_revision_id
          WHERE p.post_id=$1`,
        [postId],
      );
      const projection = row.rows[0];
      if (projection === undefined) throw new Error("no projection");
      expect(projection.original_sound_id).toBeNull();
      expect(projection.canonical_video_sha256).not.toBe(captureSha256);
      expect(Number(projection.measured_audio_duration_samples)).toBe(CLIP_DURATION);
      expect(Number(projection.measured_video_duration_samples)).toBe(CLIP_DURATION);
      const master = await masters.read(projection.video_asset_ref);
      if (master === null) throw new Error("the published master is not stored");
      expect(await mediaSha256Bytes(master.bytes)).toBe(projection.canonical_video_sha256);
      // Decoded independently: the master's audio is the canonical interval
      // bit for bit, and neither another interval nor the capture's sound.
      const interval = await decodedDigest(
        directory,
        media.song,
        `${SONG_VIDEO_DECODE_CHAIN},atrim=start_sample=${CLIP_START}:end_sample=${CLIP_START + CLIP_DURATION}`,
      );
      expect(await decodedDigest(directory, master.bytes, null)).toBe(interval);
      expect(projection.soundtrack_sha256).toBe(interval);
      // The master is a registered immutable object, addressed exactly as the
      // source gateway, Stream grants and DATA resolve it. Registration with
      // publication is what lets a real Stream copy name these bytes.
      expect(projection.video_asset_ref.startsWith("media://immutable/")).toBe(true);
      const registered = await admin.query<{
        destination_ref: string;
        object_version: string;
        etag: string;
        size_bytes: string;
        canonical_sha256: string;
      }>(
        `SELECT destination_ref,object_version,etag,size_bytes::text,canonical_sha256
           FROM "${schema}".media_immutable_objects WHERE immutable_ref=$1`,
        [projection.video_asset_ref],
      );
      expect(registered.rows[0]).toEqual({
        destination_ref: `r2://${projection.video_asset_ref.replace("media://immutable/", "immutable/")}`,
        object_version: master.objectVersion,
        etag: master.etag,
        size_bytes: String(master.bytes.byteLength),
        canonical_sha256: projection.canonical_video_sha256,
      });
      expect(
        await decodedDigest(
          directory,
          media.song,
          `${SONG_VIDEO_DECODE_CHAIN},atrim=start_sample=${CLIP_START + SECOND}:end_sample=${CLIP_START + SECOND + CLIP_DURATION}`,
        ),
      ).not.toBe(interval);

      // The edge, its committed policy snapshot, derivative rights and the
      // derivative DATA intent with its deterministic parent.
      const facts = await admin.query(
        `SELECT
           (SELECT row_to_json(e) FROM (SELECT song_post_id,relationship,derivative_video,policy_permitted
              FROM "${schema}".media_video_song_references WHERE post_id=$1) e) AS edge,
           (SELECT rights_basis FROM "${schema}".media_video_rights WHERE submission_id=$2) AS rights,
           (SELECT array_agg(observed_at_transition || ':' || permitted ORDER BY observed_at_transition)
              FROM "${schema}".song_derivative_video_policy_observations WHERE operation_id=$3) AS observations,
           (SELECT row_to_json(d) FROM (SELECT o.media_kind,o.rights_basis,o.canonical_audio_sha256,
               r.relationship,r.parent_asset_id,r.parent_registration_operation_id,
               r.expected_parent_license_preset,r.expected_parent_commercial_rev_share_bps
              FROM "${schema}".data_registration_operations o
              JOIN "${schema}".data_registration_parent_references r USING (registration_operation_id)
             WHERE o.post_id=$1) d) AS registration,
           (SELECT count(*)::int FROM "${schema}".data_registration_outbox) AS launches,
           (SELECT count(*)::int FROM "${schema}".media_video_derived_artifacts
             WHERE submission_id=$2 AND artifact_kind='extracted_audio') AS extracted_audio`,
        [postId, created.submission_id, operationId],
      );
      expect(facts.rows[0]).toEqual({
        edge: {
          song_post_id: SONG_POST,
          relationship: "references_song",
          derivative_video: "allowed",
          policy_permitted: true,
        },
        rights: "derivative",
        observations: ["publication_allowed:true", "publication_committed:true"],
        registration: {
          media_kind: "video",
          rights_basis: "derivative",
          canonical_audio_sha256: projection.canonical_video_sha256,
          relationship: "references_song",
          parent_asset_id: SONG_POST,
          parent_registration_operation_id: `data-registration:1315:${SONG_POST}:1`,
          expected_parent_license_preset: "commercial-remix",
          expected_parent_commercial_rev_share_bps: 1_500,
        },
        // The video's own launch and its parent's, which had none.
        launches: 2,
        extracted_audio: 0,
      });

      // 6. Stream ingests the master, never the capture.
      const copied: string[] = [];
      const providerVideoId = "0123456789abcdef0123456789abcdef";
      const ingest = await consumeVideoStreamIngest(`video-enrichment:${operationId}:stream`, {
        store: makeVideoStreamIngestStore(layer, { leaseOwner: "composed", leaseMs: 60_000 }),
        transport: {
          copy: async (input) => {
            const object = await masters.read(input.sealedSourceRef);
            if (object === null) throw new Error("Stream was handed a ref with no master");
            if ((await mediaSha256Bytes(object.bytes)) !== input.identity.sourceSha256)
              throw new Error("Stream was handed bytes that are not the identity");
            copied.push(input.identity.sourceSha256);
          },
          observe: async (identity): Promise<readonly VideoStreamObservation[]> => [
            {
              providerVideoId,
              creator: identity.creator,
              sourceSha256: identity.sourceSha256,
              encoding: "ready",
              requireSignedURLs: true,
              downloadsEnabled: false,
            },
          ],
        },
        nowMs: () => Date.now(),
        deadlines: (now) => ({
          acceptanceDeadlineMs: now + 600_000,
          encodingDeadlineMs: now + 3_600_000,
        }),
      });
      expect(ingest).toBe("ready");
      expect(copied).toEqual([projection.canonical_video_sha256]);

      // 7. A reload: fresh connections and stores, reading the post as a
      // viewer, then asking for playback of what it names.
      const reloaded = makeDirectPostgresControlPlaneLayer(connection);
      const reloadedContent = makeControlPlaneContentStore(reloaded);
      const post = await Effect.runPromise(
        Effect.scoped(
          reloadedContent.getPost({ communityId: community, postId, viewerUserId: actor }),
        ),
      );
      expect(post).toMatchObject({
        post: { id: postId, post_type: "video", status: "published" },
        video: {
          track: "video",
          caption: "Dancing to the composed song",
          soundtrack: {
            kind: "song_reference",
            song_reference: {
              song_post_id: SONG_POST,
              song_title: "Composed song",
              song_author_persona_id: songOwnerPersona,
            },
            render_mode: "canonical_replace",
          },
          playback: { status: "ready", provider: "stream", playback_ref: providerVideoId },
          data_registration: "registration_pending",
        },
      });
      const access = await Effect.runPromise(
        getVideoPlaybackAccess(
          { postId, viewerUserId: actor, trustedSource: "composed-test" },
          {
            contentStore: reloadedContent,
            authorizePublication: makeVideoPublicationAuthorization(reloaded),
            resolveApprovedPlayback: makeVideoPlaybackAuthority(reloaded),
            customerHost: "customer-composed123.cloudflarestream.com",
            nowMs: Effect.sync(() => Date.now()),
            limit: () => Effect.succeed({ allowed: true, retryAfterSeconds: 0 }),
            sign: () => Effect.succeed("header.payload.signature"),
          },
        ),
      );
      expect(access.playback_url).toBe(
        "https://customer-composed123.cloudflarestream.com/header.payload.signature/manifest/video.m3u8",
      );
      // The poster is a capture frame inside the interval. It verifies and
      // serves although the published video is the master, not the capture.
      const delivered = await deliver(composed, operationId, postId);
      expect(delivered.thumbnail).toBe("ready");
      expect(delivered.poster.status).toBe(200);
    });
  }, 600_000);

  test("a policy that stops permitting before the decision blocks the video and renders nothing", async () => {
    await inSchema(async (admin, schema, directory) => {
      const composed = await compose(admin, schema, directory);
      const submitted = await submitCapture(composed, "blocked-early");
      // Reservation froze a permitting policy. The owner blocks derivative
      // video before the decision; that permission is not honored.
      await admin.query(
        `SELECT * FROM "${schema}".append_song_owner_policy_revision_v1($1,$2,$3,1,'allowed','allowed','blocked')`,
        [community, SONG_POST, songOwner],
      );
      expect(
        await runVideoAnalysisWorkflow(submitted.effectIdentity, plainStep, composed.workflow),
      ).toEqual({ status: "stopped" });
      expect(
        await getVideoSubmission(
          { submissionId: submitted.submissionId, actor: composed.author },
          composed.services,
        ),
      ).toMatchObject({
        status: "blocked",
        reason_code: "song_reference_invalid",
        song_post_id: SONG_POST,
        song_reason_code: "derivative_video_blocked",
      });
      const facts = await admin.query(
        `SELECT
           (SELECT array_agg(observed_at_transition || ':' || creation_revision || ':' || permitted)
              FROM "${schema}".song_derivative_video_policy_observations WHERE operation_id=$1) AS observations,
           (SELECT count(*)::int FROM "${schema}".media_song_video_render_attempts) AS attempts,
           (SELECT count(*)::int FROM "${schema}".posts WHERE post_type='video') AS videos`,
        [submitted.operationId],
      );
      expect(facts.rows[0]).toEqual({
        observations: ["publication_allowed:1:false"],
        attempts: 0,
        videos: 0,
      });
      expect(
        await composed.masters.read(
          `media://immutable/song-video-masters/song-video-plan:${submitted.submissionId}/g1`,
        ),
      ).toBeNull();
    });
  }, 600_000);

  test("a renderer refusal fails the submission retryably and publishes nothing", async () => {
    await inSchema(async (admin, schema, directory) => {
      const composed = await compose(admin, schema, directory);
      const submitted = await submitCapture(composed, "refused");
      const render = composed.workflow.songRender;
      if (render === undefined) throw new Error("render stage is not composed");
      const workflow: VideoWorkflowServices = {
        ...composed.workflow,
        songRender: {
          ...render,
          renderer: {
            ...render.renderer,
            submit: async () => ({ status: "refused", reason: "master_not_exact" }),
          },
        },
      };
      expect(await runVideoAnalysisWorkflow(submitted.effectIdentity, plainStep, workflow)).toEqual(
        { status: "stopped" },
      );
      expect(
        await getVideoSubmission(
          { submissionId: submitted.submissionId, actor: composed.author },
          composed.services,
        ),
      ).toMatchObject({
        status: "processing_failed",
        reason_code: "transform_failed",
        retryable: true,
      });
      const facts = await admin.query(
        `SELECT
           (SELECT last_safe_phase FROM "${schema}".media_post_submissions WHERE submission_id=$1) AS phase,
           (SELECT failure_evidence_ref FROM "${schema}".media_post_submissions WHERE submission_id=$1) AS evidence,
           (SELECT array_agg(state) FROM "${schema}".media_song_video_render_attempts) AS attempts,
           (SELECT count(*)::int FROM "${schema}".media_song_video_masters) AS masters,
           (SELECT count(*)::int FROM "${schema}".posts WHERE post_type='video') AS videos`,
        [submitted.submissionId],
      );
      // An explicit refusal is final for its attempt: it is abandoned, so a
      // retry starts a new generation rather than re-running this one.
      expect(facts.rows[0]).toMatchObject({
        phase: "render",
        attempts: ["abandoned"],
        masters: 0,
        videos: 0,
      });
      expect(String(facts.rows[0]?.evidence)).toEndWith(":master_not_exact");
    });
  }, 600_000);

  test("a lost render response is observed, not rendered again, and publishes", async () => {
    await inSchema(async (admin, schema, directory) => {
      const composed = await compose(admin, schema, directory);
      const submitted = await submitCapture(composed, "lost-response");
      const render = composed.workflow.songRender;
      if (render === undefined) throw new Error("render stage is not composed");
      // The render runs and writes its output; the response is then lost, and
      // the step is retried as the Worker retries a thrown step.
      const { renderer, calls } = countingRenderer(render.renderer, {
        submit: async (request) => {
          await render.renderer.submit(request);
          throw new Error("render response lost");
        },
      });
      expect(
        await runVideoAnalysisWorkflow(
          submitted.effectIdentity,
          retryingStep,
          withRenderer(composed, renderer),
        ),
      ).toEqual({ status: "published" });
      expect(calls.submit).toBe(1);
      expect(calls.observe).toBe(1);
      // Never acknowledged, so still submitting; its output was sealed anyway.
      expect(await attemptsOf(composed)).toEqual(["accepted:submitting"]);
    });
  }, 600_000);

  test("a lost output-write acknowledgement reconciles from the stored bytes without a second render", async () => {
    await inSchema(async (admin, schema, directory) => {
      const composed = await compose(admin, schema, directory);
      const submitted = await submitCapture(composed, "lost-write");
      const render = composed.workflow.songRender;
      if (render === undefined) throw new Error("render stage is not composed");
      // The host writes the output once; the acknowledgement back to the host
      // is lost, so the renderer's submit throws even though the bytes exist.
      let acknowledgementLost = false;
      const writer = {
        ...composed.masters,
        writeOnce: async (key: string, bytes: Uint8Array, sha: string) => {
          const outcome = await composed.masters.writeOnce(key, bytes, sha);
          if (!acknowledgementLost) {
            acknowledgementLost = true;
            throw new Error("output write response lost");
          }
          return outcome;
        },
      };
      const { renderer, calls } = countingRenderer(
        makeLocalSongVideoRenderer({ engine: composed.songEngine, output: writer }),
      );
      expect(
        await runVideoAnalysisWorkflow(
          submitted.effectIdentity,
          retryingStep,
          withRenderer(composed, renderer),
        ),
      ).toEqual({ status: "published" });
      expect(calls.submit).toBe(1);
      expect(acknowledgementLost).toBe(true);
      // Never acknowledged, so still submitting; the stored bytes were sealed
      // and accepted without rendering again.
      expect(await attemptsOf(composed)).toEqual(["accepted:submitting"]);
    });
  }, 600_000);

  test("an execution with no output stays pending for reconciliation and is never re-run", async () => {
    await inSchema(async (admin, schema, directory) => {
      const composed = await compose(admin, schema, directory);
      const submitted = await submitCapture(composed, "uncertain");
      const render = composed.workflow.songRender;
      if (render === undefined) throw new Error("render stage is not composed");
      // The submission's fate is unknown: no output, no refusal, no answer.
      const { renderer, calls } = countingRenderer(render.renderer, {
        submit: async () => {
          throw new Error("render host did not answer");
        },
      });
      expect(
        await runVideoAnalysisWorkflow(
          submitted.effectIdentity,
          retryingStep,
          withRenderer(composed, renderer),
        ),
      ).toEqual({ status: "reconciliation_required" });
      expect(calls.submit).toBe(1);
      expect(calls.observe).toBe(60);
      expect(await attemptsOf(composed)).toEqual(["started:submitting"]);
      expect(
        await getVideoSubmission(
          { submissionId: submitted.submissionId, actor: composed.author },
          composed.services,
        ),
      ).toMatchObject({
        status: "processing_failed",
        reason_code: "provider_submission_unconfirmed",
        retryable: false,
      });
      // The author cannot start the same work a second time behind it.
      await expect(
        retryVideoSubmission(
          {
            submissionId: submitted.submissionId,
            actor: composed.author,
            body: {
              persona_id: persona,
              idempotency_key: "uncertain-retry",
              expected_creation_revision: 1,
            },
          },
          composed.services,
        ),
      ).rejects.toMatchObject({ details: { reason_code: "retry_not_allowed" } });
    });
  }, 600_000);

  test("a worker stopped after sealing resumes at acceptance without rendering again", async () => {
    await inSchema(async (admin, schema, directory) => {
      const composed = await compose(admin, schema, directory);
      const submitted = await submitCapture(composed, "sealed-resume");
      const render = composed.workflow.songRender;
      if (render === undefined) throw new Error("render stage is not composed");
      const { renderer, calls } = countingRenderer(render.renderer);
      let stopped = false;
      const workflow: VideoWorkflowServices = {
        ...composed.workflow,
        songRender: {
          renderer,
          store: {
            ...render.store,
            // The first time, the master is sealed and the worker stops before
            // acceptance, so the plan has a sealed, unaccepted attempt.
            sealAndAccept: async (request) => {
              if (stopped) return render.store.sealAndAccept(request);
              stopped = true;
              const client = new PgClient({ connectionString: composed.connection });
              await client.connect();
              try {
                const sealed = await verifyAndSealMaster(
                  client,
                  {
                    store: composed.masters,
                    prober: { probe: (bytes) => composed.songEngine.probeMaster(bytes) },
                    soundtrack: composed.songEngine,
                  },
                  {
                    masterRevisionId: `${request.attempt.attemptId}:master`,
                    attempt: {
                      attemptId: request.attempt.attemptId,
                      planId: request.attempt.planId,
                      generation: request.attempt.generation,
                    },
                    sourceImmutableRef: request.sourceImmutableRef,
                    claimedSourceSha256: request.claimedSourceSha256,
                    decisionClipStartSamples: request.clipStartSamples,
                    decisionClipDurationSamples: request.clipDurationSamples,
                  },
                );
                expect(sealed).toMatchObject({ sealed: true });
              } finally {
                await client.end();
              }
              throw new Error("worker stopped after sealing");
            },
          },
        },
      };
      await expect(
        runVideoAnalysisWorkflow(submitted.effectIdentity, plainStep, workflow),
      ).rejects.toThrow("worker stopped after sealing");
      expect(await attemptsOf(composed)).toEqual(["sealed:submitted"]);
      // A new run of the same intent resumes the sealed attempt.
      expect(await runVideoAnalysisWorkflow(submitted.effectIdentity, plainStep, workflow)).toEqual(
        { status: "published" },
      );
      expect(calls.submit).toBe(1);
      expect(await attemptsOf(composed)).toEqual(["accepted:submitted"]);
    });
  }, 600_000);

  test("after an explicit refusal the author's retry renders a new attempt and publishes", async () => {
    await inSchema(async (admin, schema, directory) => {
      const composed = await compose(admin, schema, directory);
      const submitted = await submitCapture(composed, "explicit-retry");
      const render = composed.workflow.songRender;
      if (render === undefined) throw new Error("render stage is not composed");
      const refusing = countingRenderer(render.renderer, {
        submit: async () => ({ status: "refused", reason: "master_not_exact" }),
      });
      expect(
        await runVideoAnalysisWorkflow(
          submitted.effectIdentity,
          plainStep,
          withRenderer(composed, refusing.renderer),
        ),
      ).toEqual({ status: "stopped" });
      expect(await attemptsOf(composed)).toEqual(["abandoned:submitting"]);
      const retried = await retryVideoSubmission(
        {
          submissionId: submitted.submissionId,
          actor: composed.author,
          body: {
            persona_id: persona,
            idempotency_key: "explicit-retry-1",
            expected_creation_revision: 1,
          },
        },
        composed.services,
      );
      expect(retried).toMatchObject({ status: "processing", creation_revision: 2 });
      // The retry is a new creation revision: analysed again, decided again
      // against the owner policy as it is now, and rendered by a new attempt.
      const rendering = countingRenderer(render.renderer);
      expect(
        await runVideoAnalysisWorkflow(
          `video-analysis:${submitted.operationId}:v1:c2`,
          plainStep,
          withRenderer(composed, rendering.renderer),
        ),
      ).toEqual({ status: "published" });
      expect(refusing.calls.submit).toBe(1);
      expect(rendering.calls.submit).toBe(1);
      expect(await attemptsOf(composed)).toEqual(["abandoned:submitting", "accepted:submitted"]);
      const decisions = await admin.query(
        `SELECT array_agg(creation_revision || ':' || outcome ORDER BY creation_revision) AS decisions
           FROM "${schema}".media_video_publication_decisions WHERE submission_id=$1`,
        [submitted.submissionId],
      );
      expect(decisions.rows[0]?.decisions).toEqual(["1:publish", "2:publish"]);
    });
  }, 600_000);

  test("a song made adult-only while its master renders publishes the video adult-only", async () => {
    await inSchema(async (admin, schema, directory) => {
      const composed = await compose(admin, schema, directory);
      const submitted = await submitCapture(composed, "rating-floor");
      const step: VideoWorkflowStep = {
        ...plainStep,
        do: async (name, run) => {
          if (name === "render-publish") {
            // Whatever made the song adult-only did so after the decision.
            await admin.query("SET session_replication_role = replica");
            await admin.query(
              `UPDATE "${schema}".posts SET content_rating='adult_18' WHERE post_id=$1`,
              [SONG_POST],
            );
            await admin.query("SET session_replication_role = origin");
          }
          return run();
        },
      };
      expect(
        await runVideoAnalysisWorkflow(submitted.effectIdentity, step, composed.workflow),
      ).toEqual({ status: "published" });
      const ratings = await admin.query(
        `SELECT
           (SELECT d.effective_content_rating FROM "${schema}".media_video_publication_decisions d
             WHERE d.submission_id=$1) AS decided,
           (SELECT p.content_rating FROM "${schema}".posts p
             JOIN "${schema}".media_video_song_references e ON e.post_id=p.post_id
             WHERE e.submission_id=$1) AS published`,
        [submitted.submissionId],
      );
      // Decided general before the change; published at the song's floor.
      expect(ratings.rows[0]).toEqual({ decided: "general", published: "adult_18" });
    });
  }, 600_000);

  test("a publication retry after lost membership publishes on its decision, then plays and serves its poster", async () => {
    await inSchema(async (admin, schema, directory) => {
      const composed = await compose(admin, schema, directory);
      const submitted = await submitCapture(composed, "membership-retry");
      // Membership lapses after rendering, before the commit.
      const step: VideoWorkflowStep = {
        ...plainStep,
        do: async (name, run) => {
          if (name === "render-publish") await loseMembership(composed);
          return run();
        },
      };
      expect(
        await runVideoAnalysisWorkflow(submitted.effectIdentity, step, composed.workflow),
      ).toEqual({ status: "stopped" });
      expect(
        await getVideoSubmission(
          { submissionId: submitted.submissionId, actor: composed.author },
          composed.services,
        ),
      ).toMatchObject({ status: "processing_failed", reason_code: "membership_required" });
      await rejoin(composed);
      expect(
        await retryVideoSubmission(
          {
            submissionId: submitted.submissionId,
            actor: composed.author,
            body: {
              persona_id: persona,
              idempotency_key: "membership-retry-1",
              expected_creation_revision: 1,
            },
          },
          composed.services,
        ),
      ).toMatchObject({ status: "processing", phase: "publish", creation_revision: 2 });
      expect(
        await runVideoAnalysisWorkflow(
          `video-analysis:${submitted.operationId}:v1:c2`,
          plainStep,
          composed.workflow,
        ),
      ).toEqual({ status: "published" });
      const published = await getVideoSubmission(
        { submissionId: submitted.submissionId, actor: composed.author },
        composed.services,
      );
      if (published.status !== "published") throw new Error("retry did not publish");
      const postId = published.published_resource.post_id;
      const facts = await admin.query(
        `SELECT
           (SELECT row_to_json(p) FROM (SELECT creation_revision::int AS created,
               decision_revision::int AS decided FROM "${schema}".media_publication_projections
             WHERE post_id=$1) p) AS anchor,
           (SELECT array_agg(observed_at_transition || ':' || creation_revision || ':' || permitted
                             ORDER BY creation_revision, observed_at_transition)
              FROM "${schema}".song_derivative_video_policy_observations WHERE operation_id=$2) AS observations,
           (SELECT count(*)::int FROM "${schema}".media_song_video_render_attempts) AS attempts`,
        [postId, submitted.operationId],
      );
      // One render, one decision; the owner policy observed again for the
      // retried revision at publication_allowed and at commit.
      expect(facts.rows[0]).toEqual({
        anchor: { created: 2, decided: 1 },
        observations: [
          "publication_allowed:1:true",
          "publication_allowed:2:true",
          "publication_committed:2:true",
        ],
        attempts: 1,
      });
      const delivered = await deliver(composed, submitted.operationId, postId);
      expect(delivered.ingest).toBe("ready");
      expect(delivered.thumbnail).toBe("ready");
      expect(delivered.playbackUrl).toContain("/header.payload.signature/manifest/video.m3u8");
      expect(delivered.poster.status).toBe(200);
      expect(delivered.copied).toHaveLength(1);
    });
  }, 600_000);

  test("an owner revocation before a publication retry blocks it at the retried revision", async () => {
    await inSchema(async (admin, schema, directory) => {
      const composed = await compose(admin, schema, directory);
      const submitted = await submitCapture(composed, "revoked-retry");
      const step: VideoWorkflowStep = {
        ...plainStep,
        do: async (name, run) => {
          if (name === "render-publish") await loseMembership(composed);
          return run();
        },
      };
      expect(
        await runVideoAnalysisWorkflow(submitted.effectIdentity, step, composed.workflow),
      ).toEqual({ status: "stopped" });
      // While the author is away, the owner blocks derivative video.
      await admin.query(
        `SELECT * FROM "${schema}".append_song_owner_policy_revision_v1($1,$2,$3,1,'allowed','allowed','blocked')`,
        [community, SONG_POST, songOwner],
      );
      await rejoin(composed);
      await retryVideoSubmission(
        {
          submissionId: submitted.submissionId,
          actor: composed.author,
          body: {
            persona_id: persona,
            idempotency_key: "revoked-retry-1",
            expected_creation_revision: 1,
          },
        },
        composed.services,
      );
      expect(
        await runVideoAnalysisWorkflow(
          `video-analysis:${submitted.operationId}:v1:c2`,
          plainStep,
          composed.workflow,
        ),
      ).toEqual({ status: "stopped" });
      expect(
        await getVideoSubmission(
          { submissionId: submitted.submissionId, actor: composed.author },
          composed.services,
        ),
      ).toMatchObject({
        status: "blocked",
        creation_revision: 2,
        reason_code: "song_reference_invalid",
        song_reason_code: "derivative_video_blocked",
      });
      const facts = await admin.query(
        `SELECT
           (SELECT array_agg(observed_at_transition || ':' || creation_revision || ':' || permitted
                             ORDER BY creation_revision, observed_at_transition)
              FROM "${schema}".song_derivative_video_policy_observations WHERE operation_id=$1) AS observations,
           (SELECT array_agg(creation_revision || ':' || outcome ORDER BY creation_revision)
              FROM "${schema}".media_video_publication_decisions WHERE submission_id=$2) AS decisions,
           (SELECT count(*)::int FROM "${schema}".posts WHERE post_type='video') AS videos,
           (SELECT count(*)::int FROM "${schema}".media_song_video_accepted_masters) AS accepted`,
        [submitted.operationId, submitted.submissionId],
      );
      expect(facts.rows[0]).toEqual({
        observations: ["publication_allowed:1:true", "publication_allowed:2:false"],
        decisions: ["1:publish", "2:block"],
        videos: 0,
        accepted: 1,
      });
    });
  }, 600_000);

  test("a policy that stops permitting after rendering is refused at commit and re-decided", async () => {
    await inSchema(async (admin, schema, directory) => {
      const composed = await compose(admin, schema, directory);
      const submitted = await submitCapture(composed, "blocked-late");
      // The owner blocks derivative video after the decision permitted it and
      // the master was accepted, immediately before the publication commit.
      const step: VideoWorkflowStep = {
        ...plainStep,
        do: async (name, run) => {
          if (name === "render-publish")
            await admin.query(
              `SELECT * FROM "${schema}".append_song_owner_policy_revision_v1($1,$2,$3,1,'allowed','allowed','blocked')`,
              [community, SONG_POST, songOwner],
            );
          return run();
        },
      };
      expect(
        await runVideoAnalysisWorkflow(submitted.effectIdentity, step, composed.workflow),
      ).toEqual({ status: "stopped" });
      expect(
        await getVideoSubmission(
          { submissionId: submitted.submissionId, actor: composed.author },
          composed.services,
        ),
      ).toMatchObject({
        status: "blocked",
        creation_revision: 2,
        reason_code: "song_reference_invalid",
        song_reason_code: "derivative_video_blocked",
      });
      const facts = await admin.query(
        `SELECT
           (SELECT array_agg(observed_at_transition || ':' || creation_revision || ':' || permitted
                             ORDER BY creation_revision, observed_at_transition)
              FROM "${schema}".song_derivative_video_policy_observations WHERE operation_id=$1) AS observations,
           (SELECT array_agg(creation_revision || ':' || outcome ORDER BY creation_revision)
              FROM "${schema}".media_video_publication_decisions WHERE submission_id=$2) AS decisions,
           (SELECT count(*)::int FROM "${schema}".media_song_video_accepted_masters) AS accepted,
           (SELECT count(*)::int FROM "${schema}".posts WHERE post_type='video') AS videos,
           (SELECT count(*)::int FROM "${schema}".media_video_song_references) AS edges,
           (SELECT count(*)::int FROM "${schema}".data_registration_operations) AS registrations`,
        [submitted.operationId, submitted.submissionId],
      );
      // Nothing published. The master stays accepted for its disposition and
      // is never published under the refused policy.
      expect(facts.rows[0]).toEqual({
        observations: [
          "publication_allowed:1:true",
          "publication_committed:1:false",
          "publication_allowed:2:false",
        ],
        decisions: ["1:publish", "2:block"],
        accepted: 1,
        videos: 0,
        edges: 0,
        registrations: 0,
      });
    });
  }, 600_000);
});
