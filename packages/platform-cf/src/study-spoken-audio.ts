import {
  type StudyAudioArchive,
  type StudyBatchTranscriber,
  type StudyBatchTranscript,
  StudyBatchTranscriptionFailed,
} from "@pirate/application";
import { Effect } from "effect";

export const ELEVENLABS_STUDY_BATCH_ENDPOINT =
  "https://api.elevenlabs.io/v1/speech-to-text?enable_logging=false" as const;
export const ELEVENLABS_STUDY_BATCH_MODEL = "scribe_v2" as const;
export const ELEVENLABS_STUDY_BATCH_ADAPTER_REVISION =
  "elevenlabs_study_batch_scribe_v2@1" as const;

const MAX_RESPONSE_BYTES = 65_536;
const MAX_TRANSCRIPT_LENGTH = 4_096;
const TIMEOUT_MS = 20_000;

export type StudyBatchFetch = (input: string, init: RequestInit) => Promise<Response>;

const failure = (reason: StudyBatchTranscriptionFailed["reason"]) =>
  new StudyBatchTranscriptionFailed({ reason });

async function readBoundedText(response: Response): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_RESPONSE_BYTES) throw failure("invalid-response");
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw failure("invalid-response");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
}

function decodeTranscript(value: unknown): StudyBatchTranscript {
  if (typeof value !== "object" || value === null) throw failure("invalid-response");
  const body = value as Record<string, unknown>;
  if (typeof body.text !== "string" || body.text.length > MAX_TRANSCRIPT_LENGTH) {
    throw failure("invalid-response");
  }
  const detectedLanguage =
    body.language_code === null || body.language_code === undefined
      ? null
      : typeof body.language_code === "string" && body.language_code.length <= 35
        ? body.language_code
        : undefined;
  const confidence =
    body.language_probability === null || body.language_probability === undefined
      ? null
      : typeof body.language_probability === "number" &&
          Number.isFinite(body.language_probability) &&
          body.language_probability >= 0 &&
          body.language_probability <= 1
        ? body.language_probability
        : undefined;
  if (detectedLanguage === undefined || confidence === undefined) {
    throw failure("invalid-response");
  }
  return {
    transcript: body.text,
    detectedLanguage,
    detectedLanguageConfidence: confidence,
  };
}

export function makeElevenLabsStudyBatchTranscriber(
  options: Readonly<{
    apiKey: string;
    fetch?: StudyBatchFetch;
    timeoutMs?: number;
  }>,
): StudyBatchTranscriber {
  const fetchImpl = options.fetch ?? fetch;
  const apiKey = options.apiKey;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  return {
    transcribe: ({ audio, contentType, languageHint }) =>
      Effect.tryPromise({
        try: async () => {
          if (apiKey.length === 0 || apiKey.trim() !== apiKey) throw failure("misconfigured");
          const form = new FormData();
          form.append("file", new Blob([new Uint8Array(audio)], { type: contentType }), "answer");
          form.append("model_id", ELEVENLABS_STUDY_BATCH_MODEL);
          form.append("tag_audio_events", "false");
          form.append("diarize", "false");
          form.append("timestamps_granularity", "none");
          if (languageHint !== null)
            form.append("language_code", languageHint.split("-", 1)[0] ?? languageHint);
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), timeoutMs);
          let response: Response;
          try {
            response = await fetchImpl(ELEVENLABS_STUDY_BATCH_ENDPOINT, {
              method: "POST",
              headers: { "xi-api-key": apiKey },
              body: form,
              signal: controller.signal,
            });
          } catch (error) {
            if (controller.signal.aborted) throw failure("timeout");
            throw error;
          } finally {
            clearTimeout(timeout);
          }
          if (response.status === 429) throw failure("rate-limited");
          if (!response.ok) throw failure("unavailable");
          const text = await readBoundedText(response);
          try {
            return decodeTranscript(JSON.parse(text) as unknown);
          } catch (error) {
            if (error instanceof StudyBatchTranscriptionFailed) throw error;
            throw failure("invalid-response");
          }
        },
        catch: (error) =>
          error instanceof StudyBatchTranscriptionFailed ? error : failure("unavailable"),
      }),
  };
}

export function makeFakeStudyBatchTranscriber(
  transcript: StudyBatchTranscript,
): StudyBatchTranscriber {
  return { transcribe: () => Effect.succeed(transcript) };
}

export interface StudyAudioBucket {
  readonly put: (
    key: string,
    value: Uint8Array,
    options: Readonly<{
      httpMetadata: Readonly<{ contentType: string }>;
      customMetadata: Readonly<Record<string, string>>;
    }>,
  ) => Promise<Readonly<{ size: number }>>;
}

export function makeR2StudyAudioArchive(bucket: StudyAudioBucket | undefined): StudyAudioArchive {
  return {
    store: ({ attemptRef, audio, contentType, contentDigest }) =>
      Effect.promise(async () => {
        if (bucket === undefined) return { state: "failed", objectRef: null } as const;
        const objectRef = `learner-audio/study/${attemptRef}/${contentDigest}`;
        try {
          const stored = await bucket.put(objectRef, audio, {
            httpMetadata: { contentType },
            customMetadata: {
              content_sha256: contentDigest,
              source_kind: "study",
            },
          });
          return stored.size === audio.byteLength
            ? ({ state: "stored", objectRef } as const)
            : ({ state: "failed", objectRef: null } as const);
        } catch {
          return { state: "failed", objectRef: null } as const;
        }
      }),
  };
}
