/**
 * Operator driver for the branch render-host qualification (revision 3 with
 * its adoption terms). Each subcommand is one step; the operator snapshots and
 * diffs tables between steps with the evidence-folder tools. Every write goes
 * through maintained code: the interval store for the timing request, the
 * publication store for reservation through sealed finalize, and the render
 * store for dispatch and begin-execution, exactly as the Worker performs them.
 *
 * Lane-only material on ops/video-staging-infrastructure-qualification; not for
 * merge. Connection strings come from the environment and are never printed.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { createSongReferenceVideoSubmission } from "../packages/domain/src/video-submission.ts";
import { makeDirectPostgresControlPlaneLayer } from "../packages/platform-cf/src/postgres.ts";
import { makeControlPlaneSongVideoIntervalStore } from "../packages/platform-cf/src/song-video-interval-repository.ts";
import { makeSongVideoRenderStore } from "../packages/platform-cf/src/song-video-render-store.ts";
import { makeControlPlaneVideoPublicationStore } from "../packages/platform-cf/src/video-publication-repository.ts";
import {
  WORKER_SONG_VIDEO_RENDERER_IDENTITY,
  WORKER_SONG_VIDEO_RENDERER_POLICY_REVISION,
} from "../packages/platform-cf/src/song-video-worker-render.ts";
import { makeHostR2Transport } from "../scripts/song-video-render-host-r2.ts";

export const QUALIFICATION = {
  reservationId: "media-reservation-00000000-0000-4000-8000-000000009211",
  submissionId: "media-submission-video-qualification-20260921-01",
  operationId: "media-operation-video-qualification-20260921-01",
  planId: "song-video-plan:qualification-20260921-01",
} as const;
export const SOURCE_REF = `media://immutable/${QUALIFICATION.operationId}/video/1`;
export const SOURCE_KEY = `immutable/${QUALIFICATION.operationId}/video/1`;

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const out = (value: unknown) => console.log(JSON.stringify(value, null, 1));
const arg = (name: string) => {
  const index = process.argv.indexOf(`--${name}`);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`--${name} is required`);
  return value;
};
const count = (name: string) => {
  const value = Number(arg(name));
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`--${name} is invalid`);
  return value;
};
const databaseUrl = () => {
  const raw = process.env.QUAL_DATABASE_URL;
  if (!raw) throw new Error("QUAL_DATABASE_URL is required");
  return raw;
};
const connect = async () => {
  const url = new URL(databaseUrl());
  const remote = url.hostname.endsWith("psdb.cloud");
  url.searchParams.delete("sslrootcert");
  const client = new Client({
    connectionString: url.toString(),
    ...(remote ? { ssl: { rejectUnauthorized: true } } : {}),
  });
  await client.connect();
  return client;
};
const layer = () => makeDirectPostgresControlPlaneLayer(databaseUrl());

async function requestTiming() {
  const intervals = makeControlPlaneSongVideoIntervalStore(layer());
  const song = await intervals.getPublishedSong(arg("song-post"));
  if (song === null) throw new Error("song is not a public published song");
  out({ step: "timing-request", song, timing: await intervals.getOrRequestTiming(song) });
}

async function eligibility() {
  const client = await connect();
  try {
    const rows = (
      await client.query(
        `SELECT song_post_id,audio_revision::int,state FROM media_song_canonical_timings
          ORDER BY song_post_id,audio_revision`,
      )
    ).rows;
    const eligible =
      rows.length === 1 &&
      rows[0].song_post_id === arg("song-post") &&
      rows[0].audio_revision === count("audio-revision") &&
      rows[0].state === "pending";
    out({ step: "eligibility", rows, eligible });
    if (!eligible) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

async function verifyTiming() {
  const client = await connect();
  try {
    const row = (
      await client.query(
        `SELECT state,canonical_audio_sha256,sample_rate_hz,duration_samples::text,
                prober_identity,prober_policy_revision,attempts,lease_expires_at
           FROM media_song_canonical_timings WHERE song_post_id=$1 AND audio_revision=$2`,
        [arg("song-post"), count("audio-revision")],
      )
    ).rows[0];
    const ok =
      row !== undefined &&
      row.state === "ready" &&
      row.canonical_audio_sha256 === arg("expect-sha256") &&
      row.sample_rate_hz === 48_000 &&
      Number(row.duration_samples) >= count("min-samples") &&
      row.prober_identity === arg("expect-prober") &&
      row.lease_expires_at === null;
    out({ step: "verify-timing", row: row ?? null, ok });
    if (!ok) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

function transport() {
  const key = process.env.QUAL_R2_ACCESS_KEY_ID;
  const secret = process.env.QUAL_R2_SECRET_ACCESS_KEY;
  if (!key || !secret) throw new Error("QUAL_R2_ACCESS_KEY_ID and QUAL_R2_SECRET_ACCESS_KEY are required");
  return makeHostR2Transport({
    accountId: arg("account"),
    credentials: { accessKeyId: key, secretAccessKey: secret },
    ...(process.env.QUAL_R2_ENDPOINT ? { endpoint: process.env.QUAL_R2_ENDPOINT } : {}),
  });
}

async function uploadSource() {
  const bytes = new Uint8Array(await readFile(arg("file")));
  const bucket = arg("bucket");
  const put = await transport().send({
    bucket,
    key: SOURCE_KEY,
    method: "PUT",
    headers: {
      "content-type": "video/mp4",
      "content-length": String(bytes.byteLength),
      // Never replace an existing object at the qualification key.
      "if-none-match": "*",
    },
    body: bytes,
  });
  await put.arrayBuffer().catch(() => undefined);
  const head = await transport().send({ bucket, key: SOURCE_KEY, method: "HEAD" });
  const etag = (head.headers.get("etag") ?? "").replace(/^"|"$/gu, "");
  const ok = put.status === 200 && head.status === 200 && etag.length > 0;
  out({
    step: "upload-source",
    key: SOURCE_KEY,
    put_status: put.status,
    head_status: head.status,
    etag,
    size_bytes: bytes.byteLength,
    sha256: sha256(bytes),
    ok,
  });
  if (!ok) process.exitCode = 1;
}

type SongRow = Readonly<{
  post_id: string;
  community_id: string;
  author_user_id: string;
  author_persona_id: string;
  audio_revision: string;
  canonical_audio_sha256: string;
  audio_asset_ref: string;
  duration_samples: string;
  current_policy_revision: string;
  current_policy_hash: string;
  derivative_video: string;
}>;

async function createFixture() {
  const client = await connect();
  let song: SongRow | undefined;
  try {
    song = (
      await client.query<SongRow>(
        `SELECT p.post_id,p.community_id,p.author_user_id,p.author_persona_id,
                m.audio_revision::text,m.canonical_audio_sha256,m.audio_asset_ref,
                t.duration_samples::text,o.current_policy_revision::text,o.current_policy_hash,
                r.derivative_video
           FROM posts p
           JOIN media_publication_projections m ON m.post_id=p.post_id AND m.media_kind='song'
           JOIN media_song_canonical_timings t ON t.song_post_id=p.post_id AND t.audio_revision=m.audio_revision
           JOIN song_owner_policies o ON o.post_id=p.post_id AND o.audio_revision=m.audio_revision
           JOIN song_owner_policy_revisions r ON r.community_id=o.community_id AND r.post_id=o.post_id
            AND r.audio_revision=o.audio_revision AND r.policy_revision=o.current_policy_revision
          WHERE p.post_id=$1 AND t.state='ready'`,
        [arg("song-post")],
      )
    ).rows[0];
  } finally {
    await client.end();
  }
  if (song === undefined) throw new Error("song is not ready for a frozen plan");
  const source = new Uint8Array(await readFile(arg("file")));
  const sourceSha = sha256(source);
  const etag = arg("etag");
  const clipStartSamples = count("clip-start");
  const clipDurationSamples = count("clip-duration");
  const { reservationId, submissionId, operationId, planId } = QUALIFICATION;
  const store = makeControlPlaneVideoPublicationStore(layer());
  const reservationResponse = new TextEncoder().encode(`{"reservation_id":"${reservationId}"}`);
  const expiresAt = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
  const frozen = {
    songPostId: song.post_id,
    audioRevision: Number(song.audio_revision),
    canonicalAudioSha256: song.canonical_audio_sha256,
    songDurationSamples: Number(song.duration_samples),
    songAssetId: song.audio_asset_ref,
    clipStartSamples,
    clipDurationSamples,
    intervalPolicyRevision: 1,
    ownerPolicyRevision: Number(song.current_policy_revision),
    ownerPolicyHash: song.current_policy_hash,
    derivativeVideo: song.derivative_video as "allowed" | "owner_only",
    selectedFrom: { kind: "library" as const },
    originVerified: false,
    observedAt: new Date().toISOString(),
  };
  await store.createReservation({
    record: {
      reservationId,
      communityId: song.community_id,
      intent: "song_reference",
      actorAccountId: song.author_user_id,
      authorPersonaId: song.author_persona_id,
      requestHash: sha256(new TextEncoder().encode(`qualification-reserve:${reservationId}`)),
      expectedContentType: "video/mp4",
      expectedSizeBytes: source.byteLength,
      expectedSha256: sourceSha,
      ingestPolicyRevision: 1,
      uploadId: `qualification-${reservationId}`,
      partSizeBytes: 10 * 1024 * 1024,
      partCount: 1,
      expiresAt,
      state: "issued",
      submissionId: null,
      operationId: null,
      manifest: null,
      responseBytes: reservationResponse,
      updatedAt: new Date().toISOString(),
    },
    idempotencyKey: `qualification-reserve-${reservationId}`,
    responseSha256: sha256(reservationResponse),
    parts: [{ partNumber: 1, url: "https://upload.invalid/qualification", expiresAt }],
    songPlan: frozen,
  });
  const initial = createSongReferenceVideoSubmission({
    submissionId,
    operationId,
    communityId: song.community_id,
    actorAccountId: song.author_user_id,
    authorPersonaId: song.author_persona_id,
    reservationId,
    caption: null,
    authorDeclaredRating: "general",
    songPlan: {
      planId,
      songPostId: frozen.songPostId,
      songAssetId: frozen.songAssetId,
      audioRevision: frozen.audioRevision,
      canonicalAudioSha256: frozen.canonicalAudioSha256,
      songDurationSamples: frozen.songDurationSamples,
      clipStartSamples,
      clipDurationSamples,
    },
  });
  const responseBytes = new TextEncoder().encode(`{"submission_id":"${submissionId}"}`);
  const responseSha256 = sha256(responseBytes);
  await store.createSubmission({
    state: initial,
    idempotencyKey: `qualification-create-${submissionId}`,
    requestHash: sha256(new TextEncoder().encode(`qualification-create:${submissionId}`)),
    startInput: { version: "video-start-input-v1", video_reservation_id: reservationId },
    responseBytes,
    responseSha256,
  });
  const manifest = [{ partNumber: 1, etag: `qualification-part-${submissionId}` }];
  await store.beginFinalize({ submission: initial, expectedCreationRevision: 1, posterTimestampMs: 1_000, manifest });
  await store.recordMultipartCompleted({ submission: initial, manifest });
  await store.finalizeSealed({
    submission: initial,
    expectedCreationRevision: 1,
    immutable: {
      immutableRef: SOURCE_REF,
      destinationRef: `r2://${SOURCE_KEY}`,
      etag,
      objectVersion: etag,
      sizeBytes: source.byteLength,
      contentType: "video/mp4",
      canonicalSha256: sourceSha,
    },
    responseBytes,
    responseSha256,
    endpointTemplate: "/media-post-submissions/:submissionId/finalize",
    idempotencyKey: `qualification-finalize-${submissionId}`,
    requestHash: sha256(new TextEncoder().encode(`qualification-finalize:${submissionId}`)),
  });
  const finalized = await store.getSubmissionByOperation({ submissionId, operationId });
  if (finalized?.state.phase !== "analysis") throw new Error("fixture did not reach analysis");
  // Dispatch and begin execution exactly as the Worker's render stage does.
  const unused = () => {
    throw new Error("the fixture never verifies output");
  };
  const renderStore = makeSongVideoRenderStore({
    connect,
    output: { read: unused, readVersion: unused },
    prober: { probe: unused },
    soundtrack: { verifySoundtrack: unused } as never,
  });
  const attempt = await renderStore.dispatch({
    planId,
    rendererIdentity: WORKER_SONG_VIDEO_RENDERER_IDENTITY,
    rendererPolicyRevision: WORKER_SONG_VIDEO_RENDERER_POLICY_REVISION,
  });
  const began = await renderStore.beginExecution(attempt);
  out({
    step: "create-fixture",
    song: { post_id: song.post_id, community_id: song.community_id, audio_revision: frozen.audioRevision },
    source: { ref: SOURCE_REF, sha256: sourceSha, size_bytes: source.byteLength, etag },
    clip: { start_samples: clipStartSamples, duration_samples: clipDurationSamples },
    attempt,
    began,
  });
  if (!began) process.exitCode = 1;
}

const commands: Record<string, () => Promise<void>> = {
  "request-timing": requestTiming,
  eligibility,
  "verify-timing": verifyTiming,
  "upload-source": uploadSource,
  "create-fixture": createFixture,
};
const command = commands[process.argv[2] ?? ""];
if (command === undefined) {
  console.error(`usage: render-qualification.ts <${Object.keys(commands).join("|")}> [options]`);
  process.exitCode = 2;
} else {
  await command().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message.slice(0, 300) : "failed");
    process.exitCode = 1;
  });
}
