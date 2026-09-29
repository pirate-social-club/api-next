import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import { Effect, type Layer } from "effect";

export async function dispatchSongPcmAdmissions(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  queue: Readonly<{
    send: (
      message: Readonly<{ kind: "song_pcm_admission"; admission_id: string }>,
    ) => Promise<void>;
  }>,
) {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* ControlPlaneDb;
      return yield* db.execute<{ admission_id: string }>({
        label: "song-pcm-admission.dispatch",
        readonly: true,
        values: [],
        text: `SELECT admission_id FROM media_song_video_pcm_admissions
        WHERE cleanup_completed_at IS NULL AND (claim_until IS NULL OR claim_until <= clock_timestamp())
          AND EXISTS (SELECT 1 FROM media_song_video_pcm_admission_policy WHERE enabled)
        ORDER BY requested_at LIMIT 25`,
      });
    }).pipe(Effect.provide(runtime)),
  );
  const deliveries = await Promise.allSettled(
    result.rows.map((row) =>
      queue.send({ kind: "song_pcm_admission", admission_id: row.admission_id }),
    ),
  );
  const sent = deliveries.filter((d) => d.status === "fulfilled").length;
  return { selected: result.rows.length, sent, failed: result.rows.length - sent };
}
