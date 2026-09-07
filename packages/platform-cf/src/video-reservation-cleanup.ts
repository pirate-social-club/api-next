import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import { Effect, type Layer } from "effect";
import { videoIngressObjectKey } from "../../application/src/video/publication.ts";

export interface VideoIngressAbortBucket {
  readonly resumeMultipartUpload: (
    key: string,
    uploadId: string,
  ) => {
    readonly abort: () => Promise<void>;
  };
}

type Candidate = { reservation_id: string; multipart_upload_id: string };

/** Keep the row lock until storage confirms abort. Failed/uncertain aborts remain eligible.
 * Finalize must reject expired manifest-less rows; a timed-out abort can still finish in R2.
 */
export function makeVideoReservationCleanup(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  bucket: VideoIngressAbortBucket,
) {
  return async (limit = 10): Promise<{ selected: number; aborted: number; failed: number }> => {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("Invalid video cleanup limit");
    const run = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
      Effect.runPromise(effect.pipe(Effect.provide(runtime)));
    const candidates = await run(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return (yield* db.execute<Candidate>({
          label: "video-reservation.cleanup-candidates",
          text: `SELECT reservation_id,multipart_upload_id FROM media_upload_reservations
          WHERE media_kind='video' AND state IN ('issued','claimed')
            AND expires_at<=clock_timestamp() AND multipart_manifest IS NULL
            AND multipart_completed_at IS NULL AND multipart_aborted_at IS NULL
          ORDER BY expires_at,reservation_id LIMIT $1`,
          values: [limit],
          readonly: true,
        })).rows;
      }),
    );
    let aborted = 0;
    let failed = 0;
    for (const candidate of candidates) {
      try {
        const didAbort = await run(
          Effect.gen(function* () {
            const db = yield* ControlPlaneDb;
            return yield* db.withTransaction((tx) =>
              Effect.gen(function* () {
                const found = yield* tx.execute<Candidate>({
                  label: "video-reservation.cleanup-lock",
                  text: `SELECT reservation_id,multipart_upload_id FROM media_upload_reservations
                WHERE reservation_id=$1 AND media_kind='video' AND state IN ('issued','claimed')
                  AND expires_at<=clock_timestamp() AND multipart_manifest IS NULL
                  AND multipart_completed_at IS NULL AND multipart_aborted_at IS NULL
                FOR UPDATE SKIP LOCKED`,
                  values: [candidate.reservation_id],
                  readonly: false,
                });
                const row = found.rows[0];
                if (row === undefined) return false;
                yield* Effect.tryPromise(() =>
                  bucket
                    .resumeMultipartUpload(
                      videoIngressObjectKey(row.reservation_id),
                      row.multipart_upload_id,
                    )
                    .abort(),
                ).pipe(Effect.timeout("5 seconds"));
                yield* tx.execute({
                  label: "video-reservation.cleanup-complete",
                  text: `UPDATE media_upload_reservations SET state='expired',
                multipart_aborted_at=clock_timestamp(),updated_at=clock_timestamp()
                WHERE reservation_id=$1`,
                  values: [row.reservation_id],
                  readonly: false,
                });
                return true;
              }),
            );
          }),
        );
        if (didAbort) aborted += 1;
      } catch {
        failed += 1;
      }
    }
    return { selected: candidates.length, aborted, failed };
  };
}
