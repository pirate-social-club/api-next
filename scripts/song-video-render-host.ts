import { measurePendingSongTimings } from "@pirate/application/video/song-canonical-timing";
import type {
  SongVideoRenderer,
  SongVideoRenderRequest,
  SongVideoRenderStore,
} from "@pirate/application/video/song-render";
import { Client } from "pg";
import { makeDirectPostgresControlPlaneLayer } from "../packages/platform-cf/src/postgres.ts";
import { makeControlPlaneSongVideoIntervalStore } from "../packages/platform-cf/src/song-video-interval-repository.ts";
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
 * The operator-supervised FFmpeg host on the selected execution path (U.2).
 *
 * Run as a supervised loop, it first measures songs waiting for an
 * authoritative duration, then claims one waiting render attempt at a time:
 * the claim is a compare-and-set on the attempt row, so two hosts or a
 * restarted host cannot both execute the same attempt, and exactly one row is
 * taken per pass. It loads the plan, sealed source and frozen interval from the
 * same rows the workflow froze, renders with the pinned engine, writes the
 * attempt's assigned output address once, records what it measured before
 * writing, and seals the accepted master through the existing render store. An
 * execution that cannot be concluded is reported uncertain and left pending;
 * nothing here retries it or launches a second render.
 *
 * A named plan remains accepted for one targeted pass. This is the staging
 * executor only. Running it is a separately authorized operation.
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

export type HostRenderClaim = Readonly<{ claimId: string; facts: HostRenderFacts }>;

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

const CLAIM = `UPDATE media_song_video_render_attempts a
    SET execution_claim_id=$1, execution_claimed_at=clock_timestamp()
  WHERE a.attempt_id = (
    SELECT b.attempt_id FROM media_song_video_render_attempts b
     WHERE b.state='started' AND b.execution_phase IN ('submitting','submitted')
       AND b.expected_output_sha256 IS NULL AND b.execution_refusal_reason IS NULL
       AND b.execution_claim_id IS NULL
       AND ($2::text IS NULL OR b.plan_id=$2)
       AND ($3::text IS NULL OR b.attempt_id=$3)
     ORDER BY b.execution_started_at NULLS FIRST, b.plan_id, b.generation
     LIMIT 1
     FOR UPDATE SKIP LOCKED
  )
  RETURNING a.attempt_id`;

const FACTS = `SELECT a.attempt_id,a.generation,a.dispatch_output_key,
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
 WHERE a.attempt_id=$1`;

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

function factsFromRow(row: AttemptRow): HostRenderFacts {
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

/**
 * Claims one dispatchable attempt for this host and returns its frozen work.
 * The claim and the read happen in one transaction: the winner is the only
 * caller that can receive the attempt, and a loser gets null. Without a plan id
 * it takes the oldest waiting attempt, exactly one row, skipping any row
 * another host holds.
 */
export async function claimHostRenderAttempt(
  client: Client,
  input: Readonly<{
    planId?: string | undefined;
    attemptId?: string | undefined;
    claimId: string;
  }>,
): Promise<HostRenderClaim | null> {
  await client.query("BEGIN");
  try {
    const claimed = await client.query<{ attempt_id: string }>(CLAIM, [
      input.claimId,
      input.planId ?? null,
      input.attemptId ?? null,
    ]);
    const attemptId = claimed.rows[0]?.attempt_id;
    if (attemptId === undefined) {
      await client.query("ROLLBACK");
      return null;
    }
    const result = await client.query<AttemptRow>(FACTS, [attemptId]);
    const row = result.rows[0];
    if (row === undefined) throw new Error("claimed song-video attempt facts are missing");
    await client.query("COMMIT");
    return { claimId: input.claimId, facts: factsFromRow(row) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
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
    // claimed and pending, and is never rendered again from here.
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

/** Bounds a poll interval so a typo cannot busy-spin or sleep for hours. */
function pollIntervalMs(): number {
  const raw = process.env.SONG_VIDEO_RENDER_POLL_MS?.trim();
  if (raw === undefined || raw.length === 0) return 15_000;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1_000 || parsed > 600_000)
    throw new Error("SONG_VIDEO_RENDER_POLL_MS is invalid");
  return parsed;
}

/** Stops between passes on SIGINT/SIGTERM rather than mid-render. */
function stopSignals(): Readonly<{
  stopped: boolean;
  sleep: (milliseconds: number) => Promise<void>;
}> {
  let stopped = false;
  let wake: (() => void) | undefined;
  const onSignal = (): void => {
    stopped = true;
    wake?.();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  return {
    get stopped() {
      return stopped;
    },
    sleep: (milliseconds) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, milliseconds);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      }),
  };
}

async function main(): Promise<void> {
  const planId = process.env.SONG_VIDEO_RENDER_PLAN_ID?.trim() || undefined;
  const attemptId = process.env.SONG_VIDEO_RENDER_ATTEMPT_ID?.trim() || undefined;
  const claimId = process.env.SONG_VIDEO_RENDER_HOST_ID?.trim() || crypto.randomUUID();
  const databaseUrl = required("SONG_VIDEO_RENDER_DATABASE_URL");
  const bucket = required("SONG_VIDEO_RENDER_R2_BUCKET");
  const transport = makeHostR2Transport({
    accountId: required("SONG_VIDEO_RENDER_R2_ACCOUNT_ID"),
    credentials: {
      accessKeyId: required("SONG_VIDEO_RENDER_R2_ACCESS_KEY_ID"),
      secretAccessKey: required("SONG_VIDEO_RENDER_R2_SECRET_ACCESS_KEY"),
    },
    ...(process.env.SONG_VIDEO_RENDER_R2_ENDPOINT?.trim()
      ? { endpoint: process.env.SONG_VIDEO_RENDER_R2_ENDPOINT.trim() }
      : {}),
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

  const claimNext = async (): Promise<HostRenderClaim | null> => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      return await claimHostRenderAttempt(client, {
        ...(planId === undefined ? {} : { planId }),
        ...(attemptId === undefined ? {} : { attemptId }),
        claimId,
      });
    } finally {
      await client.end();
    }
  };

  if (planId !== undefined) {
    const claim = await claimNext();
    if (claim === null) {
      process.stdout.write(`${JSON.stringify({ plan_id: planId, status: "not_claimed" })}\n`);
      return;
    }
    const outcome = await executeHostRenderAttempt({ facts: claim.facts, renderer, store });
    process.stdout.write(
      `${JSON.stringify({ plan_id: planId, attempt_id: claim.facts.attemptId, ...outcome })}\n`,
    );
    // A pending execution stays visible for reconciliation; it is not a retry.
    if (outcome.status === "pending") process.exitCode = 2;
    return;
  }

  // Supervised loop: measure songs waiting for a canonical duration, then
  // claim one waiting attempt per pass. A claimed attempt that cannot be
  // concluded stays claimed and pending; no pass retries it.
  const intervalStore = makeControlPlaneSongVideoIntervalStore(
    makeDirectPostgresControlPlaneLayer(databaseUrl),
  );
  const pollMs = pollIntervalMs();
  const stopping = stopSignals();
  while (!stopping.stopped) {
    try {
      const measured = await measurePendingSongTimings({
        store: intervalStore,
        prober: engine.prober,
      });
      if (measured.measured + measured.failed > 0) {
        process.stdout.write(`${JSON.stringify({ status: "measured", ...measured })}\n`);
      }
      const claim = await claimNext();
      if (claim === null) {
        await stopping.sleep(pollMs);
        continue;
      }
      const outcome = await executeHostRenderAttempt({ facts: claim.facts, renderer, store });
      process.stdout.write(
        `${JSON.stringify({
          plan_id: claim.facts.planId,
          attempt_id: claim.facts.attemptId,
          ...outcome,
        })}\n`,
      );
    } catch {
      // A failed pass is reported without provider or connection text and is
      // retried. A claimed attempt that may have executed stays claimed and
      // pending, because a pass never releases a claim.
      process.stderr.write("song video render host pass failed\n");
      await stopping.sleep(pollMs);
    }
  }
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    // Sanitized: provider and connection failures can carry URLs or private
    // configuration, so only operator-supplied names are safe to repeat.
    const message = error instanceof Error ? error.message : "";
    const safe = /^[A-Z0-9_]+ is required$/u.test(message)
      ? message
      : "song video render host failed";
    process.stderr.write(`${safe}\n`);
    process.exitCode = 1;
  });
}
