import {
  advanceSongSourceRecordingAuthority,
  type SongSourceRecordingWorkflowDependencies,
} from "@pirate/application/media/source-recording-authority";
import type { SongSourceRecordingRepository } from "./song-source-recording-repository.ts";

export type SongSourceRecordingQueueMessage = Readonly<{
  kind: "song_source_recording";
  registration_id: string;
}>;

export type SongSourceRecordingConsumerDependencies = Readonly<{
  repository: SongSourceRecordingRepository;
  workflow: Omit<SongSourceRecordingWorkflowDependencies, "store">;
  leaseSeconds: number;
}>;

function message(value: unknown): SongSourceRecordingQueueMessage | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    record.kind !== "song_source_recording" ||
    typeof record.registration_id !== "string" ||
    record.registration_id.length < 1 ||
    record.registration_id.length > 512
  ) {
    return null;
  }
  return { kind: record.kind, registration_id: record.registration_id };
}

export async function consumeSongSourceRecording(
  value: unknown,
  dependencies: SongSourceRecordingConsumerDependencies,
): Promise<"ack" | "retry" | "dlq"> {
  const parsed = message(value);
  if (parsed === null) return "dlq";
  if (!dependencies.workflow.enabled) return "ack";
  try {
    const claimed = await dependencies.repository.claim(
      parsed.registration_id,
      dependencies.workflow.workerId,
      dependencies.leaseSeconds,
    );
    if (claimed === null) return "ack";
    await advanceSongSourceRecordingAuthority(
      { ...dependencies.workflow, store: dependencies.repository },
      claimed.registrationId,
    );
    return "ack";
  } catch {
    return "retry";
  }
}
