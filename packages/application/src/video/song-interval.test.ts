import { describe, expect, test } from "bun:test";
import {
  BadRequest,
  Conflict,
  EligibilityFailed,
  NotFound,
  RetryableConflict,
  VideoUploadReservationV1,
} from "@pirate/contracts";
import { Effect, Schema } from "effect";
import { SONG_VIDEO_SAMPLE_RATE_HZ } from "../../../domain/src/video-submission.ts";
import type { ContentStoreService } from "../ports.ts";
import type { PersonaRecord } from "../use-cases/personas.ts";
import {
  createVideoSubmission,
  reserveVideoUpload,
  VIDEO_MULTIPART_PART_SIZE_BYTES,
  type VideoPublicationServices,
  type VideoPublicationStore,
  type VideoReservationRecord,
} from "./publication.ts";
import {
  measurePendingSongTimings,
  type SongCanonicalTimingStore,
} from "./song-canonical-timing.ts";
import {
  freezeSongReservationPlan,
  type PublishedCanonicalSong,
  preflightSongVideoInterval,
  type SongCanonicalTiming,
  type SongOwnerVideoPolicy,
  type SongVideoIntervalServices,
  type SongVideoIntervalStore,
} from "./song-interval.ts";

const SECOND = SONG_VIDEO_SAMPLE_RATE_HZ;
const actor = { kind: "user" as const, userId: "account_author" };
const owner = { kind: "user" as const, userId: "account_owner" };
const song: PublishedCanonicalSong = {
  songPostId: "post_song",
  songCommunityId: "community_song",
  audioRevision: 3,
  canonicalAudioSha256: "a".repeat(64),
  songAssetId: "asset_song_r3",
};
const allowed: SongOwnerVideoPolicy = {
  ownerAccountId: owner.userId,
  policyRevision: 2,
  policyHash: "b".repeat(64),
  derivativeVideo: "allowed",
};

/** A song store whose answers can be changed between calls, as the world can. */
function songStore(
  state: {
    song?: PublishedCanonicalSong | null;
    policy?: SongOwnerVideoPolicy | null;
    timing?: SongCanonicalTiming;
    origin?: boolean;
  } = {},
) {
  const requested: PublishedCanonicalSong[] = [];
  const store: SongVideoIntervalStore = {
    getPublishedSong: async (id) => {
      const current = state.song === undefined ? song : state.song;
      return current !== null && current.songPostId === id ? current : null;
    },
    getOwnerPolicy: async () => (state.policy === undefined ? allowed : state.policy),
    getOrRequestTiming: async (target) => {
      requested.push(target);
      return state.timing ?? { state: "ready", durationSamples: 214 * SECOND };
    },
    isSongReferenceVideoOrigin: async () => state.origin ?? false,
  };
  return { store, state, requested };
}

type Access = "readable" | "hidden" | "age_locked";

/**
 * The post read as the viewer. `readable` is a published song post; `hidden`
 * is what an inaccessible post reads as; `age_locked` is the locked projection
 * an adult-rated post reads as for an account without age access.
 */
function contentStoreFor(access: Access = "readable", songCommunity = "community_song") {
  const reads: string[] = [];
  const contentStore: Pick<ContentStoreService, "resolvePost" | "getPost"> = {
    resolvePost: ({ postId }) =>
      Effect.succeed(postId === "post_song" ? { postId, communityId: songCommunity } : null),
    getPost: ({ postId, viewerUserId }) => {
      reads.push(`${postId}:${viewerUserId}`);
      if (access === "hidden") return Effect.succeed(null);
      // SAFETY: only the fields the access rule reads are modelled here.
      if (access === "age_locked") return Effect.succeed({ kind: "age_locked" } as never);
      return Effect.succeed({
        post: { id: postId, community: songCommunity, post_type: "song", status: "published" },
      } as never);
    },
  };
  return { contentStore, reads };
}

const intervalServices = (
  store: SongVideoIntervalStore,
  access: Access = "readable",
): SongVideoIntervalServices => ({
  store,
  contentStore: contentStoreFor(access).contentStore,
  measuringRetryAfterMs: 1_500,
});

describe("song-video interval preflight", () => {
  test("answers with the canonical song's own revision and probed duration", async () => {
    const { store } = songStore();
    const result = await preflightSongVideoInterval(
      { communityId: "community_video", actor, body: { song_post_id: "post_song" } },
      intervalServices(store),
    );
    expect(result).toEqual({
      state: "ready",
      song_post_id: "post_song",
      audio_revision: 3,
      canonical_duration_samples: 214 * SECOND,
      interval_policy: {
        policy_revision: 1,
        sample_rate_hz: 48_000,
        min_clip_duration_samples: 3 * SECOND,
        max_clip_duration_samples: 180 * SECOND,
      },
      interval: null,
    });
  });

  test("judges a proposed interval against that duration, with no tolerance", async () => {
    const { store } = songStore();
    const verdict = async (clip_start_samples: number, clip_duration_samples: number) => {
      const result = await preflightSongVideoInterval(
        {
          communityId: "community_video",
          actor,
          body: {
            song_post_id: "post_song",
            interval: { clip_start_samples, clip_duration_samples },
          },
        },
        intervalServices(store),
      );
      return result.state === "ready" ? result.interval : null;
    };
    expect(await verdict(184 * SECOND, 30 * SECOND)).toEqual({ accepted: true });
    expect(await verdict(184 * SECOND + 1, 30 * SECOND)).toEqual({
      accepted: false,
      reason: "canonical_song_interval_uncovered",
    });
    expect(await verdict(0, 2 * SECOND)).toEqual({ accepted: false, reason: "interval_too_short" });
    expect(await verdict(0, 181 * SECOND)).toEqual({
      accepted: false,
      reason: "interval_too_long",
    });
  });

  test("says measuring, and requests the measurement, rather than estimating", async () => {
    const { store, requested } = songStore({ timing: { state: "pending" } });
    const result = await preflightSongVideoInterval(
      { communityId: "community_video", actor, body: { song_post_id: "post_song" } },
      intervalServices(store),
    );
    expect(result).toEqual({
      state: "measuring",
      song_post_id: "post_song",
      audio_revision: 3,
      retry_after_ms: 1_500,
    });
    expect(requested).toEqual([song]);
  });

  test("reports a failed measurement as unavailable, not as a duration", async () => {
    const { store } = songStore({ timing: { state: "failed" } });
    const result = await preflightSongVideoInterval(
      { communityId: "community_video", actor, body: { song_post_id: "post_song" } },
      intervalServices(store),
    );
    expect(result).toEqual({
      state: "unavailable",
      song_post_id: "post_song",
      audio_revision: 3,
      reason: "canonical_timing_unavailable",
    });
  });

  test("refuses a song whose owner blocks or restricts derivative video", async () => {
    const run = (policy: SongOwnerVideoPolicy | null, who = actor) =>
      preflightSongVideoInterval(
        { communityId: "community_video", actor: who, body: { song_post_id: "post_song" } },
        intervalServices(songStore({ policy }).store),
      );
    await expect(run({ ...allowed, derivativeVideo: "blocked" })).rejects.toBeInstanceOf(
      EligibilityFailed,
    );
    await expect(run({ ...allowed, derivativeVideo: "owner_only" })).rejects.toBeInstanceOf(
      EligibilityFailed,
    );
    // An absent policy fails closed rather than reading as permission.
    await expect(run(null)).rejects.toBeInstanceOf(EligibilityFailed);
    // The owner may use their own owner-only song.
    expect((await run({ ...allowed, derivativeVideo: "owner_only" }, owner)).state).toBe("ready");
  });

  test("refuses a post that is not a published song, and malformed input", async () => {
    await expect(
      preflightSongVideoInterval(
        { communityId: "community_video", actor, body: { song_post_id: "post_other" } },
        intervalServices(songStore().store),
      ),
    ).rejects.toBeInstanceOf(NotFound);
    await expect(
      preflightSongVideoInterval(
        {
          communityId: "community_video",
          actor,
          body: { song_post_id: "post_song", song_duration_samples: 999 },
        },
        intervalServices(songStore().store),
      ),
    ).rejects.toBeInstanceOf(BadRequest);
  });
});

const songBody = {
  track: "video" as const,
  slot: "primary_video" as const,
  intent: "song_reference" as const,
  persona_id: "persona_video",
  idempotency_key: "reserve-song-video",
  expected_content_type: "video/mp4" as const,
  expected_size_bytes: VIDEO_MULTIPART_PART_SIZE_BYTES + 1,
  song_post_id: "post_song",
  selected_from: { kind: "library" as const },
  audio_revision: 3,
  clip_start_samples: 40 * SECOND,
  clip_duration_samples: 45 * SECOND,
};

describe("viewer access to the source song", () => {
  test("an age-locked song is refused before any metadata or measurement", async () => {
    const world = songStore();
    let songRead = false;
    const store = {
      ...world.store,
      getPublishedSong: async (id: string) => {
        songRead = true;
        return world.store.getPublishedSong(id);
      },
    };
    const error = await preflightSongVideoInterval(
      { communityId: "community_video", actor, body: { song_post_id: "post_song" } },
      intervalServices(store, "age_locked"),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(EligibilityFailed);
    expect(error.details).toEqual({ reason_code: "age_restricted" });
    // Nothing about the song was read, and no measurement was queued.
    expect(songRead).toBe(false);
    expect(world.requested).toEqual([]);
  });

  test("an inaccessible song reads as absent, whatever its owner allows", async () => {
    const world = songStore();
    await expect(
      preflightSongVideoInterval(
        { communityId: "community_video", actor, body: { song_post_id: "post_song" } },
        intervalServices(world.store, "hidden"),
      ),
    ).rejects.toBeInstanceOf(NotFound);
    expect(world.requested).toEqual([]);
  });

  test("reservation applies the same access rule first", async () => {
    const world = songStore();
    await expect(
      freezeSongReservationPlan(
        { actor, body: songBody, observedAt: "2026-09-10T12:00:00.000Z" },
        intervalServices(world.store, "age_locked"),
      ),
    ).rejects.toBeInstanceOf(EligibilityFailed);
    expect(world.requested).toEqual([]);
  });

  test("reads the song as this viewer, not as its owner", async () => {
    const { contentStore, reads } = contentStoreFor();
    await preflightSongVideoInterval(
      { communityId: "community_video", actor, body: { song_post_id: "post_song" } },
      { store: songStore().store, contentStore },
    );
    expect(reads).toEqual([`post_song:${actor.userId}`]);
  });

  test("a readable public song from another community is usable", async () => {
    // The song lives in community_song; the video is posted to community_video.
    const result = await preflightSongVideoInterval(
      { communityId: "community_video", actor, body: { song_post_id: "post_song" } },
      intervalServices(songStore().store),
    );
    expect(result.state).toBe("ready");
  });
});

describe("freezing the render plan at reservation", () => {
  const freeze = (
    store: SongVideoIntervalStore,
    body: typeof songBody | Record<string, unknown> = songBody,
  ) =>
    freezeSongReservationPlan(
      // biome-ignore lint/suspicious/noExplicitAny: variants are exercised deliberately below.
      { actor, body: body as any, observedAt: "2026-09-10T12:00:00.000Z" },
      intervalServices(store),
    );

  test("freezes only server-established values", async () => {
    const plan = await freeze(songStore().store);
    expect(plan).toEqual({
      songPostId: "post_song",
      audioRevision: 3,
      canonicalAudioSha256: "a".repeat(64),
      songDurationSamples: 214 * SECOND,
      songAssetId: "asset_song_r3",
      clipStartSamples: 40 * SECOND,
      clipDurationSamples: 45 * SECOND,
      intervalPolicyRevision: 1,
      ownerPolicyRevision: 2,
      ownerPolicyHash: "b".repeat(64),
      derivativeVideo: "allowed",
      selectedFrom: { kind: "library" },
      originVerified: false,
      observedAt: "2026-09-10T12:00:00.000Z",
    });
  });

  test("refuses an interval chosen on audio that has since changed", async () => {
    const error = await freeze(songStore({ song: { ...song, audioRevision: 4 } }).store).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(Conflict);
    expect(error.details).toEqual({
      reason_code: "song_audio_revision_changed",
      current_audio_revision: 4,
    });
  });

  test("revalidates from scratch rather than trusting an earlier preflight", async () => {
    const world = songStore();
    const preflight = await preflightSongVideoInterval(
      {
        communityId: "community_video",
        actor,
        body: {
          song_post_id: "post_song",
          interval: { clip_start_samples: 40 * SECOND, clip_duration_samples: 45 * SECOND },
        },
      },
      intervalServices(world.store),
    );
    expect(preflight.state === "ready" && preflight.interval).toEqual({ accepted: true });
    // The owner blocks derivative video between preflight and reservation.
    world.state.policy = { ...allowed, policyRevision: 3, derivativeVideo: "blocked" };
    await expect(freeze(world.store)).rejects.toBeInstanceOf(EligibilityFailed);
  });

  test("asks for a retry while the song is still being measured", async () => {
    await expect(freeze(songStore({ timing: { state: "pending" } }).store)).rejects.toBeInstanceOf(
      RetryableConflict,
    );
    await expect(freeze(songStore({ timing: { state: "failed" } }).store)).rejects.toBeInstanceOf(
      Conflict,
    );
  });

  test("refuses an interval the canonical song cannot cover", async () => {
    const error = await freeze(songStore().store, {
      ...songBody,
      clip_start_samples: 214 * SECOND - 45 * SECOND + 1,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(BadRequest);
    expect(error.details).toEqual({ reason_code: "canonical_song_interval_uncovered" });
  });

  test("records feed provenance as verified only when the store proves it", async () => {
    const feed = {
      ...songBody,
      selected_from: { kind: "feed" as const, origin_post_id: "post_origin" },
    };
    expect((await freeze(songStore({ origin: false }).store, feed)).originVerified).toBe(false);
    const verified = await freeze(songStore({ origin: true }).store, feed);
    expect(verified.originVerified).toBe(true);
    expect(verified.selectedFrom).toEqual({ kind: "feed", originPostId: "post_origin" });
  });
});

const persona: PersonaRecord = {
  persona_id: "persona_video",
  object: "persona",
  status: "active",
  profile: {
    persona_id: "persona_video",
    object: "persona_profile",
    revision: 1,
    display_name: "Video Author",
    avatar_ref: null,
    cover_ref: null,
    bio: null,
    preferred_locale: "en",
    primary_public_handle: "name.video-author",
  },
  wallet_set: { evm: null },
  community_binding: null,
  created_at: "2026-09-04T00:00:00.000Z",
  retired_at: null,
};

function videoServices(input: {
  songInterval?: SongVideoIntervalServices;
  created?: Parameters<VideoPublicationStore["createReservation"]>[0][];
  reservation?: VideoReservationRecord;
}): VideoPublicationServices {
  const unused = async (): Promise<never> => {
    throw new Error("unused video publication method");
  };
  const store = new Proxy({} as VideoPublicationStore, {
    get: (_target, key) => {
      if (key === "replayReservation") return async () => ({ kind: "none" });
      if (key === "createReservation")
        return async (value: Parameters<VideoPublicationStore["createReservation"]>[0]) => {
          input.created?.push(value);
          return { kind: "none" };
        };
      if (key === "getReservationForAccount") return async () => input.reservation ?? null;
      return unused;
    },
  });
  return {
    store,
    multipart: {
      create: async () => ({
        uploadId: "upload_song_video",
        partSizeBytes: VIDEO_MULTIPART_PART_SIZE_BYTES,
        partCount: 2,
        parts: [
          {
            partNumber: 1,
            url: "https://ingress.test/part-1",
            expiresAt: "2026-09-10T13:00:00.000Z",
          },
          {
            partNumber: 2,
            url: "https://ingress.test/part-2",
            expiresAt: "2026-09-10T13:00:00.000Z",
          },
        ],
        expiresAt: "2026-09-10T13:00:00.000Z",
      }),
      renew: unused,
      completeOrInspect: unused,
      abort: unused,
    },
    sealer: { inspect: unused, seal: unused },
    personaServices: {
      personaStore: {
        findOwned: ({ accountId, personaId }) =>
          Effect.succeed(
            accountId === actor.userId && personaId === persona.persona_id ? persona : null,
          ),
      },
    },
    nowIso: () => "2026-09-10T12:00:00.000Z",
    randomUuid: () => "00000000-0000-4000-8000-00000000000a",
    ...(input.songInterval === undefined ? {} : { songInterval: input.songInterval }),
  };
}

describe("song-reference reservation through the request path", () => {
  test("stays an unavailable capability wherever song-backed video is not composed", async () => {
    const error = await reserveVideoUpload(
      { communityId: "community_video", actor, body: songBody },
      videoServices({}),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(BadRequest);
    expect(error.details).toMatchObject({
      reason_code: "capability_unavailable",
      capability: "song_reference",
    });
  });

  test("freezes the plan with the reservation and answers with the song variant", async () => {
    const created: Parameters<VideoPublicationStore["createReservation"]>[0][] = [];
    const response = await reserveVideoUpload(
      { communityId: "community_video", actor, body: songBody },
      videoServices({ songInterval: intervalServices(songStore().store), created }),
    );
    // The response is a valid contract document for the song-reference variant.
    expect(Schema.decodeUnknownSync(VideoUploadReservationV1)(response)).toEqual(response);
    expect(response).toMatchObject({
      intent: "song_reference",
      song_reference: {
        song_post_id: "post_song",
        audio_revision: 3,
        song_asset_id: "asset_song_r3",
      },
      reservation_policy_snapshot: {
        observed_at_transition: "media_reservation_issued",
        owner_policy_revision: 2,
        owner_policy_hash: "b".repeat(64),
        derivative_video: "allowed",
      },
      interval: {
        clip_start_samples: 40 * SECOND,
        clip_duration_samples: 45 * SECOND,
        song_duration_samples: 214 * SECOND,
      },
    });
    expect(created).toHaveLength(1);
    expect(created[0]?.record.intent).toBe("song_reference");
    expect(created[0]?.songPlan?.clipStartSamples).toBe(40 * SECOND);
    expect(created[0]?.songPlan?.songDurationSamples).toBe(214 * SECOND);
  });

  test("issues no upload authority when revalidation refuses", async () => {
    const created: Parameters<VideoPublicationStore["createReservation"]>[0][] = [];
    await expect(
      reserveVideoUpload(
        { communityId: "community_video", actor, body: songBody },
        videoServices({
          songInterval: intervalServices(songStore({ timing: { state: "pending" } }).store),
          created,
        }),
      ),
    ).rejects.toBeInstanceOf(RetryableConflict);
    expect(created).toHaveLength(0);
  });

  test("a song-reference reservation cannot start an original-audio submission", async () => {
    const reservation: VideoReservationRecord = {
      reservationId: "media-reservation-song",
      communityId: "community_video",
      intent: "song_reference",
      actorAccountId: actor.userId,
      authorPersonaId: persona.persona_id,
      requestHash: "c".repeat(64),
      expectedContentType: "video/mp4",
      expectedSizeBytes: VIDEO_MULTIPART_PART_SIZE_BYTES + 1,
      expectedSha256: null,
      ingestPolicyRevision: 1,
      uploadId: "upload_song_video",
      partSizeBytes: VIDEO_MULTIPART_PART_SIZE_BYTES,
      partCount: 2,
      expiresAt: "2026-09-10T13:00:00.000Z",
      state: "issued",
      submissionId: null,
      operationId: null,
      manifest: null,
      responseBytes: new Uint8Array([1]),
      updatedAt: "2026-09-10T12:00:00.000Z",
    };
    const error = await createVideoSubmission(
      {
        communityId: "community_video",
        actor,
        body: {
          persona_id: persona.persona_id,
          version: "video-start-input-v1",
          video_reservation_id: "media-reservation-song",
          caption: "danced to a song",
          idempotency_key: "create-song-video",
        },
      },
      videoServices({ songInterval: intervalServices(songStore().store), reservation }),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(BadRequest);
    expect(error.details).toMatchObject({
      reason_code: "capability_unavailable",
      capability: "song_reference",
    });
  });
});

describe("measuring a song's canonical duration", () => {
  function timingStore(pending: number) {
    const log: string[] = [];
    const store: SongCanonicalTimingStore = {
      claimPending: async () =>
        Array.from({ length: pending }, (_, index) => ({
          songPostId: `post_${index}`,
          audioRevision: 1,
          canonicalAudioSha256: "d".repeat(64),
          audioAssetRef: `asset_${index}`,
        })),
      complete: async (input) => {
        log.push(`complete:${input.songPostId}:${input.durationSamples}:${input.proberIdentity}`);
      },
      fail: async (input) => {
        log.push(`fail:${input.songPostId}:${input.failureCode}`);
      },
    };
    return { store, log };
  }

  test("records the prober's count, fails permanent faults and defers transient ones", async () => {
    const { store, log } = timingStore(4);
    const outcome = await measurePendingSongTimings({
      store,
      prober: {
        identity: "ffmpeg-pinned-test",
        policyRevision: 1,
        measure: async (input) => {
          if (input.songPostId === "post_0") return { ok: true, durationSamples: 9_600_000 };
          if (input.songPostId === "post_1")
            return { ok: false, permanent: true, failureCode: "source_digest_mismatch" };
          if (input.songPostId === "post_2")
            return { ok: false, permanent: false, failureCode: "probe_unavailable" };
          throw new Error("prober crashed");
        },
      },
    });
    expect(outcome).toEqual({ measured: 1, failed: 1, deferred: 2 });
    // A crash is transient: nothing is recorded, so the revision stays pending.
    expect(log).toEqual([
      "complete:post_0:9600000:ffmpeg-pinned-test",
      "fail:post_1:source_digest_mismatch",
    ]);
  });

  test("never records a non-integer or empty duration as a measurement", async () => {
    const { store, log } = timingStore(1);
    await measurePendingSongTimings({
      store,
      prober: {
        identity: "p",
        policyRevision: 1,
        measure: async () => ({ ok: true, durationSamples: 0.5 }),
      },
    });
    expect(log).toEqual(["fail:post_0:undecodable_audio"]);
  });
});
