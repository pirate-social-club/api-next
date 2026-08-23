const FIXTURE_URL = new URL(
  "../../tests/fixtures/media-r2-sealing/hostile-fixtures.json",
  import.meta.url,
);

export const SCENARIO_NAMES = [
  "success",
  "source-missing",
  "copy-source-missing",
  "expectation-size-mismatch",
  "expectation-content-type-mismatch",
  "expectation-checksum-mismatch",
  "expectation-checksum-missing",
  "source-overwritten-before-copy",
  "destination-conflict",
  "simultaneous-source-destination-race",
  "destination-appears-before-copy",
  "malformed-404",
  "generic-404",
  "no-such-bucket",
  "copy-provider-error",
  "nonstandard-412",
  "verification-etag-mismatch",
  "verification-size-mismatch",
  "verification-content-type-mismatch",
  "verification-checksum-mismatch",
  "verification-version-mismatch",
  "verification-destination-missing",
  "verification-provider-error",
  "multipart-etag",
  "unquoted-etag",
  "weak-etag",
  "ambiguous-412",
] as const;

export type ScenarioName = (typeof SCENARIO_NAMES)[number];
export type FixtureObject = Readonly<{
  etag: string;
  sizeBytes: number;
  contentType: string;
  sha256?: string;
  versionId?: string;
}>;
export type CopyFailure = "ambiguous-412" | "provider-error" | "nonstandard-412";

export type SealFixture = Readonly<{
  name: ScenarioName;
  sourceBucket: string;
  destinationBucket: string;
  sourceKey: string;
  destinationKey: string;
  source: FixtureObject | null;
  destination: FixtureObject | null;
  expectedSizeBytes: number;
  expectedContentType: string;
  expectedSha256?: string;
  overwriteSourceBeforeCopy?: FixtureObject;
  sourceDisappearsBeforeCopy?: true;
  destinationAppearsBeforeCopy?: FixtureObject;
  sourceHeadError?: "malformed-404" | "generic-404" | "no-such-bucket";
  verificationMismatch?: "etag" | "size" | "content-type" | "checksum" | "version";
  destinationHeadFailure?: "missing" | "provider-error";
  copiedDestinationEtag?: string;
  destinationVersionIdAfterCopy?: string;
  copyFailure?: CopyFailure;
}>;

export type FixtureSet = Readonly<{
  schemaVersion: "r2-seal-hostile-fixtures-v1";
  sourceBucket: string;
  destinationBucket: string;
  scenarios: readonly SealFixture[];
}>;

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function requiredString(record: JsonRecord, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label}.${key} must be a non-empty string`);
  }
  return value;
}

function optionalObject(record: JsonRecord, key: string, label: string): JsonRecord | null {
  const value = record[key];
  if (value === undefined || value === null) return null;
  return asRecord(value, `${label}.${key}`);
}

function parseFixtureObject(value: unknown, label: string): FixtureObject {
  const record = asRecord(value, label);
  const etag = requiredString(record, "etag", label);
  const sizeBytes = record.size_bytes;
  if (!Number.isSafeInteger(sizeBytes) || typeof sizeBytes !== "number" || sizeBytes <= 0) {
    throw new Error(`${label}.size_bytes must be a positive safe integer`);
  }
  const contentType = requiredString(record, "content_type", label);
  const sha256 = optionalStringValue(record, "sha256", label);
  const versionId = optionalStringValue(record, "version_id", label);
  return {
    etag,
    sizeBytes,
    contentType,
    ...(sha256 === undefined ? {} : { sha256 }),
    ...(versionId === undefined ? {} : { versionId }),
  };
}

function optionalStringValue(record: JsonRecord, key: string, label: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label}.${key} must be a non-empty string`);
  }
  return value;
}

function requiredPositiveInteger(record: JsonRecord, key: string, label: string): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value <= 0) {
    throw new Error(`${label}.${key} must be a positive safe integer`);
  }
  return value;
}

function optionalString<T extends string>(
  record: JsonRecord,
  key: string,
  label: string,
  allowed: readonly T[],
): T | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${label}.${key} is unsupported`);
  }
  return value as T;
}

function optionalTrue(record: JsonRecord, key: string, label: string): true | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (value !== true) throw new Error(`${label}.${key} must be true when present`);
  return true;
}

function parseScenario(
  value: unknown,
  index: number,
  sourceBucket: string,
  destinationBucket: string,
): SealFixture {
  const record = asRecord(value, `scenarios[${index}]`);
  const label = `scenarios[${index}]`;
  const nameValue = requiredString(record, "name", label);
  if (!(SCENARIO_NAMES as readonly string[]).includes(nameValue)) {
    throw new Error(`${label}.name is not a known hostile fixture`);
  }
  const sourceKey = requiredString(record, "source_key", label);
  const destinationKey = requiredString(record, "destination_key", label);
  if (sourceKey === destinationKey) throw new Error(`${label} object keys must differ`);
  const sourceRecord = optionalObject(record, "source", label);
  const destinationRecord = optionalObject(record, "destination", label);
  const overwriteRecord = optionalObject(record, "overwrite_source_before_copy", label);
  const appearsRecord = optionalObject(record, "destination_appears_before_copy", label);
  const sourceDisappearsBeforeCopy = optionalTrue(record, "source_disappears_before_copy", label);
  const sourceHeadError = optionalString(record, "source_head_error", label, [
    "malformed-404",
    "generic-404",
    "no-such-bucket",
  ] as const);
  const verificationMismatch = optionalString(record, "verification_mismatch", label, [
    "etag",
    "size",
    "content-type",
    "checksum",
    "version",
  ] as const);
  const destinationHeadFailure = optionalString(record, "destination_head_failure", label, [
    "missing",
    "provider-error",
  ] as const);
  const copiedDestinationEtag = optionalStringValue(record, "copied_destination_etag", label);
  const destinationVersionIdAfterCopy = optionalStringValue(
    record,
    "destination_version_id_after_copy",
    label,
  );
  const copyFailure = optionalString(record, "copy_failure", label, [
    "ambiguous-412",
    "provider-error",
    "nonstandard-412",
  ] as const);
  return {
    name: nameValue as ScenarioName,
    sourceBucket,
    destinationBucket,
    sourceKey,
    destinationKey,
    source: sourceRecord === null ? null : parseFixtureObject(sourceRecord, `${label}.source`),
    destination:
      destinationRecord === null
        ? null
        : parseFixtureObject(destinationRecord, `${label}.destination`),
    expectedSizeBytes: requiredPositiveInteger(record, "expected_size_bytes", label),
    expectedContentType: requiredString(record, "expected_content_type", label),
    ...(record.expected_sha256 === undefined
      ? {}
      : { expectedSha256: requiredString(record, "expected_sha256", label) }),
    ...(overwriteRecord === null
      ? {}
      : {
          overwriteSourceBeforeCopy: parseFixtureObject(
            overwriteRecord,
            `${label}.overwrite_source_before_copy`,
          ),
        }),
    ...(sourceDisappearsBeforeCopy === undefined ? {} : { sourceDisappearsBeforeCopy }),
    ...(appearsRecord === null
      ? {}
      : {
          destinationAppearsBeforeCopy: parseFixtureObject(
            appearsRecord,
            `${label}.destination_appears_before_copy`,
          ),
        }),
    ...(sourceHeadError === undefined ? {} : { sourceHeadError }),
    ...(verificationMismatch === undefined ? {} : { verificationMismatch }),
    ...(destinationHeadFailure === undefined ? {} : { destinationHeadFailure }),
    ...(copiedDestinationEtag === undefined ? {} : { copiedDestinationEtag }),
    ...(destinationVersionIdAfterCopy === undefined ? {} : { destinationVersionIdAfterCopy }),
    ...(copyFailure === undefined ? {} : { copyFailure }),
  };
}

export function parseFixtureSet(value: unknown): FixtureSet {
  const record = asRecord(value, "fixture set");
  if (record.schema_version !== "r2-seal-hostile-fixtures-v1") {
    throw new Error("fixture set has an unsupported schema_version");
  }
  if (!Array.isArray(record.scenarios) || record.scenarios.length === 0) {
    throw new Error("fixture set scenarios must be a non-empty array");
  }
  const sourceBucket = requiredString(record, "source_bucket", "fixture set");
  const destinationBucket = requiredString(record, "destination_bucket", "fixture set");
  const scenarios = record.scenarios.map((scenario, index) =>
    parseScenario(scenario, index, sourceBucket, destinationBucket),
  );
  const names = new Set<ScenarioName>();
  for (const scenario of scenarios) {
    if (names.has(scenario.name)) throw new Error(`duplicate hostile fixture: ${scenario.name}`);
    names.add(scenario.name);
  }
  return {
    schemaVersion: "r2-seal-hostile-fixtures-v1",
    sourceBucket,
    destinationBucket,
    scenarios,
  };
}

export async function loadHostileFixtures(url: URL = FIXTURE_URL): Promise<FixtureSet> {
  return parseFixtureSet(await Bun.file(url).json());
}
