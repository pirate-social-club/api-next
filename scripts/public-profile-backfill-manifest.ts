import {
  canonicalJson,
  type LegacyGlobalHandleRow,
  type LegacyHandleMapping,
  type LegacyOwnerMapping,
  manifestDigest,
  PUBLIC_PROFILE_BACKFILL_MANIFEST_VERSION,
  type PublicProfileBackfillManifest,
  sha256,
  sourceColumns,
} from "./public-profile-backfill-types";

const RFC3339_UTC_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
export const validTimestamp = (value: unknown): value is string =>
  typeof value === "string" &&
  RFC3339_UTC_MILLISECONDS.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
export const validId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value);
const validAsciiText = (value: unknown): value is string =>
  typeof value === "string" && /^[\x20-\x7E]{1,256}$/u.test(value);
const requireTimestamp = (value: string, field: string): string => {
  if (!validTimestamp(value)) throw new Error(`invalid-rfc3339-timestamp:${field}`);
  return value;
};
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const hasExactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length && actual.every((key, i) => key === sortedExpected[i])
  );
};
const validDigest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
export const statuses = ["active", "redirect", "retired"] as const;
const tiers = ["generated", "standard", "premium"] as const;
const issuanceSources = [
  "generated_signup",
  "free_cleanup_rename",
  "reddit_verified_claim",
  "paid_upgrade",
  "admin_grant",
] as const;
const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === "string" && values.includes(value as T);
const sortedRows = (rows: readonly LegacyGlobalHandleRow[]): readonly LegacyGlobalHandleRow[] =>
  [...rows].sort(
    (left, right) =>
      left.global_handle_id.localeCompare(right.global_handle_id) ||
      canonicalJson(left).localeCompare(canonicalJson(right)),
  );
const parseLegacyRow = (value: unknown): LegacyGlobalHandleRow => {
  if (!record(value) || !hasExactKeys(value, sourceColumns))
    throw new Error("manifest-invalid-row-shape");
  const row = value;
  if (
    !validId(row.global_handle_id) ||
    !validId(row.user_id) ||
    !validAsciiText(row.label_normalized) ||
    !validAsciiText(row.label_display) ||
    !isOneOf(statuses, row.status) ||
    !isOneOf(tiers, row.tier) ||
    !isOneOf(issuanceSources, row.issuance_source) ||
    !validTimestamp(row.issued_at) ||
    !validTimestamp(row.created_at) ||
    !validTimestamp(row.updated_at) ||
    (row.replaced_at !== null && !validTimestamp(row.replaced_at)) ||
    (row.redirect_target_global_handle_id !== null &&
      !validId(row.redirect_target_global_handle_id))
  )
    throw new Error("manifest-invalid-row-value");
  return row as LegacyGlobalHandleRow;
};

export function makePublicProfileBackfillManifest(input: {
  readonly snapshot_at: string;
  readonly rows: readonly LegacyGlobalHandleRow[];
  readonly owner_mappings: readonly LegacyOwnerMapping[];
  readonly handle_mappings: readonly LegacyHandleMapping[];
}): PublicProfileBackfillManifest {
  const rows = sortedRows(input.rows);
  const withoutDigest = {
    manifest_version: PUBLIC_PROFILE_BACKFILL_MANIFEST_VERSION,
    source: {
      system: "legacy-api" as const,
      relation: "global_handles" as const,
      snapshot_at: requireTimestamp(input.snapshot_at, "source.snapshot_at"),
      columns: sourceColumns,
      row_count: rows.length,
      source_sha256: sha256(canonicalJson(rows)),
    },
    rows,
    owner_mappings: [...input.owner_mappings].sort((a, b) =>
      a.legacy_user_id.localeCompare(b.legacy_user_id),
    ),
    handle_mappings: [...input.handle_mappings].sort((a, b) =>
      a.legacy_handle_id.localeCompare(b.legacy_handle_id),
    ),
  } satisfies Omit<PublicProfileBackfillManifest, "manifest_sha256">;
  return { ...withoutDigest, manifest_sha256: manifestDigest(withoutDigest) };
}

export function parsePublicProfileBackfillManifest(value: unknown): PublicProfileBackfillManifest {
  if (
    !record(value) ||
    !hasExactKeys(value, [
      "manifest_version",
      "source",
      "rows",
      "owner_mappings",
      "handle_mappings",
      "manifest_sha256",
    ]) ||
    value.manifest_version !== PUBLIC_PROFILE_BACKFILL_MANIFEST_VERSION ||
    !validDigest(value.manifest_sha256)
  )
    throw new Error("manifest-invalid-shape");
  if (
    !record(value.source) ||
    !hasExactKeys(value.source, [
      "system",
      "relation",
      "snapshot_at",
      "columns",
      "row_count",
      "source_sha256",
    ])
  )
    throw new Error("manifest-invalid-source-shape");
  const source = value.source;
  const rowCount = typeof source.row_count === "number" ? source.row_count : Number.NaN;
  if (
    source.system !== "legacy-api" ||
    source.relation !== "global_handles" ||
    !validTimestamp(source.snapshot_at) ||
    !Array.isArray(source.columns) ||
    source.columns.length !== sourceColumns.length ||
    source.columns.some((column, index) => column !== sourceColumns[index]) ||
    !Number.isSafeInteger(rowCount) ||
    rowCount < 0 ||
    !validDigest(source.source_sha256) ||
    !Array.isArray(value.rows) ||
    value.rows.length !== rowCount
  )
    throw new Error("manifest-invalid-source");
  const rows = value.rows.map(parseLegacyRow);
  if (canonicalJson(rows) !== canonicalJson(sortedRows(rows)))
    throw new Error("manifest-rows-not-canonical");
  if (source.source_sha256 !== sha256(canonicalJson(rows)))
    throw new Error("manifest-source-digest-mismatch");
  if (!Array.isArray(value.owner_mappings) || !Array.isArray(value.handle_mappings))
    throw new Error("manifest-mappings-missing");
  const ownerMappings: LegacyOwnerMapping[] = [];
  for (const entry of value.owner_mappings) {
    if (
      !record(entry) ||
      !hasExactKeys(entry, [
        "legacy_user_id",
        "api_next_user_id",
        "legacy_owner_state",
        "reviewed",
      ]) ||
      !validId(entry.legacy_user_id) ||
      !validId(entry.api_next_user_id) ||
      !isOneOf(["active", "merged", "tombstoned"], entry.legacy_owner_state) ||
      typeof entry.reviewed !== "boolean"
    )
      throw new Error("manifest-invalid-owner-mapping");
    if (entry.legacy_owner_state !== "active" && entry.reviewed !== true)
      throw new Error("manifest-unreviewed-legacy-owner-state");
    ownerMappings.push(entry as LegacyOwnerMapping);
  }
  const handleMappings: LegacyHandleMapping[] = [];
  for (const entry of value.handle_mappings) {
    if (
      !record(entry) ||
      !hasExactKeys(entry, ["legacy_handle_id", "api_next_handle_id"]) ||
      !validId(entry.legacy_handle_id) ||
      !validId(entry.api_next_handle_id)
    )
      throw new Error("manifest-invalid-handle-mapping");
    handleMappings.push(entry as LegacyHandleMapping);
  }
  const sortedOwners = [...ownerMappings].sort((a, b) =>
    a.legacy_user_id.localeCompare(b.legacy_user_id),
  );
  const sortedHandles = [...handleMappings].sort((a, b) =>
    a.legacy_handle_id.localeCompare(b.legacy_handle_id),
  );
  if (
    canonicalJson(ownerMappings) !== canonicalJson(sortedOwners) ||
    canonicalJson(handleMappings) !== canonicalJson(sortedHandles)
  )
    throw new Error("manifest-mappings-not-canonical");
  const sourceOwnerIds = new Set(rows.map((row) => row.user_id));
  const mappedOwnerIds = new Set<string>();
  for (const mapping of ownerMappings) {
    if (!sourceOwnerIds.has(mapping.legacy_user_id))
      throw new Error("manifest-owner-mapping-extra");
    if (mappedOwnerIds.has(mapping.api_next_user_id))
      throw new Error("manifest-owner-mapping-not-one-to-one");
    mappedOwnerIds.add(mapping.api_next_user_id);
  }
  if (ownerMappings.length !== sourceOwnerIds.size || mappedOwnerIds.size !== sourceOwnerIds.size)
    throw new Error("manifest-owner-mapping-incomplete");
  const sourceHandleIds = new Set(rows.map((row) => row.global_handle_id));
  const mappedHandleIds = new Set<string>();
  for (const mapping of handleMappings) {
    if (!sourceHandleIds.has(mapping.legacy_handle_id))
      throw new Error("manifest-handle-mapping-extra");
    if (mappedHandleIds.has(mapping.api_next_handle_id))
      throw new Error("manifest-handle-mapping-not-one-to-one");
    mappedHandleIds.add(mapping.api_next_handle_id);
  }
  if (
    handleMappings.length !== sourceHandleIds.size ||
    mappedHandleIds.size !== sourceHandleIds.size
  )
    throw new Error("manifest-handle-mapping-incomplete");
  const withoutDigest = {
    manifest_version: PUBLIC_PROFILE_BACKFILL_MANIFEST_VERSION,
    source: source as PublicProfileBackfillManifest["source"],
    rows,
    owner_mappings: ownerMappings,
    handle_mappings: handleMappings,
  } satisfies Omit<PublicProfileBackfillManifest, "manifest_sha256">;
  if (value.manifest_sha256 !== manifestDigest(withoutDigest))
    throw new Error("manifest-digest-mismatch");
  return { ...withoutDigest, manifest_sha256: value.manifest_sha256 };
}
