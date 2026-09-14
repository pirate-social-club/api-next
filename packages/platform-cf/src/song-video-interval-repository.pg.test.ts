import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { VideoReservationRecord } from "@pirate/application/video/publication";
import type { FrozenSongReservationPlan } from "@pirate/application/video/song-interval";
import { Client } from "pg";
import { runPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { makeControlPlaneSongVideoIntervalStore } from "./song-video-interval-repository.ts";
import { actor, community, persona, seedVideoActors } from "./video-publication.pg-fixture.ts";
import { makeControlPlaneVideoPublicationStore } from "./video-publication-repository.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !connectionString)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
const suite = connectionString ? describe : describe.skip;

const SECOND = 48_000;
const SONG_SHA = "e".repeat(64);
const SONG_POST = "post-song-interval";
const SONG_COMMUNITY = "community-song-interval";
const SONG_OWNER = "song-interval-owner";
const MEASURED = 214 * SECOND;
const sha256 = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");

/** Resolves to the name of the constraint that refused, so a test cannot pass for another reason. */
async function refusedBy(action: Promise<unknown>): Promise<string> {
  try {
    await action;
  } catch (error) {
    const constraint = (error as { constraint?: unknown }).constraint;
    return typeof constraint === "string" ? constraint : `unnamed: ${String(error)}`;
  }
  throw new Error("expected the database to refuse");
}

suite("song video interval persistence", () => {
  const schema = `song_interval_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString });
  const scoped = new URL(connectionString ?? "postgresql://unused/unused");
  scoped.searchParams.set("options", `-c search_path=${schema}`);
  const client = new Client({ connectionString: scoped.toString() });
  let intervals: ReturnType<typeof makeControlPlaneSongVideoIntervalStore>;
  let reservations: ReturnType<typeof makeControlPlaneVideoPublicationStore>;

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    await runPostgresMigrations({ connectionString: scoped.toString() });
    await seedVideoActors(admin);
    // A published song and its owner policy, seeded past the publication
    // pipeline's triggers the way the Karaoke suite seeds one. Everything this
    // suite asserts runs on a separate connection with every trigger live.
    await admin.query("SET session_replication_role = replica");
    await admin.query(
      `INSERT INTO media_publication_projections (
         submission_id, community_id, actor_user_id, operation_id, post_id,
         creation_revision, audio_revision, analysis_revision, decision_revision,
         canonical_audio_sha256, title, audio_asset_ref, language_status,
         primary_language_bcp47, lyrics_explicitness, alignment, data_registration,
         locked_delivery, projected_at, author_persona_id, lyrics_status)
       VALUES ('song-interval-submission',$1,$2,'song-interval-operation',$3,
         1,1,1,1,$4,'Interval song','song-interval-audio-ref','ready','en','not_explicit',
         'ready','registered','not_required',clock_timestamp(),'song-interval-persona','no_lyrics')`,
      [SONG_COMMUNITY, SONG_OWNER, SONG_POST, SONG_SHA],
    );
    await admin.query(
      `INSERT INTO song_owner_policy_revisions
         (community_id,post_id,audio_revision,owner_account_id,policy_revision,
          third_party_reward_legs,pool_leg,derivative_video,policy_hash)
       VALUES ($1,$2,1,$3,1,'allowed','allowed','allowed',
         song_owner_policy_hash_v1($1,$2,1,$3,1,'allowed','allowed','allowed'))`,
      [SONG_COMMUNITY, SONG_POST, SONG_OWNER],
    );
    await admin.query("SET session_replication_role = origin");
    await client.connect();
    const layer = makeDirectPostgresControlPlaneLayer(scoped.toString());
    intervals = makeControlPlaneSongVideoIntervalStore(layer);
    reservations = makeControlPlaneVideoPublicationStore(layer);
  }, 180_000);

  afterAll(async () => {
    await client.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  const responseFor = (reservationId: string) =>
    new TextEncoder().encode(`{"reservation_id":"${reservationId}"}`);

  const reservationRecord = (
    reservationId: string,
    intent: VideoReservationRecord["intent"],
  ): VideoReservationRecord => ({
    reservationId,
    communityId: community,
    intent,
    actorAccountId: actor,
    authorPersonaId: persona,
    requestHash: "c".repeat(64),
    expectedContentType: "video/mp4",
    expectedSizeBytes: 1_024,
    expectedSha256: null,
    ingestPolicyRevision: 1,
    uploadId: `multipart-${reservationId}`,
    partSizeBytes: 10 * 1024 * 1024,
    partCount: 1,
    expiresAt: "2099-09-10T01:00:00.000Z",
    state: "issued",
    submissionId: null,
    operationId: null,
    manifest: null,
    responseBytes: responseFor(reservationId),
    updatedAt: "2026-09-10T00:00:00.000Z",
  });

  const plan = (overrides: Partial<FrozenSongReservationPlan> = {}): FrozenSongReservationPlan => ({
    songPostId: SONG_POST,
    audioRevision: 1,
    canonicalAudioSha256: SONG_SHA,
    songDurationSamples: MEASURED,
    songAssetId: "song-interval-audio-ref",
    clipStartSamples: 40 * SECOND,
    clipDurationSamples: 45 * SECOND,
    intervalPolicyRevision: 1,
    ownerPolicyRevision: 1,
    ownerPolicyHash: "f".repeat(64),
    derivativeVideo: "allowed",
    selectedFrom: { kind: "library" },
    originVerified: false,
    observedAt: "2026-09-10T00:00:00.000Z",
    ...overrides,
  });

  const reserve = (reservationId: string, songPlan?: FrozenSongReservationPlan) =>
    reservations.createReservation({
      record: reservationRecord(
        reservationId,
        songPlan === undefined ? "original_audio" : "song_reference",
      ),
      idempotencyKey: `reserve-${reservationId}`,
      responseSha256: sha256(responseFor(reservationId)),
      parts: [
        {
          partNumber: 1,
          url: "https://upload.invalid/part",
          expiresAt: "2099-09-10T01:00:00.000Z",
        },
      ],
      ...(songPlan === undefined ? {} : { songPlan }),
    });

  /** Inserts a song-reference reservation row directly, with a genuine response hash. */
  const insertSongReservation = (reservationId: string) =>
    client.query(
      `INSERT INTO media_upload_reservations
        (reservation_id,community_id,actor_user_id,actor_persona_id,idempotency_key,
         request_hash,expected_content_type,expected_size_bytes,expected_sha256,
         upload_url,upload_headers,expires_at,response_snapshot_bytes,response_snapshot_sha256,
         media_kind,video_intent,ingest_policy_revision,multipart_upload_id,
         multipart_part_size_bytes,multipart_part_count)
       VALUES ($1,$2,$3,$4,$5,$6,'video/mp4',1024,NULL,NULL,'[]'::jsonb,
               '2099-09-10T01:00:00Z',$7,$8,'video','song_reference',1,$9,10485760,1)`,
      [
        reservationId,
        community,
        actor,
        persona,
        `reserve-${reservationId}`,
        "c".repeat(64),
        Buffer.from(responseFor(reservationId)),
        sha256(responseFor(reservationId)),
        `multipart-${reservationId}`,
      ],
    );

  /** Inserts a plan row directly, bypassing every application check. */
  const insertPlan = (reservationId: string, overrides: Record<string, unknown> = {}) => {
    const row = {
      song_duration_samples: MEASURED,
      clip_start_samples: 40 * SECOND,
      clip_duration_samples: 45 * SECOND,
      derivative_video: "allowed",
      ...overrides,
    };
    return client.query(
      `INSERT INTO media_video_reservation_song_plans
         (reservation_id,reservation_community_id,song_post_id,audio_revision,canonical_audio_sha256,
          song_duration_samples,song_asset_id,clip_start_samples,clip_duration_samples,
          interval_policy_revision,owner_policy_revision,owner_policy_hash,derivative_video,
          selected_from_kind,origin_post_id,origin_verified)
       VALUES ($1,$2,$3,1,$4,$5,'song-interval-audio-ref',$6,$7,1,1,$8,$9,'library',NULL,false)`,
      [
        reservationId,
        community,
        SONG_POST,
        SONG_SHA,
        row.song_duration_samples,
        row.clip_start_samples,
        row.clip_duration_samples,
        "f".repeat(64),
        row.derivative_video,
      ],
    );
  };

  /** Runs direct SQL in a transaction that is always rolled back. */
  const rolledBack = async <T>(work: () => Promise<T>): Promise<T> => {
    await client.query("BEGIN");
    try {
      return await work();
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
    }
  };

  test("reads a public published song at its current revision, and nothing else", async () => {
    expect(await intervals.getPublishedSong(SONG_POST)).toEqual({
      songPostId: SONG_POST,
      songCommunityId: SONG_COMMUNITY,
      audioRevision: 1,
      canonicalAudioSha256: SONG_SHA,
      songAssetId: "song-interval-audio-ref",
    });
    expect(await intervals.getPublishedSong("post-not-a-song")).toBeNull();
  });

  test("reads the owner policy in force for exactly that revision", async () => {
    const song = await intervals.getPublishedSong(SONG_POST);
    if (song === null) throw new Error("song missing");
    const policy = await intervals.getOwnerPolicy(song);
    expect(policy?.derivativeVideo).toBe("allowed");
    expect(policy?.ownerAccountId).toBe(SONG_OWNER);
    expect(policy?.policyHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(await intervals.getOwnerPolicy({ ...song, audioRevision: 2 })).toBeNull();
  });

  test("a plan cannot be frozen against a song that is not yet measured", async () => {
    const song = await intervals.getPublishedSong(SONG_POST);
    if (song === null) throw new Error("song missing");
    expect(await intervals.getOrRequestTiming(song)).toEqual({ state: "pending" });
    // The timing row exists but has no duration, so the composite key cannot
    // match: the database refuses the plan, whatever the caller believed.
    expect(
      await rolledBack(async () => {
        await insertSongReservation("media-reservation-unmeasured-sql");
        return refusedBy(insertPlan("media-reservation-unmeasured-sql"));
      }),
    ).toBe("song_video_reservation_plan_timing_fk");
    // Through the store the whole reservation is refused, not only the plan.
    await expect(reserve("media-reservation-unmeasured", plan())).rejects.toThrow();
    const leftover = await client.query(
      "SELECT count(*)::int AS n FROM media_upload_reservations WHERE reservation_id=$1",
      ["media-reservation-unmeasured"],
    );
    expect(leftover.rows[0]?.n).toBe(0);
  });

  test("measures once under a lease, and then answers with the fact", async () => {
    const song = await intervals.getPublishedSong(SONG_POST);
    if (song === null) throw new Error("song missing");
    // Asking again does not queue a second measurement.
    expect(await intervals.getOrRequestTiming(song)).toEqual({ state: "pending" });
    const rows = await client.query("SELECT count(*)::int AS n FROM media_song_canonical_timings");
    expect(rows.rows[0]?.n).toBe(1);

    const claimed = await intervals.claimPending(8);
    expect(claimed).toEqual([
      {
        songPostId: SONG_POST,
        audioRevision: 1,
        canonicalAudioSha256: SONG_SHA,
        audioAssetRef: "song-interval-audio-ref",
      },
    ]);
    // Leased: a second worker finds nothing to take.
    expect(await intervals.claimPending(8)).toEqual([]);

    await intervals.complete({
      ...claimed[0]!,
      durationSamples: MEASURED,
      proberIdentity: "ffmpeg-pinned-test",
      proberPolicyRevision: 1,
    });
    expect(await intervals.getOrRequestTiming(song)).toEqual({
      state: "ready",
      durationSamples: MEASURED,
    });
  });

  test("a measured timing is a fact: replay is accepted, change is refused", async () => {
    const pending = {
      songPostId: SONG_POST,
      audioRevision: 1,
      canonicalAudioSha256: SONG_SHA,
      audioAssetRef: "song-interval-audio-ref",
    };
    await intervals.complete({
      ...pending,
      durationSamples: MEASURED,
      proberIdentity: "ffmpeg-pinned-test",
      proberPolicyRevision: 1,
    });
    await expect(
      intervals.complete({
        ...pending,
        durationSamples: MEASURED - 1,
        proberIdentity: "ffmpeg-pinned-test",
        proberPolicyRevision: 1,
      }),
    ).rejects.toThrow();
    await expect(
      client.query(
        "UPDATE media_song_canonical_timings SET duration_samples=duration_samples+1 WHERE song_post_id=$1",
        [SONG_POST],
      ),
    ).rejects.toThrow("immutable");
    await expect(
      client.query("DELETE FROM media_song_canonical_timings WHERE song_post_id=$1", [SONG_POST]),
    ).rejects.toThrow("immutable");
  });

  test("a song-reference reservation commits with its frozen plan and reads back its intent", async () => {
    expect(await reserve("media-reservation-song", plan())).toEqual({ kind: "none" });
    const record = await reservations.getReservationForAccount({
      reservationId: "media-reservation-song",
      actorAccountId: actor,
    });
    expect(record?.intent).toBe("song_reference");
    const stored = await client.query(
      `SELECT song_post_id, audio_revision, song_duration_samples, clip_start_samples,
              clip_duration_samples, derivative_video, selected_from_kind, origin_verified
         FROM media_video_reservation_song_plans WHERE reservation_id=$1`,
      ["media-reservation-song"],
    );
    expect(stored.rows[0]).toEqual({
      song_post_id: SONG_POST,
      audio_revision: "1",
      song_duration_samples: String(MEASURED),
      clip_start_samples: String(40 * SECOND),
      clip_duration_samples: String(45 * SECOND),
      derivative_video: "allowed",
      selected_from_kind: "library",
      origin_verified: false,
    });
    // An original-audio reservation carries no plan and reads back as such.
    expect(await reserve("media-reservation-original")).toEqual({ kind: "none" });
    const original = await reservations.getReservationForAccount({
      reservationId: "media-reservation-original",
      actorAccountId: actor,
    });
    expect(original?.intent).toBe("original_audio");
  });

  test("the plan must match the measured duration exactly", async () => {
    // A plan claiming a different song length than was measured has no timing
    // fact to bind to, even if its interval would fit.
    expect(
      await rolledBack(async () => {
        await insertSongReservation("media-reservation-wrong-length");
        return refusedBy(
          insertPlan("media-reservation-wrong-length", { song_duration_samples: MEASURED + 1 }),
        );
      }),
    ).toBe("song_video_reservation_plan_timing_fk");
  });

  test("the database refuses a song-reference reservation without its plan", async () => {
    await client.query("BEGIN");
    try {
      // The row itself is valid; only committing it without a plan is refused.
      await insertSongReservation("media-reservation-planless");
      await expect(client.query("COMMIT")).rejects.toThrow("requires its frozen plan");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    const leftover = await client.query(
      "SELECT count(*)::int AS n FROM media_upload_reservations WHERE reservation_id=$1",
      ["media-reservation-planless"],
    );
    expect(leftover.rows[0]?.n).toBe(0);
  });

  test("the store refuses an intent and a plan that disagree", async () => {
    await expect(
      reservations.createReservation({
        record: reservationRecord("media-reservation-mismatch", "song_reference"),
        idempotencyKey: "reserve-mismatch",
        responseSha256: sha256(responseFor("media-reservation-mismatch")),
        parts: [
          {
            partNumber: 1,
            url: "https://upload.invalid/part",
            expiresAt: "2099-09-10T01:00:00.000Z",
          },
        ],
      }),
    ).rejects.toThrow();
  });

  test("a frozen plan is immutable and contained, below the application", async () => {
    await expect(
      client.query(
        "UPDATE media_video_reservation_song_plans SET clip_start_samples=0 WHERE reservation_id=$1",
        ["media-reservation-song"],
      ),
    ).rejects.toThrow("immutable");
    // One sample past the measured end fails containment in the database itself.
    expect(
      await rolledBack(async () => {
        await insertSongReservation("media-reservation-overrun");
        return refusedBy(
          insertPlan("media-reservation-overrun", {
            clip_start_samples: MEASURED - 45 * SECOND + 1,
          }),
        );
      }),
    ).toBe("song_video_reservation_plan_containment");
    // Exactly at the measured end is accepted: half-open, no tolerance either way.
    await rolledBack(async () => {
      await insertSongReservation("media-reservation-at-end");
      await insertPlan("media-reservation-at-end", { clip_start_samples: MEASURED - 45 * SECOND });
    });
    // A blocked policy cannot be frozen, even by a caller that skipped the check.
    expect(
      await rolledBack(async () => {
        await insertSongReservation("media-reservation-blocked");
        return refusedBy(insertPlan("media-reservation-blocked", { derivative_video: "blocked" }));
      }),
    ).toBe("media_video_reservation_song_plans_derivative_video_check");
    // Interval bounds are enforced here too: 3 to 180 seconds.
    expect(
      await rolledBack(async () => {
        await insertSongReservation("media-reservation-too-long");
        return refusedBy(
          insertPlan("media-reservation-too-long", {
            clip_start_samples: 0,
            clip_duration_samples: 180 * SECOND + 1,
          }),
        );
      }),
    ).toBe("media_video_reservation_song_plans_clip_duration_samples_check");
  });

  test("a feed origin verifies only against a published song-reference video", async () => {
    expect(
      await intervals.isSongReferenceVideoOrigin({
        originPostId: "post-anything",
        songPostId: SONG_POST,
      }),
    ).toBe(false);
  });
});
