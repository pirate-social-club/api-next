import { Predicate, Schema } from "effect";
import {
  ActionsEvidence,
  ReconciliationScope,
  reconciliationDigest,
} from "../packages/platform-cf/src/karaoke-reconciliation-evidence.ts";
import {
  decodeReconciliation,
  ReconciliationCount,
  ReconciliationDigest,
  ReconciliationText,
  ReconciliationTime,
  reconciliationMillis,
} from "../packages/platform-cf/src/karaoke-reconciliation-schema.ts";
import {
  type readKaraokeMaintenanceJournal,
  verifiedPayload,
} from "./karaoke-maintenance-journal.ts";
import { openKaraokePrivateArtifacts } from "./karaoke-private-artifacts.ts";
import type { KaraokeAdapterTrust } from "./karaoke-reconciliation-adapter.ts";

const Common = {
  scope: ReconciliationScope,
  residualDispositionId: ReconciliationDigest,
  expectedHead: Schema.Struct({ entryId: ReconciliationDigest, sequence: ReconciliationCount }),
};
const Intent = Schema.Struct({
  ...Common,
  kind: Schema.Literal("cleanup-intent"),
  key: ReconciliationText,
  uploadIds: Schema.Array(ReconciliationText).check(Schema.isMaxLength(4096)),
  headPresent: Schema.Boolean,
  recordedAt: ReconciliationTime,
});
const Action = Schema.Struct({
  ...Common,
  kind: Schema.Literal("cleanup-action"),
  intentId: ReconciliationDigest,
  attemptedAt: ReconciliationTime,
  attempt: Schema.Struct({
    kind: Schema.Literals(["abort", "delete"]),
    key: ReconciliationText,
    uploadId: Schema.NullOr(ReconciliationText),
    outcome: Schema.Literals(["succeeded", "not-found", "failed", "uncertain"]),
    response: Schema.Unknown,
  }),
});
const Record = Schema.Union([Intent, Action]);
type Record = typeof Record.Type;

/** Historical attempts are audit facts, not replacement provider receipts.
 * Authenticate every discovered record before a pass can act; old unsigned
 * sidecars require explicit review and are never silently blessed on retry. */
export function readKaraokeCleanupHistory(input: {
  readonly directory: string;
  readonly trust: KaraokeAdapterTrust;
  readonly journal: ReturnType<typeof readKaraokeMaintenanceJournal>;
  readonly nowUtc: string;
}) {
  const store = openKaraokePrivateArtifacts(input.directory);
  const records = new Map<string, { record: Record; signed: string }>();
  const lineage = new Map(input.journal.entries.map(({ id, entry }) => [id, entry]));
  const claimsCleanup = (value: unknown) =>
    Predicate.isObject(value) &&
    "kind" in value &&
    typeof value.kind === "string" &&
    value.kind.startsWith("cleanup-");
  try {
    for (const name of store.names()) {
      const bytes = store.read(name, 262_144);
      const id = name.slice(0, -5);
      if (reconciliationDigest(bytes) !== id)
        throw new Error("karaoke_cleanup_history_digest_denied");
      const outer: unknown = JSON.parse(bytes);
      const candidate =
        Predicate.isObject(outer) && "payload" in outer && typeof outer.payload === "string"
          ? JSON.parse(outer.payload)
          : outer;
      if (!claimsCleanup(candidate)) continue;
      const record = decodeReconciliation(
        Record,
        verifiedPayload(bytes, input.trust.collectorPublicKeyPem),
      );
      const predecessor = lineage.get(record.expectedHead.entryId);
      const recordedAt = record.kind === "cleanup-intent" ? record.recordedAt : record.attemptedAt;
      if (
        record.scope.epoch !== input.trust.epoch ||
        record.scope.phase !== "post-fence" ||
        record.scope.target.bucket !== input.trust.bucket ||
        record.residualDispositionId !== input.trust.residualDispositionId ||
        predecessor === undefined ||
        predecessor.sequence !== record.expectedHead.sequence ||
        reconciliationMillis(recordedAt) < reconciliationMillis(predecessor.observedAt) ||
        reconciliationMillis(recordedAt) > reconciliationMillis(input.nowUtc)
      )
        throw new Error("karaoke_cleanup_history_scope_denied");
      records.set(id, { record, signed: bytes });
    }
    for (const { record } of records.values()) {
      if (record.kind !== "cleanup-action") continue;
      const intent = records.get(record.intentId)?.record;
      if (
        intent?.kind !== "cleanup-intent" ||
        JSON.stringify(intent.scope) !== JSON.stringify(record.scope) ||
        JSON.stringify(intent.expectedHead) !== JSON.stringify(record.expectedHead) ||
        record.attempt.key !== intent.key ||
        reconciliationMillis(record.attemptedAt) < reconciliationMillis(intent.recordedAt) ||
        (record.attempt.kind === "abort"
          ? record.attempt.uploadId === null || !intent.uploadIds.includes(record.attempt.uploadId)
          : record.attempt.uploadId !== null || !intent.headPresent)
      )
        throw new Error("karaoke_cleanup_history_intent_denied");
      if (record.attempt.outcome === "uncertain") {
        if (record.attempt.response !== null)
          throw new Error("karaoke_cleanup_history_uncertain_denied");
      } else {
        const [action] = decodeReconciliation(ActionsEvidence, [record.attempt]);
        if (action?.response.bucket !== input.trust.bucket)
          throw new Error("karaoke_cleanup_history_response_denied");
        const expectedOutcome =
          action.response.status === 404
            ? "not-found"
            : action.response.status >= 200 && action.response.status < 300
              ? "succeeded"
              : "failed";
        if (action.outcome !== expectedOutcome)
          throw new Error("karaoke_cleanup_history_response_denied");
      }
    }
    return [...records]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, value]) => ({ id, ...value }));
  } finally {
    store.close();
  }
}

/** Embed exact signed originals into each new receipt's signed evidence set.
 * This preserves absent-result intents and uncertain outcomes without claiming
 * that they succeeded or using them to establish current bucket emptiness. */
export function retainKaraokeCleanupHistory(
  history: ReturnType<typeof readKaraokeCleanupHistory>,
  objectId: string,
  key: string,
  retain: (data: unknown) => string,
) {
  for (const { id, record, signed } of history) {
    if (record.scope.target.objectId !== objectId) continue;
    const originalKey = record.kind === "cleanup-intent" ? record.key : record.attempt.key;
    if (originalKey !== key) throw new Error("karaoke_cleanup_history_key_denied");
    retain({ kind: "retained-cleanup-history", artifactId: id, signed });
  }
}
