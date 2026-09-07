import { DateTime, Schema } from "effect";
import {
  decodeKaraokeResetTarget,
  KaraokeResetObservationSchema,
  KaraokeResetReceiptSchema,
  KaraokeResetTarget,
} from "./karaoke-reset-installation.ts";
import { inspectKaraokeResetMarker, KARAOKE_RESET_MARKER_KEY } from "./karaoke-reset-marker.ts";
import {
  admitKaraokeResetOperator,
  type KaraokeResetOperatorBindings,
} from "./karaoke-reset-operator-auth.ts";

export const KARAOKE_RESET_INITIAL_KEY = "karaoke:staging-reset-initial:v1";
export const KARAOKE_RESET_RECEIPT_KEY = "karaoke:staging-reset-receipt:v1";
const Identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const Authority = Schema.Struct({ accountId: Identifier, attemptId: Identifier });
export const KaraokeResetSnapshotSchema = Schema.Struct({
  version: Schema.Literal("staging-karaoke-reset-inspection-v1"),
  ...KaraokeResetTarget.fields,
  observedAt: Schema.String.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u),
  ),
  markerState: Schema.Literals(["absent", "invalid", "active", "retired"]),
  initial: Schema.NullOr(KaraokeResetObservationSchema),
  current: KaraokeResetObservationSchema,
  authority: Schema.NullOr(Authority),
  installationReceipt: Schema.NullOr(KaraokeResetReceiptSchema),
});
export type KaraokeResetSnapshot = typeof KaraokeResetSnapshotSchema.Type;
type Sql = {
  exec<A extends Readonly<Record<string, unknown>>>(query: string): { toArray(): A[] };
};
type State = {
  readonly id: { toString(): string };
  readonly storage: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    getAlarm(): Promise<number | null>;
  };
  getWebSockets(): readonly unknown[];
  blockConcurrencyWhile<A>(operation: () => Promise<A>): Promise<A>;
};

function tables(sql: Sql): Set<string> {
  return new Set(
    sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('karaoke_session','karaoke_archive','karaoke_outbox')",
      )
      .toArray()
      .map((row) => row.name),
  );
}

/** Read existing tables only, including objects fenced before schema initialization. */
export async function observeKaraokeReset(state: State, sql: Sql): Promise<unknown> {
  const existing = tables(sql);
  const outbox = existing.has("karaoke_outbox")
    ? sql.exec("SELECT score_state,recording_state FROM karaoke_outbox WHERE id=1").toArray()[0]
    : undefined;
  const archive = existing.has("karaoke_archive")
    ? sql.exec("SELECT object_key,upload_id FROM karaoke_archive WHERE id=1").toArray()[0]
    : undefined;
  return {
    alarm: await state.storage.getAlarm(),
    sockets: state.getWebSockets().length,
    scoreState: outbox?.score_state ?? null,
    recordingState: outbox?.recording_state ?? null,
    archiveKey: archive?.object_key ?? null,
    uploadId: archive?.upload_id ?? null,
  };
}

/** No producer, cancellation, retirement, database or bucket capability is supplied. */
export async function inspectKaraokeReset(
  state: State,
  sql: Sql,
  bindings: KaraokeResetOperatorBindings,
  assertion: string,
  input: unknown,
): Promise<KaraokeResetSnapshot> {
  await admitKaraokeResetOperator(bindings, assertion);
  const target = decodeKaraokeResetTarget(input);
  if (target.objectId !== state.id.toString()) throw new Error("karaoke_reset_admission_denied");
  const result = await state.blockConcurrencyWhile(async () => {
    try {
      const marker = inspectKaraokeResetMarker(
        await state.storage.get(KARAOKE_RESET_MARKER_KEY),
        target,
      );
      const initial = await state.storage.get(KARAOKE_RESET_INITIAL_KEY);
      const receipt = await state.storage.get(KARAOKE_RESET_RECEIPT_KEY);
      const row = tables(sql).has("karaoke_session")
        ? sql
            .exec<{ authority_json: unknown }>(
              "SELECT authority_json FROM karaoke_session WHERE id=1",
            )
            .toArray()[0]
        : undefined;
      // Project only identifiers. Missing rows are absent evidence; malformed rows fail closed.
      const authority =
        row === undefined
          ? null
          : Schema.decodeUnknownSync(Authority)(
              JSON.parse(
                Schema.decodeUnknownSync(Schema.String.check(Schema.isMaxLength(262_144)))(
                  row.authority_json,
                ),
              ),
            );
      const snapshot = Schema.decodeUnknownSync(KaraokeResetSnapshotSchema, {
        onExcessProperty: "error",
      })({
        version: "staging-karaoke-reset-inspection-v1",
        ...target,
        observedAt: DateTime.formatIso(DateTime.makeUnsafe(Date.now())),
        markerState: marker.state,
        initial:
          initial === undefined
            ? null
            : Schema.decodeUnknownSync(KaraokeResetObservationSchema, {
                onExcessProperty: "error",
              })(initial),
        current: await observeKaraokeReset(state, sql),
        authority,
        installationReceipt:
          receipt === undefined
            ? null
            : Schema.decodeUnknownSync(KaraokeResetReceiptSchema, { onExcessProperty: "error" })(
                receipt,
              ),
      });
      const installation = snapshot.installationReceipt;
      if (
        installation !== null &&
        Object.entries(target).some(([key, value]) => Reflect.get(installation, key) !== value)
      )
        throw new Error("karaoke_reset_invalid_evidence");
      return { ok: true as const, snapshot };
    } catch {
      // An expected evidence rejection must not evict an object with producers in flight.
      return { ok: false as const };
    }
  });
  if (!result.ok) throw new Error("karaoke_reset_invalid_evidence");
  return result.snapshot;
}
