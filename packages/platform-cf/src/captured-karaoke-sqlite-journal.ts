import { Schema } from "effect";
import { LearnerAudioUploadCaptureSchema } from "./learner-audio-producer-store.ts";
import type { LearnerAudioUploadCapture } from "./learner-audio-captured-io.ts";
import type {
  CapturedKaraokeJournal,
  CapturedKaraokeJournalStore,
} from "./captured-karaoke-multipart.ts";
export interface CapturedKaraokeSqlite {
  exec<A extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>>(
    query: string,
    ...bindings: readonly unknown[]
  ): { toArray(): A[] };
}
export interface CapturedKaraokeSqliteStorage {
  sql: CapturedKaraokeSqlite;
  transactionSync: <A>(use: () => A) => A;
}
const count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const Part = Schema.Struct({
  partNumber: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10000 })),
  etag: Schema.NonEmptyString,
});
const Stored = Schema.Struct({
  state: Schema.Literal("stored"),
  objectRef: Schema.NonEmptyString,
  contentSha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  byteSize: Schema.Int.check(Schema.isGreaterThan(0)),
  durationMs: Schema.Int.check(Schema.isGreaterThan(0)),
});
const InFlight = Schema.NullOr(
  Schema.Struct({
    nonce: Schema.NonEmptyString,
    kind: Schema.Literals(["create", "part", "complete", "abort", "delete"]),
  }),
);
const parse = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown) =>
  Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(
    typeof value === "string" ? JSON.parse(value) : value,
  );
const one = (sql: CapturedKaraokeSqlite, text: string, ...bindings: readonly unknown[]) => {
  const rows = sql.exec(text, ...bindings).toArray();
  if (rows.length !== 1) throw new Error("captured_karaoke_journal_missing");
  return rows[0];
};
/** Constructor after genuine POSTGRES registration, before first R2 call.
 * A retained old DO without this capture refuses conversion; root must reconcile
 * actual253 legacy unknown upload rather than minting a replacement generation.
 */
export const makeCapturedKaraokeSqliteJournal = (
  storage: CapturedKaraokeSqliteStorage,
  capture: LearnerAudioUploadCapture,
): CapturedKaraokeJournalStore => {
  const { sql } = storage;
  sql.exec(
    "CREATE TABLE IF NOT EXISTS karaoke_archive_capture (id INTEGER PRIMARY KEY CHECK(id=1),capture_json TEXT NOT NULL,claimed INTEGER NOT NULL CHECK(claimed IN(0,1)),deletion_fenced INTEGER NOT NULL CHECK(deletion_fenced IN(0,1)),inflight_json TEXT,completed INTEGER NOT NULL CHECK(completed IN(0,1)))",
  );
  const canonical = Schema.encodeSync(LearnerAudioUploadCaptureSchema)(capture);
  const captureJson = JSON.stringify(canonical);
  const existing = sql
    .exec("SELECT capture_json FROM karaoke_archive_capture WHERE id=1")
    .toArray();
  if (existing.length === 0)
    sql.exec("INSERT INTO karaoke_archive_capture VALUES(1,?,0,0,NULL,0)", captureJson);
  else if (
    existing.length !== 1 ||
    JSON.stringify(parse(LearnerAudioUploadCaptureSchema, existing[0]?.capture_json)) !==
      captureJson
  )
    throw new Error("captured_karaoke_identity_changed");
  const load = (): CapturedKaraokeJournal => {
    const row = one(
      sql,
      "SELECT c.capture_json,c.claimed,c.deletion_fenced,c.inflight_json,c.completed,a.upload_id,a.object_key,a.next_part,a.parts_json,a.result_json FROM karaoke_archive_capture c JOIN karaoke_archive a USING(id) WHERE c.id=1",
    );
    const admitted = parse(LearnerAudioUploadCaptureSchema, row?.capture_json);
    if (JSON.stringify(admitted) !== captureJson || admitted.objectRef !== row?.object_key)
      throw new Error("captured_karaoke_identity_changed");
    const flag = (value: unknown) => {
      const n = Schema.decodeUnknownSync(Schema.Literals([0, 1]))(value);
      return n === 1;
    };
    return {
      capture: admitted,
      claimed: flag(row?.claimed),
      deletionFenced: flag(row?.deletion_fenced),
      multipartId: Schema.decodeUnknownSync(Schema.NullOr(Schema.NonEmptyString))(row?.upload_id),
      nextPart: Schema.decodeUnknownSync(Schema.Int.check(Schema.isGreaterThan(0)))(row?.next_part),
      parts: parse(Schema.Array(Part), row?.parts_json),
      inFlight: parse(InFlight, row?.inflight_json),
      completed: flag(row?.completed),
      result: parse(Schema.NullOr(Stored), row?.result_json),
    };
  };
  const save = (journal: CapturedKaraokeJournal) => {
    if (
      JSON.stringify(Schema.encodeSync(LearnerAudioUploadCaptureSchema)(journal.capture)) !==
      captureJson
    )
      throw new Error("captured_karaoke_identity_changed");
    const current = load();
    if (
      (current.deletionFenced && !journal.deletionFenced) ||
      (current.claimed && !journal.claimed) ||
      (current.completed && !journal.completed) ||
      (current.multipartId !== null && current.multipartId !== journal.multipartId)
    )
      throw new Error("captured_karaoke_terminal_fact_changed");
    if (
      current.result !== null &&
      JSON.stringify(Schema.encodeSync(Stored)(current.result)) !==
        (journal.result === null ? null : JSON.stringify(Schema.encodeSync(Stored)(journal.result)))
    )
      throw new Error("captured_karaoke_terminal_result_changed");
    sql.exec(
      "UPDATE karaoke_archive_capture SET claimed=?,deletion_fenced=?,inflight_json=?,completed=? WHERE id=1",
      journal.claimed ? 1 : 0,
      journal.deletionFenced ? 1 : 0,
      journal.inFlight === null ? null : JSON.stringify(journal.inFlight),
      journal.completed ? 1 : 0,
    );
    sql.exec(
      "UPDATE karaoke_archive SET upload_id=?,next_part=?,parts_json=?,result_json=?,state=? WHERE id=1",
      journal.multipartId,
      journal.nextPart,
      JSON.stringify(journal.parts),
      journal.result === null ? null : JSON.stringify(journal.result),
      journal.result === null ? "pending" : "stored",
    );
  };
  return {
    load,
    save: (journal) => storage.transactionSync(() => save(journal)),
    chunks: () =>
      sql
        .exec<{ frame_sequence: number; payload: ArrayBuffer }>(
          "SELECT frame_sequence,payload FROM karaoke_audio_chunk ORDER BY frame_sequence",
        )
        .toArray()
        .map((row) => ({ frameSequence: row.frame_sequence, payload: row.payload })),
    savePartAndRemoveThrough: (journal, sequence) =>
      storage.transactionSync(() => {
        save(journal);
        sql.exec("DELETE FROM karaoke_audio_chunk WHERE frame_sequence<=?", sequence);
      }),
    durationMs: () =>
      Schema.decodeUnknownSync(count)(
        one(sql, "SELECT duration_ms FROM karaoke_archive WHERE id=1")?.duration_ms,
      ),
    clearChunksAfterClosed: () =>
      storage.transactionSync(() => {
        const current = load();
        if (!current.deletionFenced || current.inFlight !== null)
          throw new Error("captured_karaoke_cleanup_not_closed");
        sql.exec("DELETE FROM karaoke_audio_chunk");
      }),
  };
};
