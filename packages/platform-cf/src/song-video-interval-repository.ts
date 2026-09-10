import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import type {
  PendingSongTiming,
  SongCanonicalTimingStore,
} from "@pirate/application/video/song-canonical-timing";
import type {
  PublishedCanonicalSong,
  SongCanonicalTiming,
  SongOwnerVideoPolicy,
  SongVideoIntervalStore,
} from "@pirate/application/video/song-interval";
import { Effect, type Layer } from "effect";

type Row = Readonly<Record<string, unknown>>;

const text = (row: Row, key: string): string => {
  const value = row[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`invalid song video interval row: ${key}`);
  }
  return value;
};

const count = (row: Row, key: string): number => {
  const value = row[key];
  const parsed =
    typeof value === "bigint" ? Number(value) : typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`invalid song video interval row: ${key}`);
  }
  return parsed;
};

/** How long a claimed measurement is held before another worker may take it. */
const TIMING_LEASE_SECONDS = 300;

/**
 * Persistence for the song-backed interval: the published song a video would
 * render from, the owner policy in force, and the canonical timing measured
 * from the song's exact bytes.
 */
export function makeControlPlaneSongVideoIntervalStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): SongVideoIntervalStore & SongCanonicalTimingStore {
  const run = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>): Promise<A> =>
    Effect.runPromise(Effect.provide(runtime)(effect));

  return {
    getPublishedSong: (songPostId) =>
      run(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          // Public songs only. A song the actor could not otherwise see is
          // answered as absent rather than confirmed and then refused.
          const result = yield* db.execute<Row>({
            label: "song-video-interval.published-song",
            text: `SELECT community_id,audio_revision,audio_asset_ref,canonical_audio_sha256
                     FROM media_publication_projections
                    WHERE post_id=$1 AND media_kind='song' AND visibility='public'`,
            values: [songPostId],
            readonly: true,
          });
          if (result.rows.length === 0) return null;
          if (result.rows.length > 1) throw new Error("song post has more than one publication");
          const row = result.rows[0] as Row;
          const song: PublishedCanonicalSong = {
            songPostId,
            songCommunityId: text(row, "community_id"),
            audioRevision: count(row, "audio_revision"),
            canonicalAudioSha256: text(row, "canonical_audio_sha256"),
            songAssetId: text(row, "audio_asset_ref"),
          };
          return song;
        }),
      ),

    getOwnerPolicy: (song) =>
      run(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          const result = yield* db.execute<Row>({
            label: "song-video-interval.owner-policy",
            text: `SELECT owner_account_id,policy_revision,policy_hash,derivative_video
                     FROM song_owner_policy_revisions
                    WHERE community_id=$1 AND post_id=$2 AND audio_revision=$3
                    ORDER BY policy_revision DESC
                    LIMIT 1`,
            values: [song.songCommunityId, song.songPostId, song.audioRevision],
            readonly: true,
          });
          const row = result.rows[0];
          if (row === undefined) return null;
          const derivativeVideo = text(row, "derivative_video");
          if (
            derivativeVideo !== "allowed" &&
            derivativeVideo !== "owner_only" &&
            derivativeVideo !== "blocked"
          ) {
            throw new Error("invalid song owner derivative video policy");
          }
          const policy: SongOwnerVideoPolicy = {
            ownerAccountId: text(row, "owner_account_id"),
            policyRevision: count(row, "policy_revision"),
            policyHash: text(row, "policy_hash"),
            derivativeVideo,
          };
          return policy;
        }),
      ),

    getOrRequestTiming: (song) =>
      run(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          yield* db.execute({
            label: "song-video-interval.timing-request",
            text: `INSERT INTO media_song_canonical_timings
                     (song_post_id,audio_revision,song_community_id,canonical_audio_sha256,state)
                   VALUES ($1,$2,$3,$4,'pending')
                   ON CONFLICT (song_post_id,audio_revision) DO NOTHING`,
            values: [
              song.songPostId,
              song.audioRevision,
              song.songCommunityId,
              song.canonicalAudioSha256,
            ],
            readonly: false,
          });
          const result = yield* db.execute<Row>({
            label: "song-video-interval.timing-read",
            text: `SELECT state,duration_samples,canonical_audio_sha256
                     FROM media_song_canonical_timings
                    WHERE song_post_id=$1 AND audio_revision=$2`,
            values: [song.songPostId, song.audioRevision],
            readonly: true,
          });
          const row = result.rows[0];
          if (row === undefined) throw new Error("song timing request was not recorded");
          // Same revision, different bytes: the measurement describes other
          // audio. Refuse rather than answer with a duration for the wrong song.
          if (text(row, "canonical_audio_sha256") !== song.canonicalAudioSha256) {
            throw new Error("song timing is bound to different canonical bytes");
          }
          const state = text(row, "state");
          let timing: SongCanonicalTiming;
          if (state === "ready")
            timing = { state, durationSamples: count(row, "duration_samples") };
          else if (state === "pending" || state === "failed") timing = { state };
          else throw new Error("invalid song timing state");
          return timing;
        }),
      ),

    isSongReferenceVideoOrigin: (input) =>
      run(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          // A published video whose own frozen plan names this song. Until
          // song-reference videos can be published this finds nothing, which
          // is the correct answer rather than a stub.
          const result = yield* db.execute<Row>({
            label: "song-video-interval.origin",
            text: `SELECT EXISTS (
                     SELECT 1
                       FROM media_publication_projections v
                       JOIN media_upload_reservations r ON r.submission_id = v.submission_id
                       JOIN media_video_reservation_song_plans p ON p.reservation_id = r.reservation_id
                      WHERE v.post_id=$1 AND v.media_kind='video' AND p.song_post_id=$2
                   ) AS verified`,
            values: [input.originPostId, input.songPostId],
            readonly: true,
          });
          return result.rows[0]?.verified === true;
        }),
      ),

    claimPending: (limit) =>
      run(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          const result = yield* db.execute<Row>({
            label: "song-video-interval.timing-claim",
            text: `WITH claimable AS (
                     SELECT song_post_id,audio_revision
                       FROM media_song_canonical_timings
                      WHERE state='pending'
                        AND (lease_expires_at IS NULL OR lease_expires_at < clock_timestamp())
                      ORDER BY requested_at
                      LIMIT $1
                      FOR UPDATE SKIP LOCKED
                   )
                   UPDATE media_song_canonical_timings t
                      SET attempts = t.attempts + 1,
                          lease_expires_at = clock_timestamp() + make_interval(secs => $2)
                     FROM claimable c
                    WHERE t.song_post_id = c.song_post_id AND t.audio_revision = c.audio_revision
                   RETURNING t.song_post_id,t.audio_revision,t.canonical_audio_sha256,
                     (SELECT p.audio_asset_ref FROM media_publication_projections p
                       WHERE p.post_id = t.song_post_id AND p.media_kind='song'
                         AND p.audio_revision = t.audio_revision) AS audio_asset_ref`,
            values: [limit, TIMING_LEASE_SECONDS],
            readonly: false,
          });
          const claimed: PendingSongTiming[] = [];
          for (const row of result.rows) {
            // A revision whose song publication has moved on has no bytes to
            // measure at this revision; it is skipped, not measured elsewhere.
            if (typeof row.audio_asset_ref !== "string") continue;
            claimed.push({
              songPostId: text(row, "song_post_id"),
              audioRevision: count(row, "audio_revision"),
              canonicalAudioSha256: text(row, "canonical_audio_sha256"),
              audioAssetRef: row.audio_asset_ref,
            });
          }
          return claimed;
        }),
      ),

    complete: (input) =>
      run(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          const updated = yield* db.execute<Row>({
            label: "song-video-interval.timing-complete",
            text: `UPDATE media_song_canonical_timings
                      SET state='ready',duration_samples=$4,prober_identity=$5,
                          prober_policy_revision=$6,measured_at=clock_timestamp(),
                          lease_expires_at=NULL
                    WHERE song_post_id=$1 AND audio_revision=$2 AND canonical_audio_sha256=$3
                      AND state='pending'`,
            values: [
              input.songPostId,
              input.audioRevision,
              input.canonicalAudioSha256,
              input.durationSamples,
              input.proberIdentity,
              input.proberPolicyRevision,
            ],
            readonly: false,
          });
          if (updated.rowCount === 1) return;
          // Not pending: acceptable only as a replay of this exact measurement.
          const existing = yield* db.execute<Row>({
            label: "song-video-interval.timing-complete-replay",
            text: `SELECT state,duration_samples FROM media_song_canonical_timings
                    WHERE song_post_id=$1 AND audio_revision=$2 AND canonical_audio_sha256=$3`,
            values: [input.songPostId, input.audioRevision, input.canonicalAudioSha256],
            readonly: true,
          });
          const row = existing.rows[0];
          if (
            row === undefined ||
            row.state !== "ready" ||
            count(row, "duration_samples") !== input.durationSamples
          ) {
            throw new Error("song timing measurement conflicts with the recorded state");
          }
        }),
      ),

    fail: (input) =>
      run(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          yield* db.execute({
            label: "song-video-interval.timing-fail",
            text: `UPDATE media_song_canonical_timings
                      SET state='failed',failure_code=$4,lease_expires_at=NULL
                    WHERE song_post_id=$1 AND audio_revision=$2 AND canonical_audio_sha256=$3
                      AND state='pending'`,
            values: [
              input.songPostId,
              input.audioRevision,
              input.canonicalAudioSha256,
              input.failureCode,
            ],
            readonly: false,
          });
        }),
      ),
  };
}
