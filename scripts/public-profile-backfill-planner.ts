import { parsePublicProfileBackfillManifest, validId } from "./public-profile-backfill-manifest";
import {
  parsePublicProfileTargetSnapshot,
  type TargetIssue,
  validateTargetSnapshot,
} from "./public-profile-backfill-target";
import {
  type BackfillIssueCode,
  type BackfillOperation,
  canonicalJson,
  type LegacyGlobalHandleRow,
  type PublicProfileBackfillManifest,
  type PublicProfileBackfillPlan,
  type PublicProfileBackfillReport,
  type PublicProfileTargetHandle,
  type PublicProfileTargetSnapshot,
  type PublicProfileTargetUser,
  REPORT_ITEM_LIMIT,
  sha256,
} from "./public-profile-backfill-types";

type Issue = Readonly<{ readonly code: BackfillIssueCode; readonly row: LegacyGlobalHandleRow }>;

const syntheticIssue = (issue: TargetIssue): Issue => issue;
const issueFingerprint = (
  sourceDigest: string,
  row: LegacyGlobalHandleRow,
  code: BackfillIssueCode,
): string => sha256(`${sourceDigest}\u0000${row.global_handle_id}\u0000${code}`);
const equalProjectedHandle = (
  row: LegacyGlobalHandleRow,
  target: PublicProfileTargetHandle,
  apiNextHandleId: string,
  apiNextOwnerUserId: string,
  apiNextRedirectTargetHandleId: string | null,
): boolean =>
  apiNextHandleId === target.handle_id &&
  row.label_normalized === target.label_normalized &&
  row.label_display === target.label_display &&
  row.status === target.status &&
  apiNextOwnerUserId === target.owner_user_id &&
  apiNextRedirectTargetHandleId === target.redirect_target_handle_id;

const cycleMemberIds = (rows: readonly LegacyGlobalHandleRow[]): ReadonlySet<string> => {
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
};

const sourceRowIssues = (
  row: LegacyGlobalHandleRow,
  sourceRowsById: ReadonlyMap<string, LegacyGlobalHandleRow>,
  ownerMappings: ReadonlyMap<string, string>,
  handleMappings: ReadonlyMap<string, string>,
  targetUsers: ReadonlyMap<string, PublicProfileTargetUser>,
  targetHandlesById: ReadonlyMap<string, PublicProfileTargetHandle>,
  targetHandlesByLabel: ReadonlyMap<string, PublicProfileTargetHandle>,
  targetActiveOwners: ReadonlyMap<string, PublicProfileTargetHandle>,
  cycleIds: ReadonlySet<string>,
): readonly BackfillIssueCode[] => {
  const errors: BackfillIssueCode[] = [];
  if (!validId(row.global_handle_id) || !validId(row.user_id)) errors.push("invalid-source-id");
  if (
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(row.label_normalized) ||
    row.label_normalized.length > 32 ||
    row.label_display !== `${row.label_normalized}.pirate`
  )
    errors.push("invalid-source-label");
  if (
    (row.status === "redirect" && row.redirect_target_global_handle_id === null) ||
    (row.status !== "redirect" && row.redirect_target_global_handle_id !== null) ||
    row.redirect_target_global_handle_id === row.global_handle_id
  )
    errors.push("invalid-source-status-target");
  const apiNextOwnerUserId = ownerMappings.get(row.user_id);
  if (apiNextOwnerUserId === undefined) errors.push("missing-owner-mapping");
  const owner = apiNextOwnerUserId === undefined ? undefined : targetUsers.get(apiNextOwnerUserId);
  if (apiNextOwnerUserId !== undefined && owner === undefined) errors.push("missing-owner");
  else if (owner !== undefined && owner.status !== "active") errors.push("owner-not-active");
  const apiNextHandleId = handleMappings.get(row.global_handle_id);
  if (apiNextHandleId === undefined) errors.push("missing-handle-mapping");
  const sourceTarget =
    row.redirect_target_global_handle_id === null
      ? undefined
      : sourceRowsById.get(row.redirect_target_global_handle_id);
  const target =
    row.redirect_target_global_handle_id === null
      ? undefined
      : (sourceTarget ??
        targetHandlesById.get(handleMappings.get(row.redirect_target_global_handle_id) ?? ""));
  if (row.status === "redirect") {
    if (cycleIds.has(row.global_handle_id)) errors.push("redirect-cycle");
    else if (target === undefined) errors.push("redirect-target-missing");
    else {
      const targetStatus = "status" in target ? target.status : undefined;
      const targetOwner =
        "user_id" in target ? ownerMappings.get(target.user_id) : target.owner_user_id;
      if (targetStatus !== "active") errors.push("redirect-target-not-active");
      if (targetOwner !== undefined && targetOwner !== apiNextOwnerUserId)
        errors.push("foreign-owner");
    }
  }
  if (
    row.status === "active" &&
    apiNextOwnerUserId !== undefined &&
    targetActiveOwners.get(apiNextOwnerUserId)?.handle_id !== undefined &&
    targetActiveOwners.get(apiNextOwnerUserId)?.handle_id !== apiNextHandleId
  )
    errors.push("active-owner-collision");
  const existingById =
    apiNextHandleId === undefined ? undefined : targetHandlesById.get(apiNextHandleId);
  const apiNextRedirectTargetHandleId =
    row.redirect_target_global_handle_id === null
      ? null
      : (handleMappings.get(row.redirect_target_global_handle_id) ?? null);
  if (
    apiNextHandleId !== undefined &&
    apiNextOwnerUserId !== undefined &&
    existingById !== undefined &&
    !equalProjectedHandle(
      row,
      existingById,
      apiNextHandleId,
      apiNextOwnerUserId,
      apiNextRedirectTargetHandleId,
    )
  ) {
    errors.push(
      existingById.owner_user_id !== apiNextOwnerUserId
        ? "ownership-transfer"
        : "target-handle-conflict",
    );
  }
  const existingByLabel = targetHandlesByLabel.get(row.label_normalized);
  if (existingByLabel !== undefined && existingByLabel.handle_id !== apiNextHandleId)
    errors.push("target-label-collision");
  return [...new Set(errors)];
};

const planDigest = (operations: readonly BackfillOperation[]): string =>
  sha256(
    canonicalJson(
      operations.map(
        ({
          kind,
          row,
          api_next_handle_id,
          api_next_owner_user_id,
          api_next_redirect_target_handle_id,
        }) => ({
          kind,
          handle_id: api_next_handle_id,
          label_normalized: row.label_normalized,
          label_display: row.label_display,
          status: row.status,
          owner_user_id: api_next_owner_user_id,
          redirect_target_handle_id: api_next_redirect_target_handle_id,
        }),
      ),
    ),
  );

const makeReport = (input: {
  readonly manifest: PublicProfileBackfillManifest;
  readonly target: PublicProfileTargetSnapshot;
  readonly operations: readonly BackfillOperation[];
  readonly issues: readonly Issue[];
  readonly skips: readonly Issue[];
}): PublicProfileBackfillReport => {
  const all = [...input.issues, ...input.skips].sort(
    (a, b) =>
      a.code.localeCompare(b.code) || a.row.global_handle_id.localeCompare(b.row.global_handle_id),
  );
  const issueCounts: Partial<Record<BackfillIssueCode, number>> = {};
  for (const issue of all) issueCounts[issue.code] = (issueCounts[issue.code] ?? 0) + 1;
  const fingerprints = all.map((issue) =>
    issueFingerprint(input.manifest.source.source_sha256, issue.row, issue.code),
  );
  return {
    report_version: 1,
    manifest_sha256: input.manifest.manifest_sha256,
    owner_mappings_sha256: input.manifest.owner_mappings_sha256,
    handle_mappings_sha256: input.manifest.handle_mappings_sha256,
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
    persisted_fields: [
      "handle_id",
      "label_normalized",
      "label_display",
      "status",
      "owner_user_id",
      "redirect_target_handle_id",
    ],
    omitted_source_fields: [
      "tier",
      "issuance_source",
      "price_paid_cents",
      "free_rename_consumed",
      "issued_at",
      "replaced_at",
      "created_at",
      "updated_at",
    ],
  };
};

export function planPublicProfileBackfill(
  rawManifest: unknown,
  rawTarget: unknown,
): PublicProfileBackfillPlan {
  const manifest = parsePublicProfileBackfillManifest(rawManifest);
  const target = parsePublicProfileTargetSnapshot(rawTarget);
  const issues: Issue[] = validateTargetSnapshot(target).map(syntheticIssue);
  const skips: Issue[] = [];
  const ownerMappings = new Map(
    manifest.owner_mappings.map((mapping) => [mapping.legacy_user_id, mapping.api_next_user_id]),
  );
  const handleMappings = new Map(
    manifest.handle_mappings.map((mapping) => [
      mapping.legacy_handle_id,
      mapping.api_next_handle_id,
    ]),
  );
  const sourceRowsById = new Map<string, LegacyGlobalHandleRow>();
  const sourceLabels = new Map<string, LegacyGlobalHandleRow>();
  const activeOwners = new Map<string, LegacyGlobalHandleRow[]>();
  const activeOwnerCollisionIds = new Set<string>();
  for (const row of manifest.rows) {
    if (sourceRowsById.has(row.global_handle_id))
      issues.push({ code: "duplicate-source-handle", row });
    sourceRowsById.set(row.global_handle_id, row);
    if (sourceLabels.has(row.label_normalized))
      issues.push({ code: "source-label-collision", row });
    sourceLabels.set(row.label_normalized, row);
    if (row.status === "active") {
      const mappedOwner = ownerMappings.get(row.user_id) ?? row.user_id;
      const rowsForOwner = activeOwners.get(mappedOwner) ?? [];
      rowsForOwner.push(row);
      activeOwners.set(mappedOwner, rowsForOwner);
    }
  }
  for (const rowsForOwner of activeOwners.values()) {
    if (rowsForOwner.length < 2) continue;
    for (const row of rowsForOwner) {
      issues.push({ code: "active-owner-collision", row });
      activeOwnerCollisionIds.add(row.global_handle_id);
    }
  }
  const targetUsers = new Map(target.users.map((user) => [user.user_id, user]));
  const targetHandlesById = new Map(target.handles.map((handle) => [handle.handle_id, handle]));
  const targetHandlesByLabel = new Map(
    target.handles.map((handle) => [handle.label_normalized, handle]),
  );
  const targetActiveOwners = new Map(
    target.handles
      .filter((handle) => handle.status === "active")
      .map((handle) => [handle.owner_user_id, handle]),
  );
  const cycles = cycleMemberIds(manifest.rows);
  const operations: BackfillOperation[] = [];
  for (const row of manifest.rows) {
    const rowErrors = sourceRowIssues(
      row,
      sourceRowsById,
      ownerMappings,
      handleMappings,
      targetUsers,
      targetHandlesById,
      targetHandlesByLabel,
      targetActiveOwners,
      cycles,
    );
    for (const code of rowErrors) issues.push({ code, row });
    if (rowErrors.length > 0 || activeOwnerCollisionIds.has(row.global_handle_id)) continue;
    const apiNextHandleId = handleMappings.get(row.global_handle_id);
    const apiNextOwnerUserId = ownerMappings.get(row.user_id);
    const apiNextRedirectTargetHandleId =
      row.redirect_target_global_handle_id === null
        ? null
        : (handleMappings.get(row.redirect_target_global_handle_id) ?? null);
    const existing =
      apiNextHandleId === undefined ? undefined : targetHandlesById.get(apiNextHandleId);
    if (
      existing !== undefined &&
      apiNextHandleId !== undefined &&
      apiNextOwnerUserId !== undefined
    ) {
      if (
        equalProjectedHandle(
          row,
          existing,
          apiNextHandleId,
          apiNextOwnerUserId,
          apiNextRedirectTargetHandleId,
        )
      )
        skips.push({ code: "target-handle-conflict", row });
      continue;
    }
    if (apiNextHandleId === undefined || apiNextOwnerUserId === undefined) continue;
    operations.push({
      kind: row.status === "redirect" ? "redirect" : "insert",
      row,
      api_next_handle_id: apiNextHandleId,
      api_next_owner_user_id: apiNextOwnerUserId,
      api_next_redirect_target_handle_id: apiNextRedirectTargetHandleId,
    });
  }
  operations.sort((left, right) => {
    const rank = (operation: BackfillOperation): number =>
      operation.kind === "redirect" ? 2 : operation.row.status === "active" ? 0 : 1;
    return (
      rank(left) - rank(right) ||
      left.row.global_handle_id.localeCompare(right.row.global_handle_id)
    );
  });
  const report = makeReport({ manifest, target, operations, issues, skips });
  return { manifest, target, operations, report };
}
