import type {
  SongVideoRenderer,
  SongVideoRenderRequest,
  SongVideoRenderStore,
} from "@pirate/application/video/song-render";
import { Client } from "pg";
import { makeSongVideoRenderStore } from "../packages/platform-cf/src/song-video-render-store.ts";
import { makeLocalPinnedFfmpegSongVideoEngine } from "./song-video-ffmpeg.ts";
import { makeLocalSongVideoRenderer } from "./song-video-local-render.ts";
import {
  makeHostMasterOutputStore,
  makeHostMasterOutputWriter,
  makeHostMediaReader,
  makeHostR2Transport,
} from "./song-video-render-host-r2.ts";

/**
 * One operator-supervised render on the selected FFmpeg host (U.2).
 *
 * The host takes a dispatch that already exists: one attempt in
 * `media_song_video_render_attempts` at `started`/`submitting`, with its plan,
 * source and interval loaded from the same rows the workflow froze. It runs
 * one job at a time, writes the attempt's assigned output address once, records
 * what it measured before writing, and seals the accepted master through the
 * existing render store. An execution that cannot be concluded is reported
 * uncertain and left pending; nothing here retries it or launches a second
 * render.
 *
 * This is the staging executor only. It is not wired into the Worker or any
 * deployment, and running it is a separately authorized operation.
 */

export type HostRenderFacts = Readonly<{
  planId: string;
  attemptId: string;
  generation: number;
  outputObjectKey: string;
  source: Readonly<{ immutableRef: string; sha256: string; byteLength: number }>;
  song: Readonly<{ assetRef: string; sha256: string; durationSamples: number }>;
  clipStartSamples: number;
  clipDurationSamples: number;
}>;

export type HostRenderOutcome =
  | Readonly<{ status: "accepted"; masterRevisionId: string }>
  | Readonly<{ status: "refused"; reason: string }>
  | Readonly<{ status: "pending" }>;

export function planHostRenderRequest(facts: HostRenderFacts): SongVideoRenderRequest {
  return {
    outputObjectKey: facts.outputObjectKey,
    source: facts.source,
    song: facts.song,
    clipStartSamples: facts.clipStartSamples,
    clipDurationSamples: facts.clipDurationSamples,
  };
}

const ATTEMPT_QUERY = `SELECT a.attempt_id,a.generation,a.dispatch_output_key,
  p.plan_id,p.song_asset_id,rp.canonical_audio_sha256,p.song_duration_samples::text,
  p.clip_start_samples::text,p.clip_duration_samples::text,
  v.immutable_ref,v.canonical_sha256,v.size_bytes::text
  FROM media_song_video_render_attempts a
  JOIN media_song_video_render_plans p ON p.plan_id=a.plan_id
  JOIN media_post_submissions s ON s.submission_id=p.submission_id
  JOIN media_video_reservation_song_plans rp ON rp.reservation_id=s.audio_reservation_id
  JOIN media_video_revisions v ON v.submission_id=s.submission_id
    AND v.operation_id=s.operation_id
    AND v.video_revision=(s.video_state_snapshot->>'videoRevision')::bigint
 WHERE a.plan_id=$1 AND a.state='started' AND a.execution_phase='submitting'
   AND a.expected_output_sha256 IS NULL AND a.execution_refusal_reason IS NULL
   AND ($2::text IS NULL OR a.attempt_id=$2)`;

type AttemptRow = Readonly<{
  attempt_id: string;
  generation: number;
  dispatch_output_key: string;
  plan_id: string;
  song_asset_id: string;
  canonical_audio_sha256: string;
  song_duration_samples: string;
  clip_start_samples: string;
  clip_duration_samples: string;
  immutable_ref: string;
  canonical_sha256: string;
  size_bytes: string;
}>;

export async function loadHostRenderFacts(
  client: Client,
  planId: string,
  attemptId?: string,
): Promise<HostRenderFacts | null> {
  const result = await client.query<AttemptRow>(ATTEMPT_QUERY, [planId, attemptId ?? null]);
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    planId: row.plan_id,
    attemptId: row.attempt_id,
    generation: row.generation,
    outputObjectKey: row.dispatch_output_key,
    source: {
      immutableRef: row.immutable_ref,
      sha256: row.canonical_sha256,
      byteLength: Number(row.size_bytes),
    },
    song: {
      assetRef: row.song_asset_id,
      sha256: row.canonical_audio_sha256,
      durationSamples: Number(row.song_duration_samples),
    },
    clipStartSamples: Number(row.clip_start_samples),
    clipDurationSamples: Number(row.clip_duration_samples),
  };
}

export async function executeHostRenderAttempt(
  input: Readonly<{
    facts: HostRenderFacts;
    renderer: SongVideoRenderer;
    store: SongVideoRenderStore;
  }>,
): Promise<HostRenderOutcome> {
  let submitted: Awaited<ReturnType<SongVideoRenderer["submit"]>>;
  try {
    submitted = await input.renderer.submit(planHostRenderRequest(input.facts));
  } catch {
    // The execution may have begun and may have written; the attempt stays
    // submitting and is never rendered again from here.
    return { status: "pending" };
  }
  if (submitted.status === "refused") return { status: "refused", reason: submitted.reason };
  const observed = await input.renderer.observe({
    outputObjectKey: input.facts.outputObjectKey,
  });
  if (observed.status !== "completed") return { status: "pending" };
  const sealed = await input.store.sealAndAccept({
    attempt: {
      attemptId: input.facts.attemptId,
      planId: input.facts.planId,
      generation: input.facts.generation,
      outputObjectKey: input.facts.outputObjectKey,
      phase: "submitting",
      executionStartedAtMs: null,
    },
    sourceImmutableRef: input.facts.source.immutableRef,
    claimedSourceSha256: input.facts.source.sha256,
    clipStartSamples: input.facts.clipStartSamples,
    clipDurationSamples: input.facts.clipDurationSamples,
  });
  return sealed.status === "accepted"
    ? { status: "accepted", masterRevisionId: sealed.master.masterRevisionId }
    : { status: "refused", reason: sealed.reason };
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const planId = required("SONG_VIDEO_RENDER_PLAN_ID");
  const attemptId = process.env.SONG_VIDEO_RENDER_ATTEMPT_ID?.trim() || undefined;
  const databaseUrl = required("SONG_VIDEO_RENDER_DATABASE_URL");
  const bucket = required("SONG_VIDEO_RENDER_R2_BUCKET");
  const transport = makeHostR2Transport({
    accountId: required("SONG_VIDEO_RENDER_R2_ACCOUNT_ID"),
    credentials: {
      accessKeyId: required("SONG_VIDEO_RENDER_R2_ACCESS_KEY_ID"),
      secretAccessKey: required("SONG_VIDEO_RENDER_R2_SECRET_ACCESS_KEY"),
    },
  });
  const output = makeHostMasterOutputStore({ transport, bucket });
  const writer = makeHostMasterOutputWriter({ transport, bucket });
  const mediaReader = makeHostMediaReader({ transport, bucket });
  const engine = makeLocalPinnedFfmpegSongVideoEngine({
    mediaReader,
    ...(process.env.SONG_VIDEO_FFMPEG_BINARY === undefined
      ? {}
      : { ffmpegBinary: process.env.SONG_VIDEO_FFMPEG_BINARY }),
    ...(process.env.SONG_VIDEO_FFPROBE_BINARY === undefined
      ? {}
      : { ffprobeBinary: process.env.SONG_VIDEO_FFPROBE_BINARY }),
  });
  const store = makeSongVideoRenderStore({
    connect: async () => {
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      return client;
    },
    output,
    prober: { probe: (bytes) => engine.probeMaster(bytes) },
    soundtrack: engine,
  });
  const renderer = makeLocalSongVideoRenderer({
    engine,
    output: { ...writer, read: (objectKey) => output.read(objectKey) },
    evidence: store,
  });

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  let facts: HostRenderFacts | null;
  try {
    facts = await loadHostRenderFacts(client, planId, attemptId);
  } finally {
    await client.end();
  }
  if (facts === null) throw new Error("no dispatched song-video render attempt matches");
  const outcome = await executeHostRenderAttempt({ facts, renderer, store });
  process.stdout.write(
    `${JSON.stringify({ plan_id: planId, attempt_id: facts.attemptId, ...outcome })}\n`,
  );
  // A pending execution stays visible for reconciliation; it is not a retry.
  if (outcome.status === "pending") process.exitCode = 2;
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "render host failed"}\n`);
    process.exitCode = 1;
  });
}
