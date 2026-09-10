import {
  BadRequest,
  Conflict,
  EligibilityFailed,
  NotFound,
  type ReserveVideoUploadV1,
  RetryableConflict,
  SongVideoIntervalPreflightInputV1,
  type SongVideoIntervalPreflightV1,
} from "@pirate/contracts";
import { Schema } from "effect";
import {
  checkSongVideoInterval,
  SONG_VIDEO_INTERVAL_POLICY_V1,
} from "../../../domain/src/video-submission.ts";
import { requireMediaHumanActor } from "../media/submission-service.ts";
import type { M2Actor } from "../ports.ts";

/**
 * Spec 013 §5A song-backed interval: server-authoritative preflight, and the
 * render plan a reservation freezes.
 *
 * The canonical duration is the renderer's own probed sample count, measured
 * once per song post and audio revision and bound to the exact canonical
 * bytes. Nothing here accepts a duration from a client, and nothing here
 * estimates one: a frame-sum length differs from the decoded length by the
 * encoder delay and padding a gapless decoder trims, and containment has no
 * tolerance.
 *
 * Preflight is advice. Reservation revalidates every fact itself, because the
 * song, its owner policy and its timing can all move between the two calls,
 * and a successful preflight says nothing about whether a recording made later
 * will be usable.
 */

const exactParseOptions = { onExcessProperty: "error" } as const;

/** A published song at its current audio revision, as the renderer would read it. */
export type PublishedCanonicalSong = Readonly<{
  songPostId: string;
  songCommunityId: string;
  audioRevision: number;
  canonicalAudioSha256: string;
  songAssetId: string;
}>;

/** The owner policy in force for that song revision. */
export type SongOwnerVideoPolicy = Readonly<{
  ownerAccountId: string;
  policyRevision: number;
  policyHash: string;
  derivativeVideo: "allowed" | "owner_only" | "blocked";
}>;

export type SongCanonicalTiming =
  | Readonly<{ state: "pending" }>
  | Readonly<{ state: "ready"; durationSamples: number }>
  | Readonly<{ state: "failed" }>;

export interface SongVideoIntervalStore {
  /** Null when the post is not a published song. */
  readonly getPublishedSong: (songPostId: string) => Promise<PublishedCanonicalSong | null>;
  /** The latest owner policy for exactly this song revision, or null. */
  readonly getOwnerPolicy: (song: PublishedCanonicalSong) => Promise<SongOwnerVideoPolicy | null>;
  /**
   * The timing for this exact revision and canonical bytes. When none exists it
   * requests a measurement and answers pending; it never answers from anything
   * but a measured fact.
   */
  readonly getOrRequestTiming: (song: PublishedCanonicalSong) => Promise<SongCanonicalTiming>;
  /**
   * Whether `originPostId` is a published song-reference video whose frozen plan
   * names `songPostId`. Feed provenance is recorded, never trusted.
   */
  readonly isSongReferenceVideoOrigin: (input: {
    readonly originPostId: string;
    readonly songPostId: string;
  }) => Promise<boolean>;
}

export type SongVideoIntervalServices = Readonly<{
  store: SongVideoIntervalStore;
  /** How long a client should wait before asking again while a song is measured. */
  measuringRetryAfterMs?: number;
}>;

/** The render plan as frozen at reservation. Every value is server-established. */
export type FrozenSongReservationPlan = Readonly<{
  songPostId: string;
  audioRevision: number;
  canonicalAudioSha256: string;
  songDurationSamples: number;
  songAssetId: string;
  clipStartSamples: number;
  clipDurationSamples: number;
  intervalPolicyRevision: number;
  ownerPolicyRevision: number;
  ownerPolicyHash: string;
  derivativeVideo: "allowed" | "owner_only";
  selectedFrom: Readonly<{ kind: "library" }> | Readonly<{ kind: "feed"; originPostId: string }>;
  originVerified: boolean;
  observedAt: string;
}>;

const DEFAULT_MEASURING_RETRY_AFTER_MS = 2_000;

function intervalPolicy() {
  return {
    policy_revision: SONG_VIDEO_INTERVAL_POLICY_V1.policyRevision,
    sample_rate_hz: SONG_VIDEO_INTERVAL_POLICY_V1.sampleRateHz,
    min_clip_duration_samples: SONG_VIDEO_INTERVAL_POLICY_V1.minClipDurationSamples,
    max_clip_duration_samples: SONG_VIDEO_INTERVAL_POLICY_V1.maxClipDurationSamples,
  } as const;
}

/**
 * Owner policy is part of eligibility, not a later publication concern: a video
 * whose song refuses derivative use must not be recorded at all. An absent
 * policy fails closed rather than being read as permission.
 */
function requireDerivativeVideoPermission(
  policy: SongOwnerVideoPolicy | null,
  actor: M2Actor,
): SongOwnerVideoPolicy & { derivativeVideo: "allowed" | "owner_only" } {
  if (policy === null) {
    throw new EligibilityFailed({
      message: "This song cannot be used in a video",
      details: { reason_code: "song_owner_policy_unavailable" },
    });
  }
  if (policy.derivativeVideo === "blocked") {
    throw new EligibilityFailed({
      message: "This song cannot be used in a video",
      details: { reason_code: "derivative_video_blocked" },
    });
  }
  if (policy.derivativeVideo === "owner_only" && policy.ownerAccountId !== actor.userId) {
    throw new EligibilityFailed({
      message: "Only this song's owner can use it in a video",
      details: { reason_code: "derivative_video_owner_only" },
    });
  }
  return { ...policy, derivativeVideo: policy.derivativeVideo };
}

async function requirePublishedSong(
  store: SongVideoIntervalStore,
  songPostId: string,
): Promise<PublishedCanonicalSong> {
  const song = await store.getPublishedSong(songPostId);
  if (song === null) {
    throw new NotFound({
      message: "Song not found",
      details: { reason_code: "song_not_found" },
    });
  }
  return song;
}

/**
 * Preflight: the canonical song's own timing, and a verdict on a proposed
 * interval. A song not yet measured answers `measuring` and requests the
 * measurement; it is never answered from an estimate.
 */
export async function preflightSongVideoInterval(
  input: Readonly<{ communityId: string; actor: M2Actor; body: unknown }>,
  services: SongVideoIntervalServices,
): Promise<SongVideoIntervalPreflightV1> {
  requireMediaHumanActor(input.actor);
  let body: SongVideoIntervalPreflightInputV1;
  try {
    body = Schema.decodeUnknownSync(
      SongVideoIntervalPreflightInputV1,
      exactParseOptions,
    )(input.body);
  } catch {
    throw new BadRequest({ message: "Invalid request body" });
  }
  const song = await requirePublishedSong(services.store, body.song_post_id);
  requireDerivativeVideoPermission(await services.store.getOwnerPolicy(song), input.actor);

  const timing = await services.store.getOrRequestTiming(song);
  if (timing.state === "pending") {
    return {
      state: "measuring",
      song_post_id: song.songPostId,
      audio_revision: song.audioRevision,
      retry_after_ms: services.measuringRetryAfterMs ?? DEFAULT_MEASURING_RETRY_AFTER_MS,
    };
  }
  if (timing.state === "failed") {
    return {
      state: "unavailable",
      song_post_id: song.songPostId,
      audio_revision: song.audioRevision,
      reason: "canonical_timing_unavailable",
    };
  }
  const verdict =
    body.interval === undefined
      ? null
      : checkSongVideoInterval({
          clipStartSamples: body.interval.clip_start_samples,
          clipDurationSamples: body.interval.clip_duration_samples,
          songDurationSamples: timing.durationSamples,
        });
  return {
    state: "ready",
    song_post_id: song.songPostId,
    audio_revision: song.audioRevision,
    canonical_duration_samples: timing.durationSamples,
    interval_policy: intervalPolicy(),
    interval:
      verdict === null
        ? null
        : verdict.accepted
          ? { accepted: true }
          : { accepted: false, reason: verdict.reason },
  };
}

/**
 * Revalidates a song-reference reservation from scratch and returns the plan to
 * freeze with it. It trusts no preflight: the song must still be published at
 * the revision the author chose, its owner must still permit the use, its
 * timing must be measured, and the interval must fit that measurement.
 */
export async function freezeSongReservationPlan(
  input: Readonly<{
    actor: M2Actor;
    body: Extract<ReserveVideoUploadV1, { intent: "song_reference" }>;
    observedAt: string;
  }>,
  services: SongVideoIntervalServices,
): Promise<FrozenSongReservationPlan> {
  const { body } = input;
  const song = await requirePublishedSong(services.store, body.song_post_id);
  if (song.audioRevision !== body.audio_revision) {
    throw new Conflict({
      message: "The song's audio changed after the interval was chosen",
      details: {
        reason_code: "song_audio_revision_changed",
        current_audio_revision: song.audioRevision,
      },
    });
  }
  const policy = requireDerivativeVideoPermission(
    await services.store.getOwnerPolicy(song),
    input.actor,
  );
  const timing = await services.store.getOrRequestTiming(song);
  if (timing.state === "pending") {
    throw new RetryableConflict({
      message: "The song is still being measured",
      details: { reason_code: "canonical_timing_pending" },
    });
  }
  if (timing.state === "failed") {
    throw new Conflict({
      message: "This song's audio cannot back a video",
      details: { reason_code: "canonical_timing_unavailable" },
    });
  }
  const verdict = checkSongVideoInterval({
    clipStartSamples: body.clip_start_samples,
    clipDurationSamples: body.clip_duration_samples,
    songDurationSamples: timing.durationSamples,
  });
  if (!verdict.accepted) {
    throw new BadRequest({
      message: "The selected interval cannot be rendered from this song",
      details: { reason_code: verdict.reason },
    });
  }
  const selectedFrom =
    body.selected_from.kind === "feed"
      ? ({ kind: "feed", originPostId: body.selected_from.origin_post_id } as const)
      : ({ kind: "library" } as const);
  // An unverifiable feed origin is recorded as unverified and never surfaced;
  // it does not refuse the reservation.
  const originVerified =
    selectedFrom.kind === "feed" &&
    (await services.store.isSongReferenceVideoOrigin({
      originPostId: selectedFrom.originPostId,
      songPostId: song.songPostId,
    }));
  return {
    songPostId: song.songPostId,
    audioRevision: song.audioRevision,
    canonicalAudioSha256: song.canonicalAudioSha256,
    songDurationSamples: timing.durationSamples,
    songAssetId: song.songAssetId,
    clipStartSamples: body.clip_start_samples,
    clipDurationSamples: body.clip_duration_samples,
    intervalPolicyRevision: SONG_VIDEO_INTERVAL_POLICY_V1.policyRevision,
    ownerPolicyRevision: policy.policyRevision,
    ownerPolicyHash: policy.policyHash,
    derivativeVideo: policy.derivativeVideo,
    selectedFrom,
    originVerified,
    observedAt: input.observedAt,
  };
}
