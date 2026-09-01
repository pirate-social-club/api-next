import { canonicalJson } from "@pirate/domain";

export const HNS_ROOT_IMPORT_PUBLISH_PLAN_VERSION = "pirate-hns-root-import-publish-plan-v1";
export const HNS_ROOT_IMPORT_NAMESERVERS = ["ns1.pirate.", "ns2.pirate."] as const;

export type HnsJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly HnsJsonValue[]
  | Readonly<{ readonly [key: string]: HnsJsonValue }>;

export type HnsRootResourceRecordV1 = Readonly<{
  readonly type: string;
  readonly [key: string]: HnsJsonValue;
}>;

export type HnsRootDelegationDsV1 = Readonly<{
  readonly key_tag: number;
  readonly algorithm: number;
  readonly digest_type: 2 | 4;
  readonly digest: string;
}>;

export type HnsRootImportPublishPlanV1 = Readonly<{
  readonly version: typeof HNS_ROOT_IMPORT_PUBLISH_PLAN_VERSION;
  readonly replacement_semantics: "complete_resource";
  readonly current_records: readonly HnsRootResourceRecordV1[];
  readonly preserved_records: readonly HnsRootResourceRecordV1[];
  readonly removed_conflicts: readonly HnsRootResourceRecordV1[];
  readonly added_records: readonly HnsRootResourceRecordV1[];
  readonly replacement_records: readonly HnsRootResourceRecordV1[];
  readonly preserved_unknown_record_types: readonly string[];
  readonly acknowledgement_required: true;
}>;

export type HnsRootImportPlanErrorReason =
  | "invalid_current_record"
  | "invalid_challenge"
  | "invalid_ds_records";

export class HnsRootImportPlanError extends Error {
  override readonly name = "HnsRootImportPlanError";

  constructor(readonly reason: HnsRootImportPlanErrorReason) {
    super(`HNS root import plan refused: ${reason}`);
  }
}

const evaluatedRecordTypes = new Set(["NS", "TXT", "DS", "GLUE4", "GLUE6"]);
const encoder = new TextEncoder();

function sha256Hex(bytes: Uint8Array): Promise<string> {
  return crypto.subtle
    .digest("SHA-256", Uint8Array.from(bytes).buffer)
    .then((digest) =>
      [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    );
}

function cloneRecord(record: HnsRootResourceRecordV1): HnsRootResourceRecordV1 {
  return structuredClone(record);
}

function validJsonValue(value: unknown, depth = 0): value is HnsJsonValue {
  if (depth > 32) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((entry) => validJsonValue(entry, depth + 1));
  if (typeof value !== "object") return false;
  return Object.entries(value).every(
    ([key, entry]) => key.length > 0 && validJsonValue(entry, depth + 1),
  );
}

function validRecord(record: unknown): record is HnsRootResourceRecordV1 {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return false;
  const type = Reflect.get(record, "type");
  return (
    typeof type === "string" &&
    /^[A-Z][A-Z0-9]{0,31}$/u.test(type) &&
    validJsonValue(record) &&
    encoder.encode(JSON.stringify(record)).byteLength <= 65_536
  );
}

export function validateHnsRootResourceRecordsV1(
  records: readonly unknown[],
): readonly HnsRootResourceRecordV1[] {
  if (!records.every(validRecord)) {
    throw new HnsRootImportPlanError("invalid_current_record");
  }
  return records.map(cloneRecord);
}

function isPirateVerificationTxt(record: HnsRootResourceRecordV1): boolean {
  if (record.type !== "TXT" || !Array.isArray(record.txt)) return false;
  if (!record.txt.every((chunk) => typeof chunk === "string")) return false;
  return record.txt.join("").startsWith("pirate-verification=");
}

function validateChallenge(value: string): string {
  if (
    value.trim() !== value ||
    !value.startsWith("pirate-verification=") ||
    value.length === "pirate-verification=".length ||
    encoder.encode(value).byteLength > 16_448
  ) {
    throw new HnsRootImportPlanError("invalid_challenge");
  }
  return value;
}

function validateDsRecords(
  records: readonly HnsRootDelegationDsV1[],
): readonly HnsRootDelegationDsV1[] {
  if (records.length < 2 || records.length > 32 || records.length % 2 !== 0) {
    throw new HnsRootImportPlanError("invalid_ds_records");
  }
  const normalized = records.map((record) => ({ ...record, digest: record.digest.toLowerCase() }));
  const valid = normalized.every((record) => {
    const digestLength = record.digest_type === 2 ? 64 : record.digest_type === 4 ? 96 : 0;
    return (
      Number.isSafeInteger(record.key_tag) &&
      record.key_tag >= 0 &&
      record.key_tag <= 65_535 &&
      Number.isSafeInteger(record.algorithm) &&
      record.algorithm >= 0 &&
      record.algorithm <= 255 &&
      record.digest.length === digestLength &&
      /^[0-9a-f]+$/u.test(record.digest)
    );
  });
  const identities = new Map<string, Set<number>>();
  for (const record of normalized) {
    const identity = `${record.key_tag}:${record.algorithm}`;
    const digestTypes = identities.get(identity) ?? new Set<number>();
    digestTypes.add(record.digest_type);
    identities.set(identity, digestTypes);
  }
  if (
    !valid ||
    new Set(normalized.map((record) => JSON.stringify(record))).size !== normalized.length ||
    [...identities.values()].some(
      (digestTypes) => digestTypes.size !== 2 || !digestTypes.has(2) || !digestTypes.has(4),
    )
  ) {
    throw new HnsRootImportPlanError("invalid_ds_records");
  }
  return [...normalized].sort(
    (left, right) =>
      left.key_tag - right.key_tag ||
      left.algorithm - right.algorithm ||
      left.digest_type - right.digest_type,
  );
}

function dsResourceRecord(record: HnsRootDelegationDsV1): HnsRootResourceRecordV1 {
  return {
    type: "DS",
    keyTag: record.key_tag,
    algorithm: record.algorithm,
    digestType: record.digest_type,
    digest: record.digest,
  };
}

/**
 * Builds the one complete Handshake resource replacement shown to the owner.
 * Unrelated records remain byte-for-byte JSON-equivalent and in their original
 * order. Only prior NS, DS, and Pirate challenge TXT records are replaced.
 */
export function buildHnsRootImportPublishPlanV1(
  input: Readonly<{
    readonly current_records: readonly HnsRootResourceRecordV1[];
    readonly challenge_txt_value: string;
    readonly ds_records: readonly HnsRootDelegationDsV1[];
  }>,
): HnsRootImportPublishPlanV1 {
  const challenge = validateChallenge(input.challenge_txt_value);
  const dsRecords = validateDsRecords(input.ds_records);
  const currentRecords = validateHnsRootResourceRecordsV1(input.current_records);
  const preservedRecords: HnsRootResourceRecordV1[] = [];
  const removedConflicts: HnsRootResourceRecordV1[] = [];
  const unknownTypes = new Set<string>();
  for (const record of currentRecords) {
    if (record.type === "NS" || record.type === "DS" || isPirateVerificationTxt(record)) {
      removedConflicts.push(cloneRecord(record));
      continue;
    }
    preservedRecords.push(cloneRecord(record));
    if (!evaluatedRecordTypes.has(record.type)) unknownTypes.add(record.type);
  }
  const addedRecords: HnsRootResourceRecordV1[] = [
    ...HNS_ROOT_IMPORT_NAMESERVERS.map((ns) => ({ type: "NS", ns })),
    { type: "TXT", txt: [challenge] },
    ...dsRecords.map(dsResourceRecord),
  ];
  return Object.freeze({
    version: HNS_ROOT_IMPORT_PUBLISH_PLAN_VERSION,
    replacement_semantics: "complete_resource",
    current_records: currentRecords.map(cloneRecord),
    preserved_records: preservedRecords.map(cloneRecord),
    removed_conflicts: removedConflicts.map(cloneRecord),
    added_records: addedRecords.map(cloneRecord),
    replacement_records: [...preservedRecords, ...addedRecords].map(cloneRecord),
    preserved_unknown_record_types: [...unknownTypes].sort(),
    acknowledgement_required: true,
  });
}

export function hnsRootImportPublishPlanSha256V1(
  plan: HnsRootImportPublishPlanV1,
): Promise<string> {
  return sha256Hex(encoder.encode(canonicalJson(plan)));
}
