// PRIVATE implementation proposal. No producer composition or runtime grant.
import {
  ControlPlaneAcquireFailed,
  type ControlPlaneError,
  ControlPlaneOperationTimedOut,
  ControlPlaneStatementFailed,
  ControlPlaneTransactionOutcomeUnknown,
} from "@pirate/application";
import type { LearnerAudioUploadCapture } from "@pirate/application/learner-audio-capture";
import { LearnerAudioStorageOutcomeUnknown } from "@pirate/application/learner-audio-io-outcome";
import type { StudyAudioArchiveResult } from "@pirate/application/study-v2-service";
import { Data, Effect } from "effect";

export type { LearnerAudioUploadCapture } from "@pirate/application/learner-audio-capture";
export class LearnerAudioCaptureRejected extends Data.TaggedError("LearnerAudioCaptureRejected")<{
  readonly reason: "capture-mismatch" | "deletion-in-progress";
}> {}
export type LearnerAudioIoFailure =
  | ControlPlaneError
  | LearnerAudioCaptureRejected
  | LearnerAudioStorageOutcomeUnknown;
export type CapturedUploadDisposition =
  | Readonly<{ state: "write" }>
  | Readonly<{ state: "stored"; objectRef: string }>
  | Readonly<{ state: "failed" }>
  | Readonly<{ state: "unknown" }>;
export interface CapturedLearnerAudioUploadStore {
  /** All effects finish a short committed transaction before returning. */
  readonly claim: (
    capture: LearnerAudioUploadCapture,
  ) => Effect.Effect<CapturedUploadDisposition, ControlPlaneError | LearnerAudioCaptureRejected>;
  readonly mayContinue: (
    capture: LearnerAudioUploadCapture,
  ) => Effect.Effect<boolean, ControlPlaneError | LearnerAudioCaptureRejected>;
  readonly noteMultipartId: (
    capture: LearnerAudioUploadCapture,
    multipartId: string,
  ) => Effect.Effect<void, ControlPlaneError | LearnerAudioCaptureRejected>;
  readonly settle: (
    input: Readonly<{
      capture: LearnerAudioUploadCapture;
      disposition: "stored" | "absent" | "failed";
      knownNoMoreIo: boolean;
      multipartId: string | null;
      terminalFact?: Readonly<{
        contentDigest: string;
        contentType: string;
        byteSize: number;
        durationMs: number;
      }>;
    }>,
  ) => Effect.Effect<boolean, ControlPlaneError | LearnerAudioCaptureRejected>;
}
export interface CapturedStudyAudioBucket {
  readonly put: (
    key: string,
    bytes: Uint8Array,
    options: Readonly<{
      httpMetadata: Readonly<{ contentType: string }>;
      customMetadata: Readonly<Record<string, string>>;
    }>,
  ) => Promise<Readonly<{ size: number }>>;
}
const unknown = (capture: LearnerAudioUploadCapture) =>
  new LearnerAudioStorageOutcomeUnknown({ uploadAttemptId: capture.uploadAttemptId });
const rejected = () => new LearnerAudioCaptureRejected({ reason: "capture-mismatch" });
async function digest(bytes: Uint8Array): Promise<string> {
  const result = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
  return Array.from(result, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Caller holds no SQL transaction while this implementation runs. Registration
 * precedes provider invocation, and successful grading is checkpointed first.
 * retainTask is actual ctx.waitUntil/DO lifecycle binding, not a browser callback.
 * Process loss still leaves writing/unknown durable; it NEVER implies no more I/O.
 */
export const makeCapturedR2StudyAudioArchive = (
  store: CapturedLearnerAudioUploadStore,
  bucket: CapturedStudyAudioBucket,
  retainTask: (task: Promise<unknown>) => void,
) => ({
  store: Effect.fn("CapturedR2StudyAudioArchive.store")(function* (
    input: Readonly<{ capture: LearnerAudioUploadCapture; audio: Uint8Array }>,
  ): Effect.fn.Return<StudyAudioArchiveResult, LearnerAudioIoFailure> {
    const { capture } = input;
    const bytes = new Uint8Array(input.audio); // caller mutation cannot change an admitted payload
    const actualDigest = yield* Effect.tryPromise({ try: () => digest(bytes), catch: rejected });
    if (
      capture.sourceKind !== "study" ||
      capture.contentDigest !== actualDigest ||
      capture.byteSize !== bytes.byteLength
    )
      return yield* rejected();
    const claimed = yield* store.claim(capture);
    if (claimed.state === "stored")
      return { state: "stored", objectRef: claimed.objectRef } as const;
    if (claimed.state === "failed") return { state: "failed", objectRef: null } as const;
    if (claimed.state === "unknown") return yield* unknown(capture);
    // This task attaches settlement before exposing an awaitable to the caller.
    // Interrupting the caller does not manufacture a failed/absent storage fact.
    const task = (async (): Promise<StudyAudioArchiveResult> => {
      let stored: Readonly<{ size: number }>;
      try {
        stored = await bucket.put(capture.objectRef, bytes, {
          httpMetadata: { contentType: capture.contentType },
          customMetadata: {
            content_sha256: actualDigest,
            source_kind: "study",
            upload_attempt_id: capture.uploadAttemptId,
          },
        });
      } catch {
        await Effect.runPromise(
          store.settle({ capture, disposition: "failed", knownNoMoreIo: false, multipartId: null }),
        );
        throw unknown(capture);
      }
      // A fulfilled PUT is a settled writer; a size mismatch leaves real bytes
      // needing exact cleanup, rather than pretending that no object exists.
      const disposition = stored.size === bytes.byteLength ? "stored" : "failed";
      const publish = await Effect.runPromise(
        store.settle({
          capture,
          disposition,
          knownNoMoreIo: true,
          multipartId: null,
          ...(disposition === "stored" && capture.durationMs !== null
            ? {
                terminalFact: {
                  contentDigest: actualDigest,
                  contentType: capture.contentType,
                  byteSize: bytes.byteLength,
                  durationMs: capture.durationMs,
                },
              }
            : {}),
        }),
      );
      return publish
        ? { state: "stored", objectRef: capture.objectRef }
        : { state: "failed", objectRef: null };
    })();
    retainTask(
      task.then(
        () => undefined,
        () => undefined,
      ),
    ); // no private error object in background logs
    return yield* Effect.tryPromise({
      try: () => task,
      catch: (error) =>
        error instanceof LearnerAudioCaptureRejected ||
        error instanceof LearnerAudioStorageOutcomeUnknown ||
        error instanceof ControlPlaneAcquireFailed ||
        error instanceof ControlPlaneOperationTimedOut ||
        error instanceof ControlPlaneStatementFailed ||
        error instanceof ControlPlaneTransactionOutcomeUnknown
          ? error
          : unknown(capture),
    });
  }),
});

/** A DO adapter calls this before EACH create/part/complete, after immutable
 * capture is persisted locally and in PostgreSQL. False fences only archive
 * producers, not scoring or the independent operator-reset authority.
 */
export const requireCapturedMultipartContinuation = Effect.fn(
  "requireCapturedMultipartContinuation",
)(function* (store: CapturedLearnerAudioUploadStore, capture: LearnerAudioUploadCapture) {
  if (!(yield* store.mayContinue(capture)))
    return yield* new LearnerAudioCaptureRejected({ reason: "deletion-in-progress" });
});
