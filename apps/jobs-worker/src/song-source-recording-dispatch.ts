import type { ControlPlaneDb, ControlPlaneError } from "@pirate/application";
import type { SongSourceRecordingQueueMessage } from "@pirate/platform-cf/song-source-recording-consumer";
import { makeSongSourceRecordingRepository } from "@pirate/platform-cf/song-source-recording-repository";
import type { Layer } from "effect";

export interface SongSourceRecordingDispatchQueue {
  readonly send: (message: SongSourceRecordingQueueMessage) => Promise<void>;
}

export async function dispatchSongSourceRecordings(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  queue: SongSourceRecordingDispatchQueue,
  limit = 25,
): Promise<Readonly<{ selected: number; sent: number; failed: number }>> {
  const ids = await makeSongSourceRecordingRepository(runtime).listEligible(limit);
  const deliveries = await Promise.allSettled(
    ids.map((registrationId) =>
      queue.send({ kind: "song_source_recording", registration_id: registrationId }),
    ),
  );
  const sent = deliveries.filter((delivery) => delivery.status === "fulfilled").length;
  return { selected: ids.length, sent, failed: ids.length - sent };
}
