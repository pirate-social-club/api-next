/// <reference types="@cloudflare/vitest-pool-workers/types" />
// Real Workerd SQLite and production binding/journal/multipart/ledger; native
// PostgreSQL authority alone is replaced at the finite typed driver boundary.

import type { KaraokeSessionAuthority } from "@pirate/application";
import { Effect } from "effect";
import { expect } from "vitest";
import { makeCapturedKaraokeBindings } from "../../packages/platform-cf/src/captured-karaoke-bindings.ts";
import {
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

export type Settlement<A> =
  | Readonly<{ ok: true; value: A }>
  | Readonly<{ ok: false; error: unknown }>;
export const handled = <A>(task: Promise<A>): Promise<Settlement<A>> =>
  task.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );
export const bounded = <A>(task: Promise<A>, label: string): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`finite Workerd fixture deadline: ${label}`)), 2000);
  });
  return Promise.race([task, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
};
export const succeeded = <A>(outcome: Settlement<A>): A => {
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
};
export const enteredOrSettled = <A>(
  entry: Promise<void>,
  settled: Promise<Settlement<A>>,
  label: string,
) =>
  bounded(
    Promise.race([
      entry,
      settled.then((outcome) => {
        if (!outcome.ok) throw outcome.error;
        throw new Error(`producer settled before entry: ${label}`);
      }),
    ]),
    label,
  );
export const finishArchive = (object: KaraokeAttemptDO): Promise<unknown> => {
  const finish: unknown = Reflect.get(object, "finishArchive");
  if (typeof finish !== "function") throw new Error("missing_archive_producer");
  const result: unknown = finish.call(object);
  if (!(result instanceof Promise)) throw new Error("unexpected_archive_producer_return");
  return result;
};
const capture: LearnerAudioUploadCapture = {
  uploadAttemptId: "upload-workerd-original",
  sourceOwnerId: "owner-workerd-original",
  artifactId: "artifact-workerd-original",
  sourceKind: "karaoke",
  attemptRef: "attempt-workerd-original",
  commandRef: "session-workerd-original",
  reservationRef: "session-workerd-original",
  capturedRevision: 0,
  objectRef: "karaoke/account-workerd-original/attempt-workerd-original.pcm",
  contentDigest: null,
  contentType: "audio/L16;rate=16000;channels=1",
  byteSize: null,
  durationMs: null,
};
const authority: KaraokeSessionAuthority = {
  accountId: "account-workerd-original",
  artifactId: capture.artifactId,
  attemptId: capture.attemptRef,
  audioRevision: 1,
  communityId: "community-workerd-original",
  createdAt: "2026-10-13T00:00:00.000Z",
  expiresAt: "2050-10-13T00:30:00.000Z",
  karaokeRevisionId: "revision-workerd-original",
  lines: [
    {
      id: "line-workerd-original",
      index: 0,
      kind: "lyric",
      text: "Hold on",
      start_ms: 0,
      end_ms: 1000,
      words: [
        { text: "Hold", start_ms: 0, end_ms: 400 },
        { text: "on", start_ms: 500, end_ms: 1000 },
      ],
    },
  ],
  lyricsRevision: 1,
  personaId: "persona-workerd-original",
  playbackKind: "instrumental",
  postId: "post-workerd-original",
  qualificationPolicyVersionId: "karaoke_qualification_v2@1",
  requestHash: "a".repeat(64),
  scoringModel: "scribe_v2_realtime",
  scoringProvider: "elevenlabs",
  scoringVersion: 5,
  sessionId: capture.commandRef,
  timezone: "UTC",
};
export async function admitCapturedArchiveFixture(
  object: KaraokeAttemptDO,
  state: DurableObjectState,
  bucket: CapturedKaraokeMultipartBucket,
) {
  type NativeState = {
    ioState: "registered" | "writing" | "closed";
    multipartId: string | null;
    storageDisposition: "stored" | null;
  };
  let native: NativeState = { ioState: "registered", multipartId: null, storageDisposition: null },
    staged: NativeState | null = null,
    inTransaction = false;
  const nativeCalls: string[] = [],
    facts: unknown[] = [];
  const client: PostgresClientLike = {
    connect: async () => {},
    end: async () => {
      inTransaction = false;
      staged = null;
    },
    query: async ({ text, values = [] }) => {
      nativeCalls.push(text);
      if (text === "BEGIN") {
        expect(inTransaction).toBe(false);
        inTransaction = true;
        staged = { ...native };
        return { rows: [], rowCount: 0 };
      }
      if (text === "COMMIT") {
        if (staged !== null) native = staged;
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
      if (staged === null) throw new Error("finite native transaction missing");
      if (text.includes("read_account_karaoke_audio_capture_private_v1")) {
        expect(values).toEqual([
          authority.accountId,
          authority.sessionId,
          authority.attemptId,
          authority.artifactId,
        ]);
        return { rows: [{ result: capture }], rowCount: 1 };
      }
      if (text.includes("require_captured_learner_audio_private_v1")) {
        expect(values[0]).toBe(JSON.stringify(capture));
        return { rows: [{ result: capture.uploadAttemptId }], rowCount: 1 };
      }
      if (text.includes("claim_captured_learner_audio_private_v1")) {
        expect(values[0]).toBe(JSON.stringify(capture));
        const claimed = staged.ioState === "registered";
        if (claimed) staged.ioState = "writing";
        return {
          rows: [
            {
              result: {
                capture,
                ioState: staged.ioState,
                storageDisposition: staged.storageDisposition,
                cleanupRequired: false,
                mayPublish: staged.ioState === "closed" && staged.storageDisposition === "stored",
                mayContinue: staged.ioState === "writing",
                claimed,
              },
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes("continue_captured_learner_audio_private_v1")) {
        expect(values[0]).toBe(JSON.stringify(capture));
        return { rows: [{ result: staged.ioState === "writing" }], rowCount: 1 };
      }
      if (text.includes("note_learner_audio_multipart_id_private_v1")) {
        expect(values).toEqual([capture.uploadAttemptId, "late-upload-id"]);
        expect(staged.multipartId === null || staged.multipartId === values[1]).toBe(true);
        staged.multipartId = "late-upload-id";
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("settle_learner_audio_terminal_fact_private_v1")) {
        expect(values.slice(0, 4)).toEqual([
          capture.uploadAttemptId,
          "stored",
          true,
          "late-upload-id",
        ]);
        staged.ioState = "closed";
        staged.storageDisposition = "stored";
        facts.push(values[4]);
        return { rows: [{ result: true }], rowCount: 1 };
      }
      throw new Error("unexpected finite native statement");
    },
  };
  const runtime = makeDirectPostgresControlPlaneLayer("postgres://finite.invalid/workerd-reset", {
    clientFactory: () => client,
    logger: { info: () => {}, error: () => {} },
  });
  const binding = await Effect.runPromise(makeCapturedKaraokeBindings(runtime, authority));
  state.storage.sql.exec(
    `INSERT INTO karaoke_archive(id,upload_id,object_key,next_part,parts_json,byte_size,duration_ms,state)
 VALUES(1,NULL,?,1,'[]',2,1,'pending')`,
    binding.capture.objectRef,
  );
  state.storage.sql.exec(
    "INSERT INTO karaoke_audio_chunk VALUES(1,?,2)",
    new Uint8Array([0, 0]).buffer,
  );
  const journal = makeCapturedKaraokeSqliteJournal(
    { sql: state.storage.sql, transactionSync: (use) => state.storage.transactionSync(use) },
    binding.capture,
  );
  const assertOpen = () => {
    const guard: unknown = Reflect.get(object, "assertNotResetFenced");
    if (typeof guard !== "function") throw new Error("missing_real_reset_guard");
    guard.call(object);
  };
  const archive = new CapturedKaraokeMultipartArchive(
    journal,
    binding.ledger,
    bucket,
    binding.authorizeDeletionStop,
    binding.cancelUnclaimed,
    assertOpen,
  );
  // Finite test-only substitution of a pre-admitted captured producer. This
  // never installs a runtime hook or grants a native authority in product code.
  Reflect.set(object, "capturedAudio", archive);
  return {
    journal,
    nativeCalls,
    facts,
    nativeState: () => ({ ...native }),
    inTransaction: () => inTransaction,
  };
}
