/// <reference types="@cloudflare/vitest-pool-workers/types" />
// Real DO/Workerd SQLite/R2 and production capture bindings, ledger and archive.
// Only PostgreSQL is substituted at its finite typed client boundary. This is
// not native capture authority, role admission or a PostgreSQL integration test.
import type { KaraokeSessionAuthority } from "@pirate/application";
import { Effect } from "effect";
import { expect } from "vitest";
import { makeCapturedKaraokeBindings } from "../../packages/platform-cf/src/captured-karaoke-bindings.ts";
import {
  type CapturedKaraokeMultipart,
  CapturedKaraokeMultipartArchive,
  type CapturedKaraokeMultipartBucket,
} from "../../packages/platform-cf/src/captured-karaoke-multipart.ts";
import { makeCapturedKaraokeSqliteJournal } from "../../packages/platform-cf/src/captured-karaoke-sqlite-journal.ts";
import type { KaraokeAttemptDO } from "../../packages/platform-cf/src/karaoke-attempt-do.ts";
import type { LearnerAudioUploadCapture } from "../../packages/platform-cf/src/learner-audio-captured-io.ts";
import {
  makeDirectPostgresControlPlaneLayer,
  type PostgresClientLike,
} from "../../packages/platform-cf/src/postgres.ts";

const fixtureKey = "workerdCapturedKaraokeAttemptFixture";
export function installKaraokeAttemptCaptureFixture(
  object: KaraokeAttemptDO,
  state: DurableObjectState,
  bucket: R2Bucket,
  authority: KaraokeSessionAuthority,
): void {
  if (Reflect.has(object, fixtureKey)) throw new Error("capture fixture already installed");
  const capture: LearnerAudioUploadCapture = {
    uploadAttemptId: `upload-${authority.sessionId}`,
    sourceOwnerId: `owner-${authority.accountId}`,
    artifactId: authority.artifactId,
    sourceKind: "karaoke",
    attemptRef: authority.attemptId,
    commandRef: authority.sessionId,
    reservationRef: authority.sessionId,
    capturedRevision: 0,
    objectRef: `karaoke/${authority.accountId}/${authority.attemptId}.pcm`,
    contentDigest: null,
    contentType: "audio/L16;rate=16000;channels=1",
    byteSize: null,
    durationMs: null,
  };
  type NativeState = {
    ioState: "registered" | "writing" | "unknown" | "closed";
    storageDisposition: "stored" | "absent" | "failed" | null;
    multipartId: string | null;
    fenced: boolean;
  };
  let native: NativeState = {
    ioState: "registered",
    storageDisposition: null,
    multipartId: null,
    fenced: false,
  };
  let staged: NativeState | null = null;
  let inTransaction = false;
  let deletionAuthorized = false;
  let captureReads = 0;
  let aborts = 0;
  let deletes = 0;
  const client: PostgresClientLike = {
    connect: async () => {},
    end: async () => {
      staged = null;
      inTransaction = false;
    },
    query: async ({ text, values = [] }) => {
      if (text === "BEGIN") {
        expect(inTransaction).toBe(false);
        inTransaction = true;
        staged = { ...native };
        return { rows: [], rowCount: 0 };
      }
      if (text === "COMMIT") {
        expect(inTransaction).toBe(true);
        if (staged === null) throw new Error("missing finite transaction");
        native = staged;
        staged = null;
        inTransaction = false;
        return { rows: [], rowCount: 0 };
      }
      if (text === "ROLLBACK") {
        staged = null;
        inTransaction = false;
        return { rows: [], rowCount: 0 };
      }
      if (text.startsWith("SELECT set_config")) return { rows: [], rowCount: 1 };
      if (text.startsWith("SELECT current_setting"))
        return {
          rows: [{ transaction: "3s", lock: "250ms", statement: "2s", idle: "2s" }],
          rowCount: 1,
        };
      expect(inTransaction).toBe(true);
      if (staged === null) throw new Error("missing finite controlled transaction");
      if (text.includes("read_account_karaoke_audio_capture_private_v1")) {
        expect(values).toEqual([
          authority.accountId,
          authority.sessionId,
          authority.attemptId,
          authority.artifactId,
        ]);
        captureReads++;
        expect(captureReads).toBe(1);
        return { rows: [{ result: capture }], rowCount: 1 };
      }
      if (text.includes("require_captured_learner_audio_private_v1")) {
        expect(values).toEqual([JSON.stringify(capture)]);
        return { rows: [{ result: capture.uploadAttemptId }], rowCount: 1 };
      }
      if (text.includes("claim_captured_learner_audio_private_v1")) {
        expect(values).toEqual([JSON.stringify(capture)]);
        const claimed = staged.ioState === "registered" && !staged.fenced;
        if (claimed) staged.ioState = "writing";
        return {
          rows: [
            {
              result: {
                capture,
                ioState: staged.ioState,
                storageDisposition: staged.storageDisposition,
                cleanupRequired: staged.fenced,
                mayPublish:
                  staged.ioState === "closed" &&
                  staged.storageDisposition === "stored" &&
                  !staged.fenced,
                mayContinue: staged.ioState === "writing" && !staged.fenced,
                claimed,
              },
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes("continue_captured_learner_audio_private_v1")) {
        expect(values).toEqual([JSON.stringify(capture)]);
        return { rows: [{ result: staged.ioState === "writing" && !staged.fenced }], rowCount: 1 };
      }
      if (text.includes("note_learner_audio_multipart_id_private_v1")) {
        expect(values[0]).toBe(capture.uploadAttemptId);
        const id = values[1];
        if (typeof id !== "string" || id.length === 0)
          throw new Error("missing actual R2 multipart ID");
        expect(staged.multipartId === null || staged.multipartId === id).toBe(true);
        staged.multipartId = id;
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("settle_learner_audio_terminal_fact_private_v1")) {
        expect(values[0]).toBe(capture.uploadAttemptId);
        expect(values[3]).toBe(staged.multipartId);
        if (values[2] === true) {
          const disposition = values[1];
          if (disposition !== "stored" && disposition !== "absent" && disposition !== "failed")
            throw new Error("unexpected terminal disposition");
          staged.ioState = "closed";
          staged.storageDisposition = disposition;
        } else {
          staged.ioState = "unknown";
          staged.storageDisposition = null;
        }
        return {
          rows: [{ result: staged.storageDisposition === "stored" && !staged.fenced }],
          rowCount: 1,
        };
      }
      if (text.includes("close_unclaimed_learner_audio_private_v1")) {
        expect(values).toEqual([capture.uploadAttemptId]);
        const closed = staged.ioState === "registered" && staged.multipartId === null;
        if (closed) {
          staged.ioState = "closed";
          staged.storageDisposition = "absent";
        }
        return { rows: [{ result: closed }], rowCount: 1 };
      }
      if (text.includes("require_captured_audio_deletion_stop_private_v1")) {
        expect(values).toEqual([JSON.stringify(capture)]);
        if (!deletionAuthorized) throw new Error("finite deletion authority not selected");
        staged.fenced = true;
        return { rows: [], rowCount: 1 };
      }
      throw new Error("unmodeled finite capture statement");
    },
  };
  const runtime = makeDirectPostgresControlPlaneLayer("postgres://finite.invalid/workerd-karaoke", {
    clientFactory: () => client,
    logger: { info: () => {}, error: () => {} },
  });
  const outsideSql = (key: string) => {
    expect(inTransaction).toBe(false);
    expect(key).toBe(capture.objectRef);
  };
  const multipart = (key: string, upload: R2MultipartUpload): CapturedKaraokeMultipart => ({
    uploadId: upload.uploadId,
    uploadPart: async (number, bytes) => {
      outsideSql(key);
      return await upload.uploadPart(number, bytes);
    },
    complete: async (parts) => {
      outsideSql(key);
      return await upload.complete(parts);
    },
    abort: async () => {
      outsideSql(key);
      await upload.abort();
      aborts++;
    },
  });
  const capturedBucket: CapturedKaraokeMultipartBucket = {
    createMultipartUpload: async (key, options) => {
      outsideSql(key);
      return multipart(key, await bucket.createMultipartUpload(key, options));
    },
    resumeMultipartUpload: (key, id) => {
      outsideSql(key);
      expect(native.multipartId).toBe(id);
      return multipart(key, bucket.resumeMultipartUpload(key, id));
    },
    get: async (key) => {
      outsideSql(key);
      return await bucket.get(key);
    },
    delete: async (key) => {
      outsideSql(key);
      await bucket.delete(key);
      deletes++;
    },
  };
  const assertOpen = () => {
    const guard: unknown = Reflect.get(object, "assertNotResetFenced");
    if (typeof guard !== "function") throw new Error("missing actual reset guard");
    guard.call(object);
  };
  // Test-owned factory substitution, on this real DO instance only. initialize
  // still executes all production row/token/retention/reset logic; the actual
  // bindings/ledger/journal/archive run using the finite client and real R2.
  Reflect.set(object, "openCapturedArchive", async () => {
    assertOpen();
    const saved = state.storage.sql
      .exec<{ authority_json: string }>("SELECT authority_json FROM karaoke_session WHERE id=1")
      .one();
    expect(JSON.parse(saved.authority_json)).toEqual(authority);
    const binding = await Effect.runPromise(makeCapturedKaraokeBindings(runtime, authority));
    assertOpen();
    const journal = makeCapturedKaraokeSqliteJournal(
      {
        sql: state.storage.sql,
        transactionSync: (use) => state.storage.transactionSync(use),
      },
      binding.capture,
    );
    return new CapturedKaraokeMultipartArchive(
      journal,
      binding.ledger,
      capturedBucket,
      binding.authorizeDeletionStop,
      binding.cancelUnclaimed,
      assertOpen,
    );
  });
  Reflect.set(object, fixtureKey, {
    authorizeDeletion: () => {
      deletionAuthorized = true;
    },
    assertDeleted: () => {
      expect(aborts).toBe(1);
      expect(deletes).toBe(1);
      expect(native).toMatchObject({
        ioState: "closed",
        storageDisposition: "absent",
        fenced: true,
      });
      expect(inTransaction).toBe(false);
    },
  });
}
export async function deleteKaraokeAttemptCaptureFixture(object: KaraokeAttemptDO): Promise<void> {
  const fixture: unknown = Reflect.get(object, fixtureKey);
  if (typeof fixture !== "object" || fixture === null) throw new Error("missing capture fixture");
  const authorize: unknown = Reflect.get(fixture, "authorizeDeletion");
  const assertDeleted: unknown = Reflect.get(fixture, "assertDeleted");
  if (typeof authorize !== "function" || typeof assertDeleted !== "function")
    throw new Error("missing capture fixture deletion authority");
  authorize();
  await object.stopCapturedAudioForDeletion();
  assertDeleted();
}
export function recordDefiniteKaraokeFailureFixture(object: KaraokeAttemptDO): void {
  const record: unknown = Reflect.get(object, "recordFinalizationFailure");
  if (typeof record !== "function") throw new Error("missing actual finalization transition");
  // This tests the real local transition with definite failure, not a native
  // ControlPlane/unknown result falsely classified as safe to exhaust.
  record.call(object, "score", Date.now(), false);
  record.call(object, "recording", Date.now(), false);
}
