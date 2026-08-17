import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/**
 * A deliberately small, immutable export contract for the old
 * `global_handles` table.  The legacy table is the only source that can
 * truthfully tell us which labels existed before a rename.  A live legacy
 * database is not opened by this module: an operator must first produce and
 * review one of these manifests.
 */
export const PUBLIC_PROFILE_BACKFILL_MANIFEST_VERSION = 1 as const;
export const PUBLIC_PROFILE_BACKFILL_TARGET_VERSION = 1 as const;
export const PUBLIC_PROFILE_BACKFILL_REPORT_VERSION = 1 as const;

const sourceColumns = [
  "global_handle_id",
  "user_id",
  "label_normalized",
  "label_display",
  "status",
  "tier",
  "issuance_source",
  "redirect_target_global_handle_id",
  "issued_at",
  "replaced_at",
  "created_at",
  "updated_at",
] as const;

export type LegacyGlobalHandleRow = Readonly<{
  readonly global_handle_id: string;
  readonly user_id: string;
  readonly label_normalized: string;
  readonly label_display: string;
  readonly status: "active" | "redirect" | "retired";
  readonly tier: "generated" | "standard" | "premium";
  readonly issuance_source:
    | "generated_signup"
    | "free_cleanup_rename"
    | "reddit_verified_claim"
    | "paid_upgrade"
    | "admin_grant";
  readonly redirect_target_global_handle_id: string | null;
  readonly issued_at: string;
  readonly replaced_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}>;

export type PublicProfileBackfillManifest = Readonly<{
  readonly manifest_version: typeof PUBLIC_PROFILE_BACKFILL_MANIFEST_VERSION;
  readonly source: Readonly<{
    readonly system: "legacy-api";
    readonly relation: "global_handles";
    readonly snapshot_at: string;
    readonly columns: readonly typeof sourceColumns[number][];
    readonly row_count: number;
    readonly source_sha256: string;
  }>;
  readonly rows: readonly LegacyGlobalHandleRow[];
  readonly manifest_sha256: string;
}>;

export type PublicProfileTargetUser = Readonly<{
  readonly user_id: string;
  readonly status: "active" | "deleted";
}>;

export type PublicProfileTargetHandle = Readonly<{
  readonly handle_id: string;
  readonly label_normalized: string;
  readonly label_display: string;
  readonly status: "active" | "redirect" | "retired";
  readonly owner_user_id: string;
  readonly redirect_target_handle_id: string | null;
}>;

export type PublicProfileTargetSnapshot = Readonly<{
  readonly snapshot_version: typeof PUBLIC_PROFILE_BACKFILL_TARGET_VERSION;
  readonly captured_at: string;
  readonly users: readonly PublicProfileTargetUser[];
  readonly handles: readonly PublicProfileTargetHandle[];
  readonly snapshot_sha256: string;
}>;

export type BackfillIssueCode =
  | "duplicate-source-handle"
  | "source-label-collision"
  | "invalid-source-id"
  | "invalid-source-label"
  | "invalid-source-status-target"
  | "missing-owner"
  | "owner-not-active"
  | "foreign-owner"
  | "active-owner-collision"
  | "target-handle-conflict"
  | "ownership-transfer"
  | "target-label-collision"
  | "redirect-target-missing"
  | "redirect-target-not-active"
  | "redirect-cycle"
  | "target-snapshot-invalid"
  | "manifest-invalid";

export type BackfillOperation = Readonly<{
  readonly kind: "insert" | "redirect";
  readonly row: LegacyGlobalHandleRow;
}>;

export type PublicProfileBackfillReport = Readonly<{
  readonly report_version: typeof PUBLIC_PROFILE_BACKFILL_REPORT_VERSION;
  readonly manifest_sha256: string;
  readonly source_sha256: string;
  readonly target_snapshot_sha256: string;
  readonly plan_sha256: string;
  readonly counts: Readonly<{
    readonly inserts: number;
    readonly renames: number;
    readonly redirects: number;
    readonly skips: number;
    readonly errors: number;
  }>;
  readonly issue_counts: Readonly<Partial<Record<BackfillIssueCode, number>>>;
  /** SHA-256 fingerprints only; labels, user IDs and source payloads never appear. */
  readonly issue_fingerprints: readonly string[];
  readonly issue_fingerprints_truncated: boolean;
  readonly note: "renames-disabled-immutable-handle-ids";
}>;

export type PublicProfileBackfillPlan = Readonly<{
  readonly manifest: PublicProfileBackfillManifest;
  readonly target: PublicProfileTargetSnapshot;
  readonly operations: readonly BackfillOperation[];
  readonly report: PublicProfileBackfillReport;
}>;

export type PublicProfileBackfillQueryResult<Row> = Readonly<{
  readonly rows: readonly Row[];
}>;

export interface PublicProfileBackfillTransaction {
  readonly query: <Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ) => Promise<PublicProfileBackfillQueryResult<Row>>;
}

export interface PublicProfileBackfillDatabase {
  readonly withTransaction: <A>(
    run: (transaction: PublicProfileBackfillTransaction) => Promise<A>,
  ) => Promise<A>;
}

export type PublicProfileBackfillRunResult = Readonly<{
  readonly mode: "dry-run" | "apply";
  readonly report: PublicProfileBackfillReport;
  readonly applied: number;
}>;

const REPORT_ITEM_LIMIT = 256;
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/** JSON canonicalization used for both source and plan checksums. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Cannot canonicalize a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  throw new Error(`Cannot canonicalize ${typeof value}`);
}

const rowSort = (left: LegacyGlobalHandleRow, right: LegacyGlobalHandleRow): number =>
  left.global_handle_id.localeCompare(right.global_handle_id) ||
  canonicalJson(left).localeCompare(canonicalJson(right));

const sortedRows = (rows: readonly LegacyGlobalHandleRow[]): readonly LegacyGlobalHandleRow[] =>
  [...rows].sort(rowSort);

const manifestWithoutDigest = (
  manifest: Omit<PublicProfileBackfillManifest, "manifest_sha256">,
): Omit<PublicProfileBackfillManifest, "manifest_sha256"> => manifest;

const manifestDigest = (
  manifest: Omit<PublicProfileBackfillManifest, "manifest_sha256">,
): string => sha256(canonicalJson(manifestWithoutDigest(manifest)));

const targetWithoutDigest = (
  target: Omit<PublicProfileTargetSnapshot, "snapshot_sha256">,
): Omit<PublicProfileTargetSnapshot, "snapshot_sha256"> => target;

const targetDigest = (
  target: Omit<PublicProfileTargetSnapshot, "snapshot_sha256">,
): string => sha256(canonicalJson(targetWithoutDigest(target)));

export function makePublicProfileBackfillManifest(input: {
  readonly snapshot_at: string;
  readonly rows: readonly LegacyGlobalHandleRow[];
}): PublicProfileBackfillManifest {
  const rows = sortedRows(input.rows);
  const source = {
    system: "legacy-api" as const,
    relation: "global_handles" as const,
    snapshot_at: input.snapshot_at,
    columns: sourceColumns,
    row_count: rows.length,
    source_sha256: sha256(canonicalJson(rows)),
  };
  const withoutDigest = {
    manifest_version: PUBLIC_PROFILE_BACKFILL_MANIFEST_VERSION,
    source,
    rows,
  } satisfies Omit<PublicProfileBackfillManifest, "manifest_sha256">;
  return { ...withoutDigest, manifest_sha256: manifestDigest(withoutDigest) };
}

export function makePublicProfileTargetSnapshot(input: {
  readonly captured_at: string;
  readonly users: readonly PublicProfileTargetUser[];
  readonly handles: readonly PublicProfileTargetHandle[];
}): PublicProfileTargetSnapshot {
  const withoutDigest = {
    snapshot_version: PUBLIC_PROFILE_BACKFILL_TARGET_VERSION,
    captured_at: input.captured_at,
    users: [...input.users].sort((left, right) => left.user_id.localeCompare(right.user_id)),
    handles: [...input.handles].sort((left, right) => left.handle_id.localeCompare(right.handle_id)),
  } satisfies Omit<PublicProfileTargetSnapshot, "snapshot_sha256">;
  return { ...withoutDigest, snapshot_sha256: targetDigest(withoutDigest) };
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
};

const validDigest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);

const validId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 256 &&
  value === value.trim() &&
  [...value].every((character) => {
    const code = character.charCodeAt(0);
    return code >= 0x20 && code !== 0x7f && code !== 0xfffd;
  });

const validDate = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));

const statuses = ["active", "redirect", "retired"] as const;
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

function parseLegacyRow(value: unknown): LegacyGlobalHandleRow {
  if (!record(value) || !hasExactKeys(value, sourceColumns)) throw new Error("manifest-invalid-row-shape");
  const row = value;
  if (
    !validId(row.global_handle_id) ||
    !validId(row.user_id) ||
    !validId(row.label_normalized) ||
    !validId(row.label_display) ||
    !isOneOf(statuses, row.status) ||
    !isOneOf(tiers, row.tier) ||
    !isOneOf(issuanceSources, row.issuance_source) ||
    !validDate(row.issued_at) ||
    !validDate(row.created_at) ||
    !validDate(row.updated_at) ||
    (row.replaced_at !== null && !validDate(row.replaced_at)) ||
    (row.redirect_target_global_handle_id !== null && !validId(row.redirect_target_global_handle_id))
  ) {
    throw new Error("manifest-invalid-row-value");
  }
  return row as LegacyGlobalHandleRow;
}

export function parsePublicProfileBackfillManifest(value: unknown): PublicProfileBackfillManifest {
  if (!record(value) || !hasExactKeys(value, ["manifest_version", "source", "rows", "manifest_sha256"])) {
    throw new Error("manifest-invalid-shape");
  }
  if (value.manifest_version !== PUBLIC_PROFILE_BACKFILL_MANIFEST_VERSION || !validDigest(value.manifest_sha256)) {
    throw new Error("manifest-invalid-version-or-digest");
  }
  if (!record(value.source) || !hasExactKeys(value.source, ["system", "relation", "snapshot_at", "columns", "row_count", "source_sha256"])) {
    throw new Error("manifest-invalid-source-shape");
  }
  const source = value.source;
  const rowCount = typeof source.row_count === "number" ? source.row_count : Number.NaN;
  if (
    source.system !== "legacy-api" ||
    source.relation !== "global_handles" ||
    !validDate(source.snapshot_at) ||
    !Array.isArray(source.columns) ||
    source.columns.length !== sourceColumns.length ||
    source.columns.some((column, index) => column !== sourceColumns[index]) ||
    !Number.isSafeInteger(rowCount) ||
    rowCount < 0 ||
    !validDigest(source.source_sha256) ||
    !Array.isArray(value.rows) ||
    value.rows.length !== rowCount
  ) {
    throw new Error("manifest-invalid-source");
  }
  const rows = value.rows.map(parseLegacyRow);
  const sorted = sortedRows(rows);
  if (canonicalJson(rows) !== canonicalJson(sorted)) throw new Error("manifest-rows-not-canonical");
  if (source.source_sha256 !== sha256(canonicalJson(rows))) throw new Error("manifest-source-digest-mismatch");
  const withoutDigest = {
    manifest_version: PUBLIC_PROFILE_BACKFILL_MANIFEST_VERSION,
    source: source as PublicProfileBackfillManifest["source"],
    rows,
  } satisfies Omit<PublicProfileBackfillManifest, "manifest_sha256">;
  if (value.manifest_sha256 !== manifestDigest(withoutDigest)) throw new Error("manifest-digest-mismatch");
  return { ...withoutDigest, manifest_sha256: value.manifest_sha256 };
}

export function parsePublicProfileTargetSnapshot(value: unknown): PublicProfileTargetSnapshot {
  if (!record(value) || !hasExactKeys(value, ["snapshot_version", "captured_at", "users", "handles", "snapshot_sha256"])) {
    throw new Error("target-snapshot-invalid-shape");
  }
  if (value.snapshot_version !== PUBLIC_PROFILE_BACKFILL_TARGET_VERSION || !validDigest(value.snapshot_sha256)) {
    throw new Error("target-snapshot-invalid-version-or-digest");
  }
  if (!validDate(value.captured_at) || !Array.isArray(value.users) || !Array.isArray(value.handles)) {
    throw new Error("target-snapshot-invalid-fields");
  }
  const users: PublicProfileTargetUser[] = [];
  for (const entry of value.users) {
    if (!record(entry) || !hasExactKeys(entry, ["user_id", "status"]) || !validId(entry.user_id) || !isOneOf(["active", "deleted"], entry.status)) {
      throw new Error("target-snapshot-invalid-user");
    }
    users.push(entry as PublicProfileTargetUser);
  }
  const handles: PublicProfileTargetHandle[] = [];
  for (const entry of value.handles) {
    if (
      !record(entry) ||
      !hasExactKeys(entry, ["handle_id", "label_normalized", "label_display", "status", "owner_user_id", "redirect_target_handle_id"]) ||
      !validId(entry.handle_id) ||
      !validId(entry.label_normalized) ||
      !validId(entry.label_display) ||
      !isOneOf(statuses, entry.status) ||
      !validId(entry.owner_user_id) ||
      (entry.redirect_target_handle_id !== null && !validId(entry.redirect_target_handle_id))
    ) {
      throw new Error("target-snapshot-invalid-handle");
    }
    handles.push(entry as PublicProfileTargetHandle);
  }
  const normalized = makePublicProfileTargetSnapshot({
    captured_at: value.captured_at,
    users,
    handles,
  });
  if (normalized.snapshot_sha256 !== value.snapshot_sha256) throw new Error("target-snapshot-digest-mismatch");
  return normalized;
}

const issueFingerprint = (sourceDigest: string, row: LegacyGlobalHandleRow, code: BackfillIssueCode): string =>
  sha256(`${sourceDigest}\u0000${row.global_handle_id}\u0000${code}`);

type Issue = Readonly<{ readonly code: BackfillIssueCode; readonly row: LegacyGlobalHandleRow }>;

const equalProjectedHandle = (row: LegacyGlobalHandleRow, target: PublicProfileTargetHandle): boolean =>
  row.global_handle_id === target.handle_id &&
  row.label_normalized === target.label_normalized &&
  row.label_display === target.label_display &&
  row.status === target.status &&
  row.user_id === target.owner_user_id &&
  row.redirect_target_global_handle_id === target.redirect_target_handle_id;

const validTargetLabel = (handle: PublicProfileTargetHandle): boolean =>
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(handle.label_normalized) &&
  handle.label_normalized.length <= 32 &&
  handle.label_display === `${handle.label_normalized}.pirate`;

function validateTargetSnapshot(target: PublicProfileTargetSnapshot): readonly Issue[] {
  const issues: Issue[] = [];
  const seenIds = new Set<string>();
  const seenLabels = new Set<string>();
  const users = new Set<string>();
  const activeOwners = new Set<string>();
  const handlesById = new Map<string, PublicProfileTargetHandle>();
  for (const user of target.users) {
    if (!validId(user.user_id) || users.has(user.user_id)) {
      issues.push({ code: "target-snapshot-invalid", row: syntheticRow(`target-user:${user.user_id}`) });
    }
    users.add(user.user_id);
  }
  for (const handle of target.handles) handlesById.set(handle.handle_id, handle);
  for (const handle of target.handles) {
    const row = syntheticRow(handle.handle_id);
    if (
      !validId(handle.handle_id) ||
      seenIds.has(handle.handle_id) ||
      !validTargetLabel(handle) ||
      !validId(handle.owner_user_id) ||
      (handle.redirect_target_handle_id !== null && !validId(handle.redirect_target_handle_id))
    ) {
      issues.push({ code: "target-snapshot-invalid", row });
    }
    if (seenLabels.has(handle.label_normalized)) issues.push({ code: "target-snapshot-invalid", row });
    seenIds.add(handle.handle_id);
    seenLabels.add(handle.label_normalized);
    if (!users.has(handle.owner_user_id)) issues.push({ code: "target-snapshot-invalid", row });
    if (handle.status === "active" && activeOwners.has(handle.owner_user_id)) {
      issues.push({ code: "target-snapshot-invalid", row });
    }
    if (handle.status === "active") activeOwners.add(handle.owner_user_id);
    if (handle.status === "active" && handle.redirect_target_handle_id !== null) {
      issues.push({ code: "target-snapshot-invalid", row });
    }
    if (handle.status === "redirect" && handle.redirect_target_handle_id === null) {
      issues.push({ code: "target-snapshot-invalid", row });
    }
    if (handle.status === "retired" && handle.redirect_target_handle_id !== null) {
      issues.push({ code: "target-snapshot-invalid", row });
    }
    if (handle.status === "redirect" && handle.redirect_target_handle_id !== null) {
      const targetHandle = handlesById.get(handle.redirect_target_handle_id);
      if (
        targetHandle === undefined ||
        targetHandle.status !== "active" ||
        targetHandle.owner_user_id !== handle.owner_user_id ||
        targetHandle.handle_id === handle.handle_id
      ) {
        issues.push({ code: "target-snapshot-invalid", row });
      }
    }
  }
  return issues;
}

function syntheticRow(id: string): LegacyGlobalHandleRow {
  const safeId = id.length > 0 ? id : "target-snapshot";
  return {
    global_handle_id: safeId,
    user_id: "target-snapshot",
    label_normalized: "target-snapshot",
    label_display: "target-snapshot.pirate",
    status: "retired",
    tier: "generated",
    issuance_source: "admin_grant",
    redirect_target_global_handle_id: null,
    issued_at: "1970-01-01T00:00:00.000Z",
    replaced_at: null,
    created_at: "1970-01-01T00:00:00.000Z",
    updated_at: "1970-01-01T00:00:00.000Z",
  };
}

function sourceRowIssues(
  row: LegacyGlobalHandleRow,
  sourceRowsById: ReadonlyMap<string, LegacyGlobalHandleRow>,
  targetUsers: ReadonlyMap<string, PublicProfileTargetUser>,
  targetHandlesById: ReadonlyMap<string, PublicProfileTargetHandle>,
  targetHandlesByLabel: ReadonlyMap<string, PublicProfileTargetHandle>,
  targetActiveOwners: ReadonlyMap<string, PublicProfileTargetHandle>,
  cycleIds: ReadonlySet<string>,
): readonly BackfillIssueCode[] {
  const errors: BackfillIssueCode[] = [];
  if (!validId(row.global_handle_id) || !validId(row.user_id)) errors.push("invalid-source-id");
  if (
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(row.label_normalized) ||
    row.label_normalized.length > 32 ||
    row.label_display !== `${row.label_normalized}.pirate`
  ) {
    errors.push("invalid-source-label");
  }
  const expectedTarget = row.status === "redirect";
  if (
    (expectedTarget && row.redirect_target_global_handle_id === null) ||
    (!expectedTarget && row.redirect_target_global_handle_id !== null) ||
    row.redirect_target_global_handle_id === row.global_handle_id
  ) {
    errors.push("invalid-source-status-target");
  }
  const owner = targetUsers.get(row.user_id);
  if (owner === undefined) errors.push("missing-owner");
  else if (owner.status !== "active") errors.push("owner-not-active");

  const sourceTarget = row.redirect_target_global_handle_id === null
    ? undefined
    : sourceRowsById.get(row.redirect_target_global_handle_id);
  const target = row.redirect_target_global_handle_id === null
    ? undefined
    : sourceTarget ?? targetHandlesById.get(row.redirect_target_global_handle_id);
  if (row.status === "redirect") {
    if (cycleIds.has(row.global_handle_id)) errors.push("redirect-cycle");
    else if (target === undefined) errors.push("redirect-target-missing");
    else {
      const targetStatus = "status" in target ? target.status : undefined;
      const targetOwner = "user_id" in target ? target.user_id : target.owner_user_id;
      if (targetStatus !== "active") errors.push("redirect-target-not-active");
      if (targetOwner !== row.user_id) errors.push("foreign-owner");
    }
  }
  if (
    row.status === "active" &&
    targetActiveOwners.get(row.user_id)?.handle_id !== undefined &&
    targetActiveOwners.get(row.user_id)?.handle_id !== row.global_handle_id
  ) {
    errors.push("active-owner-collision");
  }
  const existingById = targetHandlesById.get(row.global_handle_id);
  if (existingById !== undefined && !equalProjectedHandle(row, existingById)) {
    if (existingById.owner_user_id !== row.user_id) errors.push("ownership-transfer");
    else errors.push("target-handle-conflict");
  }
  const existingByLabel = targetHandlesByLabel.get(row.label_normalized);
  if (existingByLabel !== undefined && existingByLabel.handle_id !== row.global_handle_id) {
    errors.push("target-label-collision");
  }
  return [...new Set(errors)];
}

function cycleMemberIds(rows: readonly LegacyGlobalHandleRow[]): ReadonlySet<string> {
  const byId = new Map(rows.map((row) => [row.global_handle_id, row]));
  const cycles = new Set<string>();
  for (const row of rows) {
    if (row.status !== "redirect" || row.redirect_target_global_handle_id === null) continue;
    const path: string[] = [];
    const seen = new Map<string, number>();
    let current: LegacyGlobalHandleRow | undefined = row;
    while (current?.status === "redirect" && current.redirect_target_global_handle_id !== null) {
      const id = current.global_handle_id;
      const previous = seen.get(id);
      if (previous !== undefined) {
        for (const member of path.slice(previous)) cycles.add(member);
        break;
      }
      seen.set(id, path.length);
      path.push(id);
      current = byId.get(current.redirect_target_global_handle_id);
    }
  }
  return cycles;
}

const planDigest = (operations: readonly BackfillOperation[]): string =>
  sha256(canonicalJson(operations.map(({ kind, row }) => ({
    kind,
    handle_id: row.global_handle_id,
    label_normalized: row.label_normalized,
    label_display: row.label_display,
    status: row.status,
    owner_user_id: row.user_id,
    redirect_target_handle_id: row.redirect_target_global_handle_id,
  }))));

function makeReport(input: {
  readonly manifest: PublicProfileBackfillManifest;
  readonly target: PublicProfileTargetSnapshot;
  readonly operations: readonly BackfillOperation[];
  readonly issues: readonly Issue[];
  readonly skips: readonly Issue[];
}): PublicProfileBackfillReport {
  const all = [...input.issues, ...input.skips].sort(
    (left, right) => left.code.localeCompare(right.code) || left.row.global_handle_id.localeCompare(right.row.global_handle_id),
  );
  const issueCounts: Partial<Record<BackfillIssueCode, number>> = {};
  for (const issue of all) issueCounts[issue.code] = (issueCounts[issue.code] ?? 0) + 1;
  const fingerprints = all.map((issue) => issueFingerprint(input.manifest.source.source_sha256, issue.row, issue.code));
  return {
    report_version: PUBLIC_PROFILE_BACKFILL_REPORT_VERSION,
    manifest_sha256: input.manifest.manifest_sha256,
    source_sha256: input.manifest.source.source_sha256,
    target_snapshot_sha256: input.target.snapshot_sha256,
    plan_sha256: planDigest(input.operations),
    counts: {
      inserts: input.operations.filter(({ kind }) => kind === "insert").length,
      renames: 0,
      redirects: input.operations.filter(({ kind }) => kind === "redirect").length,
      skips: input.skips.length,
      errors: input.issues.length,
    },
    issue_counts: issueCounts,
    issue_fingerprints: fingerprints.slice(0, REPORT_ITEM_LIMIT),
    issue_fingerprints_truncated: fingerprints.length > REPORT_ITEM_LIMIT,
    note: "renames-disabled-immutable-handle-ids",
  };
}

/** Build a fail-closed plan from an immutable source export and target snapshot. */
export function planPublicProfileBackfill(
  rawManifest: unknown,
  rawTarget: unknown,
): PublicProfileBackfillPlan {
  const manifest = parsePublicProfileBackfillManifest(rawManifest);
  const target = parsePublicProfileTargetSnapshot(rawTarget);
  const targetIssues = validateTargetSnapshot(target);
  const rows = manifest.rows;
  const sourceRowsById = new Map<string, LegacyGlobalHandleRow>();
  const sourceLabels = new Map<string, LegacyGlobalHandleRow>();
  const activeOwners = new Map<string, LegacyGlobalHandleRow>();
  const issues: Issue[] = [...targetIssues];
  const skips: Issue[] = [];

  for (const row of rows) {
    if (sourceRowsById.has(row.global_handle_id)) issues.push({ code: "duplicate-source-handle", row });
    sourceRowsById.set(row.global_handle_id, row);
    const previous = sourceLabels.get(row.label_normalized);
    if (previous !== undefined) issues.push({ code: "source-label-collision", row });
    sourceLabels.set(row.label_normalized, row);
    if (row.status === "active") {
      const priorOwner = activeOwners.get(row.user_id);
      if (priorOwner !== undefined) issues.push({ code: "active-owner-collision", row });
      activeOwners.set(row.user_id, row);
    }
  }
  const targetUsers = new Map(target.users.map((user) => [user.user_id, user]));
  const targetHandlesById = new Map(target.handles.map((handle) => [handle.handle_id, handle]));
  const targetHandlesByLabel = new Map(target.handles.map((handle) => [handle.label_normalized, handle]));
  const targetActiveOwners = new Map(
    target.handles
      .filter((handle) => handle.status === "active")
      .map((handle) => [handle.owner_user_id, handle]),
  );
  const cycles = cycleMemberIds(rows);
  const operations: BackfillOperation[] = [];

  for (const row of rows) {
    const rowErrors = sourceRowIssues(
      row,
      sourceRowsById,
      targetUsers,
      targetHandlesById,
      targetHandlesByLabel,
      targetActiveOwners,
      cycles,
    );
    for (const code of rowErrors) issues.push({ code, row });
    if (rowErrors.length > 0) continue;
    const existing = targetHandlesById.get(row.global_handle_id);
    if (existing !== undefined) {
      if (equalProjectedHandle(row, existing)) skips.push({ code: "target-handle-conflict", row });
      continue;
    }
    operations.push({ kind: row.status === "redirect" ? "redirect" : "insert", row });
  }

  operations.sort((left, right) => {
    const rank = (operation: BackfillOperation): number => operation.kind === "redirect" ? 2 : operation.row.status === "active" ? 0 : 1;
    return rank(left) - rank(right) || left.row.global_handle_id.localeCompare(right.row.global_handle_id);
  });
  const report = makeReport({ manifest, target, operations, issues, skips });
  return { manifest, target, operations, report };
}

export async function readPublicProfileBackfillTargetSnapshot(
  transaction: PublicProfileBackfillTransaction,
  capturedAt = new Date().toISOString(),
): Promise<PublicProfileTargetSnapshot> {
  const users = await transaction.query<PublicProfileTargetUser>(
    "SELECT user_id, status FROM users ORDER BY user_id ASC",
  );
  const handles = await transaction.query<PublicProfileTargetHandle>(
    "SELECT handle_id, label_normalized, label_display, status, owner_user_id, redirect_target_handle_id FROM public_handle_index ORDER BY handle_id ASC",
  );
  return makePublicProfileTargetSnapshot({ captured_at: capturedAt, users: users.rows, handles: handles.rows });
}

const insertSql = `INSERT INTO public_handle_index
  (handle_id, label_normalized, label_display, status, owner_user_id, redirect_target_handle_id)
  VALUES ($1, $2, $3, $4, $5, $6)`;

/** Apply only a clean plan, inside one caller-owned transaction. */
export async function applyPublicProfileBackfillPlan(
  plan: PublicProfileBackfillPlan,
  transaction: PublicProfileBackfillTransaction,
): Promise<number> {
  if (plan.report.counts.errors !== 0) throw new Error("public-profile-backfill-plan-has-errors");
  for (const operation of plan.operations) {
    const row = operation.row;
    await transaction.query(insertSql, [
      row.global_handle_id,
      row.label_normalized,
      row.label_display,
      row.status,
      row.user_id,
      row.redirect_target_global_handle_id,
    ]);
  }
  return plan.operations.length;
}

/**
 * Dry-run requires a previously reviewed target snapshot and never opens a
 * database. Apply reads the target inside the same transaction it writes.
 */
export async function runPublicProfileBackfill(input: {
  readonly manifest: unknown;
  readonly mode: "dry-run";
  readonly target: unknown;
} | {
  readonly manifest: unknown;
  readonly mode: "apply";
  readonly database: PublicProfileBackfillDatabase;
}): Promise<PublicProfileBackfillRunResult> {
  if (input.mode === "dry-run") {
    const plan = planPublicProfileBackfill(input.manifest, input.target);
    return { mode: "dry-run", report: plan.report, applied: 0 };
  }
  return input.database.withTransaction(async (transaction) => {
    const target = await readPublicProfileBackfillTargetSnapshot(transaction);
    const plan = planPublicProfileBackfill(input.manifest, target);
    const applied = await applyPublicProfileBackfillPlan(plan, transaction);
    return { mode: "apply", report: plan.report, applied };
  });
}

export async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

export function formatPublicProfileBackfillReport(report: PublicProfileBackfillReport): string {
  return JSON.stringify(report, null, 2);
}

export async function main(args: readonly string[] = Bun.argv.slice(2)): Promise<void> {
  if (args.length !== 3 || args[0] !== "--dry-run" || args[1] !== "--manifest" || args[2] === undefined) {
    throw new Error("Usage: bun scripts/public-profile-backfill.ts --dry-run --manifest PATH");
  }
  const manifest = await readJsonFile(args[2]);
  const targetPath = process.env.PUBLIC_PROFILE_BACKFILL_TARGET_SNAPSHOT;
  if (targetPath === undefined || targetPath.trim() === "") {
    throw new Error(
      "PUBLIC_PROFILE_BACKFILL_TARGET_SNAPSHOT is required for dry-run; capture a reviewed api-next target snapshot first",
    );
  }
  const target = await readJsonFile(targetPath);
  const result = await runPublicProfileBackfill({ mode: "dry-run", manifest, target });
  console.log(formatPublicProfileBackfillReport(result.report));
  console.log("Dry run: no database connection opened and no writes performed.");
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Public-profile backfill failed");
    process.exitCode = 1;
  });
}
