import { DateTime, Schema } from "effect";
import { KaraokeResetTarget } from "./karaoke-reset-installation.ts";

export const ReconciliationDigest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
export const ReconciliationText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1024),
);
export const ReconciliationTime = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u),
);
export const ReconciliationCount = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
export const ReconciliationPhase = Schema.Literals([
  "post-fence",
  "pre-reset",
  "retirement",
  "follow-up",
]);
export const ReconciliationTarget = Schema.Struct({
  ...KaraokeResetTarget.fields,
  bucket: ReconciliationText,
});
const Mapping = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("key"),
    accountId: ReconciliationText,
    attemptId: ReconciliationText,
    key: ReconciliationText,
    authorityEvidenceId: ReconciliationDigest,
    archiveEvidenceId: ReconciliationDigest,
  }),
  Schema.Struct({
    kind: Schema.Literal("no-authority-no-archive"),
    authorityEvidenceId: ReconciliationDigest,
    archiveEvidenceId: ReconciliationDigest,
    historyEvidenceId: ReconciliationDigest,
  }),
]);
const Observations = Schema.Struct({
  beforeUploadsId: ReconciliationDigest,
  afterUploadsId: ReconciliationDigest,
  beforeUploadCount: ReconciliationCount,
  afterUploadCount: ReconciliationCount,
  beforeHeadId: ReconciliationDigest,
  afterHeadId: ReconciliationDigest,
  beforeHead: Schema.Literals(["present", "absent", "failed"]),
  afterHead: Schema.Literals(["present", "absent", "failed"]),
});
const ReconciliationOutcome = Schema.Literals([
  "observed-empty",
  "cleaned-to-empty",
  "verified-no-authority",
  "incomplete",
]);
export const ReconciliationReceiptSchema = Schema.Struct({
  version: Schema.Literal("staging-karaoke-reconciliation-v1"),
  target: ReconciliationTarget,
  mapping: Mapping,
  phase: ReconciliationPhase,
  startedAt: ReconciliationTime,
  endedAt: ReconciliationTime,
  installationReceiptId: ReconciliationDigest,
  fenceEvidenceId: ReconciliationDigest,
  releaseEvidenceId: Schema.NullOr(ReconciliationDigest),
  precedingReceiptId: Schema.NullOr(ReconciliationDigest),
  observations: Schema.NullOr(Observations),
  actionsEvidenceId: ReconciliationDigest,
  outcome: ReconciliationOutcome,
});
export type ReconciliationReceipt = typeof ReconciliationReceiptSchema.Type;

export function decodeReconciliation<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  input: unknown,
): S["Type"] {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(input);
  } catch {
    throw new Error("karaoke_reconciliation_invalid_evidence");
  }
}

export function reconciliationMillis(input: string): number {
  const text = decodeReconciliation(ReconciliationTime, input);
  const value = DateTime.makeUnsafe(text);
  if (DateTime.formatIso(value) !== text) throw new Error("karaoke_reconciliation_invalid_time");
  return DateTime.toEpochMillis(value);
}

export function parseKaraokeReconciliationReceipt(input: unknown): ReconciliationReceipt {
  const receipt = decodeReconciliation(ReconciliationReceiptSchema, input);
  if (reconciliationMillis(receipt.startedAt) > reconciliationMillis(receipt.endedAt)) {
    throw new Error("karaoke_reconciliation_invalid_time");
  }
  return receipt;
}
