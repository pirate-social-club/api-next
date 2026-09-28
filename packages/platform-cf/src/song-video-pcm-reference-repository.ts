import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import type {
  SongVideoPcmReference,
  SongVideoPcmReferenceStore,
} from "@pirate/application/video/song-interval";
import { Effect, type Layer } from "effect";

type Row = Readonly<Record<string, unknown>>;

const text = (row: Row, key: string): string => {
  const value = row[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`invalid song PCM reference row: ${key}`);
  }
  return value;
};

const count = (row: Row, key: string): number => {
  const value = row[key];
  const parsed =
    typeof value === "bigint" ? Number(value) : typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`invalid song PCM reference row: ${key}`);
  }
  return parsed;
};

/**
 * A database row is only readiness evidence while the exact immutable R2
 * object it admitted still exists. The final render read checks identity again.
 */
export function makeControlPlaneSongVideoPcmReferenceStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  bucket: Readonly<{
    head: (
      key: string,
    ) => Promise<Readonly<{ version: string; etag: string; size: number }> | null>;
  }>,
): SongVideoPcmReferenceStore {
  const run = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>): Promise<A> =>
    Effect.runPromise(Effect.provide(runtime)(effect));

  return {
    getReady: async (song, durationSamples) => {
      const row = await run(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          const result = yield* db.execute<Row>({
            label: "song-video-pcm-reference.ready",
            text: `SELECT canonical_audio_sha256,duration_samples,pcm_object_key,
                         pcm_object_version,pcm_object_etag,pcm_sha256,
                         pcm_byte_length,decoder_recipe
                    FROM media_song_video_pcm_references
                   WHERE song_post_id=$1 AND audio_revision=$2`,
            values: [song.songPostId, song.audioRevision],
            readonly: true,
          });
          if (result.rows.length > 1) throw new Error("song has multiple PCM references");
          return result.rows[0] ?? null;
        }),
      );
      if (row === null) return null;
      const reference: SongVideoPcmReference = {
        songPostId: song.songPostId,
        audioRevision: song.audioRevision,
        canonicalAudioSha256: text(row, "canonical_audio_sha256"),
        durationSamples: count(row, "duration_samples"),
        objectKey: text(row, "pcm_object_key"),
        objectVersion: text(row, "pcm_object_version"),
        objectEtag: text(row, "pcm_object_etag"),
        pcmSha256: text(row, "pcm_sha256"),
        byteLength: count(row, "pcm_byte_length"),
        decoderRecipe: text(row, "decoder_recipe"),
      };
      if (
        reference.canonicalAudioSha256 !== song.canonicalAudioSha256 ||
        reference.durationSamples !== durationSamples ||
        reference.byteLength !== durationSamples * 4 ||
        !reference.objectKey.startsWith("song-video-pcm/") ||
        !/^[0-9a-f]{64}$/u.test(reference.pcmSha256)
      ) {
        return null;
      }
      const object = await bucket.head(reference.objectKey);
      if (
        object === null ||
        object.version !== reference.objectVersion ||
        object.etag !== reference.objectEtag ||
        object.size !== reference.byteLength
      ) {
        return null;
      }
      return reference;
    },
  };
}
