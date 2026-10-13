// Platform producer implementation; all remote calls occur after short SQL.

import { createHash } from "node:crypto";
import { LearnerAudioStorageOutcomeUnknown } from "@pirate/application/learner-audio-io-outcome";
import { Effect } from "effect";
import {
  type CapturedLearnerAudioUploadStore,
  LearnerAudioCaptureRejected,
  type LearnerAudioUploadCapture,
} from "./learner-audio-captured-io.ts";
export type CapturedKaraokePart = Readonly<{ partNumber: number; etag: string }>;
export type CapturedKaraokeStored = Readonly<{
  state: "stored";
  objectRef: string;
  contentSha256: string;
  byteSize: number;
  durationMs: number;
}>;
export interface CapturedKaraokeMultipartBucket {
  createMultipartUpload: (
    key: string,
    options: Readonly<{
      httpMetadata: Readonly<{ contentType: string }>;
      customMetadata: Readonly<Record<string, string>>;
    }>,
  ) => Promise<CapturedKaraokeMultipart>;
  resumeMultipartUpload: (key: string, id: string) => CapturedKaraokeMultipart;
  get: (
    key: string,
  ) => Promise<Readonly<{ body: ReadableStream<Uint8Array>; size: number }> | null>;
  delete: (key: string) => Promise<void>;
}
export interface CapturedKaraokeMultipart {
  uploadId: string;
  uploadPart: (number: number, bytes: Uint8Array) => Promise<CapturedKaraokePart>;
  complete: (parts: CapturedKaraokePart[]) => Promise<unknown>;
  abort: () => Promise<void>;
}
export type CapturedKaraokeJournal = Readonly<{
  capture: LearnerAudioUploadCapture;
  claimed: boolean;
  deletionFenced: boolean;
  multipartId: string | null;
  nextPart: number;
  parts: readonly CapturedKaraokePart[];
  inFlight: Readonly<{
    nonce: string;
    kind: "create" | "part" | "complete" | "abort" | "delete";
  }> | null;
  completed: boolean;
  result: CapturedKaraokeStored | null;
}>;
/** Each save/removeChunksThrough is a DO SQLite transaction. save checks the
 * immutable capture against its existing journal and never clears a pending
 * nonce after process loss. Chunk removal targets ONLY the snapshot prefix.
 */
export interface CapturedKaraokeJournalStore {
  load: () => CapturedKaraokeJournal;
  save: (journal: CapturedKaraokeJournal) => void;
  chunks: () => readonly Readonly<{ frameSequence: number; payload: ArrayBuffer }>[];
  savePartAndRemoveThrough: (journal: CapturedKaraokeJournal, sequence: number) => void;
  durationMs: () => number;
  clearChunksAfterClosed: () => void;
}
const unknown = (capture: LearnerAudioUploadCapture) =>
  new LearnerAudioStorageOutcomeUnknown({ uploadAttemptId: capture.uploadAttemptId });
/** Archive serialization is separate from operator reset and scoring. DO must
 * hold/retain every returned promise via ctx.waitUntil/reset producer tracking.
 * A persisted outstanding operation on restart remains unknown; liveness or an
 * expired session alone never proves it drained.
 */
export class CapturedKaraokeMultipartArchive {
  private serial: Promise<void> = Promise.resolve();
  constructor(
    private readonly journal: CapturedKaraokeJournalStore,
    private readonly ledger: CapturedLearnerAudioUploadStore,
    private readonly bucket: CapturedKaraokeMultipartBucket,
    private readonly authorizeDeletionStop: (capture: LearnerAudioUploadCapture) => Promise<void>,
    private readonly cancelUnclaimed: (capture: LearnerAudioUploadCapture) => Promise<boolean>,
    private readonly assertProducerOpen: () => void,
  ) {}
  private enqueue<A>(use: () => Promise<A>): Promise<A> {
    const task = this.serial.then(use);
    this.serial = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }
  private async allowed(): Promise<CapturedKaraokeJournal> {
    this.assertProducerOpen();
    const before = this.journal.load();
    const mayContinue = await Effect.runPromise(this.ledger.mayContinue(before.capture));
    // Operator reset is a separate authority from the native deletion fence.
    this.assertProducerOpen();
    const state = this.journal.load();
    if (state.deletionFenced || !mayContinue)
      throw new LearnerAudioCaptureRejected({ reason: "deletion-in-progress" });
    if (state.inFlight !== null) throw unknown(state.capture);
    return state;
  }
  private async invoke<A>(
    kind: NonNullable<CapturedKaraokeJournal["inFlight"]>["kind"],
    use: () => Promise<A>,
    success: (state: CapturedKaraokeJournal, value: A) => CapturedKaraokeJournal,
    persist?: (state: CapturedKaraokeJournal) => void,
  ): Promise<A> {
    this.assertProducerOpen();
    const state = this.journal.load();
    if (state.inFlight !== null) throw unknown(state.capture);
    const nonce = crypto.randomUUID();
    this.journal.save({ ...state, inFlight: { nonce, kind } });
    let value: A;
    try {
      value = await use();
    } catch {
      await Effect.runPromise(
        this.ledger.settle({
          capture: state.capture,
          disposition: "failed",
          knownNoMoreIo: false,
          multipartId: this.journal.load().multipartId,
        }),
      );
      throw unknown(state.capture);
    }
    const current = this.journal.load();
    if (current.inFlight?.nonce !== nonce) throw unknown(state.capture);
    // Late successful ID/part/completion survives a concurrently installed fence.
    const resolved = { ...success(current, value), inFlight: null };
    if (persist === undefined) this.journal.save(resolved);
    else persist(resolved);
    return value;
  }
  private async claim(): Promise<void> {
    this.assertProducerOpen();
    const state = this.journal.load();
    if (state.claimed) return;
    if (state.inFlight !== null) throw unknown(state.capture);
    const claimed = await Effect.runPromise(this.ledger.claim(state.capture));
    if (claimed.state === "write") {
      this.journal.save({ ...this.journal.load(), claimed: true });
      this.assertProducerOpen();
      return;
    }
    if (claimed.state === "unknown") throw unknown(state.capture);
    if (claimed.state === "stored" && state.result !== null) {
      this.assertProducerOpen();
      return;
    }
    throw new LearnerAudioCaptureRejected({ reason: "deletion-in-progress" });
  }
  uploadPending(final: boolean): Promise<void> {
    return this.enqueue(() => this.uploadPendingActive(final));
  }
  private async uploadPendingActive(final: boolean): Promise<void> {
    this.assertProducerOpen();
    const chunks = this.journal.chunks();
    const total = chunks.reduce((sum, item) => sum + item.payload.byteLength, 0);
    if (total === 0 || (!final && total < 5 * 1024 * 1024)) return;
    await this.claim();
    let state = await this.allowed();
    let upload: CapturedKaraokeMultipart;
    if (state.multipartId === null) {
      upload = await this.invoke(
        "create",
        () =>
          this.bucket.createMultipartUpload(state.capture.objectRef, {
            httpMetadata: { contentType: state.capture.contentType },
            customMetadata: {
              source: "karaoke_scored_pcm_v1",
              upload_attempt_id: state.capture.uploadAttemptId,
            },
          }),
        (current, value) => ({ ...current, multipartId: value.uploadId }),
      );
      // Persist the newly issued locator in both local and SQL stores even when
      // the fence arrived during CREATE. SQL uncertainty prevents any next part.
      await Effect.runPromise(this.ledger.noteMultipartId(state.capture, upload.uploadId));
    } else upload = this.bucket.resumeMultipartUpload(state.capture.objectRef, state.multipartId);
    // Every retry republishes the exact durable local locator before another
    // remote operation; a lost SQL COMMIT ACK cannot bypass ID registration.
    await Effect.runPromise(this.ledger.noteMultipartId(state.capture, upload.uploadId));
    state = await this.allowed();
    const payload = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      payload.set(new Uint8Array(chunk.payload), offset);
      offset += chunk.payload.byteLength;
    }
    const number = state.nextPart;
    const last = chunks[chunks.length - 1];
    if (last === undefined) throw unknown(state.capture);
    await this.invoke(
      "part",
      () => upload.uploadPart(number, payload),
      (current, part) => ({ ...current, nextPart: number + 1, parts: [...current.parts, part] }),
      (resolved) => this.journal.savePartAndRemoveThrough(resolved, last.frameSequence),
    );
  }
  finish(): Promise<
    CapturedKaraokeStored | Readonly<{ state: "failed"; failureKind: "multipart_aborted" }>
  > {
    return this.enqueue(async () => {
      this.assertProducerOpen();
      let state = this.journal.load();
      if (state.inFlight !== null) throw unknown(state.capture);
      if (state.result !== null) {
        const claim = await Effect.runPromise(this.ledger.claim(state.capture));
        if (claim.state === "stored") {
          this.assertProducerOpen();
          return state.result;
        }
        if (claim.state === "failed")
          throw new LearnerAudioCaptureRejected({ reason: "deletion-in-progress" });
      }
      if (!state.claimed && state.multipartId === null && this.journal.chunks().length === 0) {
        if (await this.cancelUnclaimed(state.capture)) {
          this.assertProducerOpen();
          return { state: "failed", failureKind: "multipart_aborted" } as const;
        }
        throw unknown(state.capture);
      }
      if (!state.completed) {
        await this.uploadPendingActive(true);
        state = await this.allowed();
        if (state.multipartId === null || state.parts.length === 0) throw unknown(state.capture);
        const upload = this.bucket.resumeMultipartUpload(
          state.capture.objectRef,
          state.multipartId,
        );
        await Effect.runPromise(this.ledger.noteMultipartId(state.capture, state.multipartId));
        await this.allowed();
        await this.invoke(
          "complete",
          () => upload.complete([...state.parts]),
          (current) => ({ ...current, completed: true }),
        );
      }
      // A known completed multipart has no further writer. Reads may be retried
      // without issuing another complete or provider call; no null HEAD witness.
      state = this.journal.load();
      if (!state.completed || state.inFlight !== null) throw unknown(state.capture);
      // Only the original tracked, admitted finish task reaches this known-COMPLETE
      // observation. Reset re-entry is still blocked at finish/DO admission. GET and
      // digest are observational; all mutating I/O remains producer-open guarded.
      let observed: Readonly<{ contentSha256: string; byteSize: number }>;
      try {
        const object = await this.bucket.get(state.capture.objectRef);
        if (object === null) throw unknown(state.capture);
        const reader = object.body.getReader();
        const hash = createHash("sha256");
        let size = 0;
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            hash.update(part.value);
            size += part.value.byteLength;
          }
        } finally {
          reader.releaseLock();
        }
        if (size !== object.size) throw unknown(state.capture);
        observed = { contentSha256: hash.digest("hex"), byteSize: object.size };
      } catch {
        // A missing/rejected/incomplete observational read cannot establish absent
        // storage or native failure after a known COMPLETE. Keep original facts held.
        throw unknown(state.capture);
      }
      const { contentSha256, byteSize } = observed;
      // Preserve a concurrently installed deletion fence. This actual late known
      // storage fact must be recorded before reset/publication refusal, not lost.
      const current = this.journal.load();
      const result: CapturedKaraokeStored = {
        state: "stored",
        objectRef: state.capture.objectRef,
        contentSha256,
        byteSize,
        durationMs:
          current.result === null
            ? Math.max(1, this.journal.durationMs())
            : current.result.durationMs,
      };
      this.journal.save({ ...current, result });
      const publish = await Effect.runPromise(
        this.ledger.settle({
          capture: state.capture,
          disposition: "stored",
          knownNoMoreIo: true,
          multipartId: state.multipartId,
          terminalFact: {
            contentDigest: contentSha256,
            contentType: state.capture.contentType,
            byteSize,
            durationMs: result.durationMs,
          },
        }),
      );
      this.assertProducerOpen();
      if (!publish) throw new LearnerAudioCaptureRejected({ reason: "deletion-in-progress" });
      return result;
    });
  }
  /** Exact active deletion authority first. Durable archive-only fence prevents
   * future frames from starting archive calls; it does not reset the scored host.
   * Unknown in-flight journal remains held, even if this process has no task.
   */
  stopForDeletion(): Promise<void> {
    this.assertProducerOpen();
    const state = this.journal.load();
    return this.authorizeDeletionStop(state.capture).then(() => {
      this.journal.save({ ...this.journal.load(), deletionFenced: true });
      return this.enqueue(async () => {
        const current = this.journal.load();
        if (current.inFlight !== null) throw unknown(current.capture);
        if (current.multipartId !== null && !current.completed) {
          const upload = this.bucket.resumeMultipartUpload(
            current.capture.objectRef,
            current.multipartId,
          );
          await this.invoke(
            "abort",
            () => upload.abort(),
            (row) => row,
          );
        }
        await this.invoke(
          "delete",
          () => this.bucket.delete(current.capture.objectRef),
          (row) => row,
        );
        const afterDelete = await Effect.runPromise(this.ledger.claim(current.capture));
        if (afterDelete.state === "unknown")
          await Effect.runPromise(
            this.ledger.settle({
              capture: current.capture,
              disposition: "absent",
              knownNoMoreIo: true,
              multipartId: current.multipartId,
            }),
          );
        this.journal.clearChunksAfterClosed();
        // Closed stored/failed/absent terminal facts remain immutable. The exact
        // owner deletion batch records this later external deletion independently.
      });
    });
  }
}
