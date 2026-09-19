import type { StudyBatchTranscriber, StudyBatchTranscript } from "@pirate/application";
import { StudyBatchTranscriptionFailed } from "@pirate/application";
import { Effect } from "effect";

/**
 * Scripted Study batch transcriber for the local harness.
 *
 * The production composition accepts `study_batch_transcriber` as a dependency,
 * and `makeFakeStudyBatchTranscriber` already exists. This wraps that seam with
 * a queue so each browser case can arm the exact transcript (or provider
 * failure) the real grading path must consume. Grading, persistence and
 * completion remain the production implementations.
 */
export type StudyTranscriptScript = Readonly<{
  readonly transcript: string;
  readonly detectedLanguage?: string | null;
  readonly detectedLanguageConfidence?: number | null;
  readonly failure?: StudyBatchTranscriptionFailed["reason"];
}>;

export type StudyTranscriberCall = Readonly<{
  readonly byteLength: number;
  readonly contentType: string;
  readonly languageHint: string | null;
  readonly transcript: string;
  readonly failure: string | null;
  readonly at: string;
}>;

export class ScriptedStudyTranscriber implements StudyBatchTranscriber {
  readonly providerRetention = "not_stored" as const;
  readonly calls: StudyTranscriberCall[] = [];

  private queue: StudyTranscriptScript[] = [];
  private fallback: StudyTranscriptScript = { transcript: "" };

  arm(script: StudyTranscriptScript): void {
    this.queue.push(script);
  }

  armSequence(scripts: readonly StudyTranscriptScript[]): void {
    this.queue.push(...scripts);
  }

  setFallback(script: StudyTranscriptScript): void {
    this.fallback = script;
  }

  reset(): void {
    this.queue = [];
    this.fallback = { transcript: "" };
    this.calls.length = 0;
  }

  readonly transcribe = (input: {
    readonly audio: Uint8Array;
    readonly contentType: string;
    readonly languageHint: string | null;
  }): Effect.Effect<StudyBatchTranscript, StudyBatchTranscriptionFailed> => {
    const script = this.queue.shift() ?? this.fallback;
    this.calls.push({
      byteLength: input.audio.byteLength,
      contentType: input.contentType,
      languageHint: input.languageHint,
      transcript: script.transcript,
      failure: script.failure ?? null,
      at: new Date().toISOString(),
    });
    if (script.failure !== undefined) {
      return Effect.fail(new StudyBatchTranscriptionFailed({ reason: script.failure }));
    }
    return Effect.succeed({
      transcript: script.transcript,
      detectedLanguage: script.detectedLanguage ?? null,
      detectedLanguageConfidence: script.detectedLanguageConfidence ?? null,
    });
  };
}
