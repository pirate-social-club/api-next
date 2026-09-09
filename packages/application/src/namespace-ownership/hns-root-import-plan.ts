import { canonicalJson } from "@pirate/domain";
import { preflightEncodeHnsResourceV1 } from "./hns-resource-codec.ts";

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
  /**
   * SHA-256 of the HSD wire encoding of `replacement_records` — distinct
   * from the plan-document hash so the broadcast resource and the review
   * document are verified independently.
   */
  readonly encoded_resource_sha256: string;
  readonly acknowledgement_required: true;
}>;

export type HnsRootImportPlanErrorReason =
  | "invalid_current_record"
  | "invalid_challenge"
  | "invalid_ds_records"
  | "resource_preflight_failed";

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

function currentAuthorityMatches(
  records: readonly HnsRootResourceRecordV1[],
  dsRecords: readonly HnsRootDelegationDsV1[],
): boolean {
  const nameservers = records
    .filter((record) => record.type === "NS")
    .map((record) => record.ns)
    .sort();
  if (canonicalJson(nameservers) !== canonicalJson([...HNS_ROOT_IMPORT_NAMESERVERS].sort())) {
    return false;
  }
  const currentDs = records
    .filter((record) => record.type === "DS")
    .map((record) => ({
      key_tag: record.keyTag,
      algorithm: record.algorithm,
      digest_type: record.digestType,
      digest: typeof record.digest === "string" ? record.digest.toLowerCase() : record.digest,
    }))
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  const wantedDs = dsRecords
    .map((record) => ({ ...record }))
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  return canonicalJson(currentDs) === canonicalJson(wantedDs);
}

/**
 * Builds the one complete Handshake resource replacement shown to the owner.
 * Unrelated records remain byte-for-byte JSON-equivalent and in their original
 * order. Only prior NS, DS, and Pirate challenge TXT records are replaced.
 * The replacement resource is preflight-encoded with the HSD wire codec
 * (real 512-byte consensus limit, exact round trip) before the plan is
 * returned, and the plan carries the encoded-resource hash distinct from
 * its document hash.
 */
export async function buildHnsRootImportPublishPlanV1(
  input: Readonly<{
    readonly current_records: readonly HnsRootResourceRecordV1[];
    readonly challenge_txt_value: string;
    readonly ds_records: readonly HnsRootDelegationDsV1[];
  }>,
): Promise<HnsRootImportPublishPlanV1> {
  const challenge = validateChallenge(input.challenge_txt_value);
  const dsRecords = validateDsRecords(input.ds_records);
  const currentRecords = validateHnsRootResourceRecordsV1(input.current_records);
  const retainAuthority = currentAuthorityMatches(currentRecords, dsRecords);
  const preservedRecords: HnsRootResourceRecordV1[] = [];
  const removedConflicts: HnsRootResourceRecordV1[] = [];
  const unknownTypes = new Set<string>();
  for (const record of currentRecords) {
    if (
      isPirateVerificationTxt(record) ||
      (!retainAuthority && (record.type === "NS" || record.type === "DS"))
    ) {
      removedConflicts.push(cloneRecord(record));
      continue;
    }
    preservedRecords.push(cloneRecord(record));
    if (!evaluatedRecordTypes.has(record.type)) unknownTypes.add(record.type);
  }
  const addedRecords: HnsRootResourceRecordV1[] = retainAuthority
    ? [{ type: "TXT", txt: [challenge] }]
    : [
        ...HNS_ROOT_IMPORT_NAMESERVERS.map((ns) => ({ type: "NS", ns })),
        { type: "TXT", txt: [challenge] },
        ...dsRecords.map(dsResourceRecord),
      ];
  const replacementRecords = [...preservedRecords, ...addedRecords].map(cloneRecord);
  let preflight: Awaited<ReturnType<typeof preflightEncodeHnsResourceV1>>;
  try {
    preflight = await preflightEncodeHnsResourceV1(replacementRecords);
  } catch {
    throw new HnsRootImportPlanError("resource_preflight_failed");
  }
  return Object.freeze({
    version: HNS_ROOT_IMPORT_PUBLISH_PLAN_VERSION,
    replacement_semantics: "complete_resource",
    current_records: currentRecords.map(cloneRecord),
    preserved_records: preservedRecords.map(cloneRecord),
    removed_conflicts: removedConflicts.map(cloneRecord),
    added_records: addedRecords.map(cloneRecord),
    replacement_records: replacementRecords,
    preserved_unknown_record_types: [...unknownTypes].sort(),
    encoded_resource_sha256: preflight.sha256,
    acknowledgement_required: true,
  });
}

export function hnsRootImportPublishPlanSha256V1(
  plan: HnsRootImportPublishPlanV1,
): Promise<string> {
  return sha256Hex(encoder.encode(canonicalJson(plan)));
}
