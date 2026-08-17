import { statuses, validId, validTimestamp } from "./public-profile-backfill-manifest";
import {
  PUBLIC_PROFILE_BACKFILL_TARGET_VERSION,
  type PublicProfileTargetHandle,
  type PublicProfileTargetSnapshot,
  type PublicProfileTargetUser,
  targetDigest,
} from "./public-profile-backfill-types";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const hasExactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
};
const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === "string" && values.includes(value as T);
const validDigest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);

export function makePublicProfileTargetSnapshot(input: {
  readonly captured_at: string;
  readonly users: readonly PublicProfileTargetUser[];
  readonly handles: readonly PublicProfileTargetHandle[];
}): PublicProfileTargetSnapshot {
  const withoutDigest = {
    snapshot_version: PUBLIC_PROFILE_BACKFILL_TARGET_VERSION,
    captured_at: input.captured_at,
    users: [...input.users].sort((a, b) => a.user_id.localeCompare(b.user_id)),
    handles: [...input.handles].sort((a, b) => a.handle_id.localeCompare(b.handle_id)),
  } satisfies Omit<PublicProfileTargetSnapshot, "snapshot_sha256">;
  if (!validTimestamp(withoutDigest.captured_at))
    throw new Error("invalid-rfc3339-timestamp:target.captured_at");
  return { ...withoutDigest, snapshot_sha256: targetDigest(withoutDigest) };
}

export function parsePublicProfileTargetSnapshot(value: unknown): PublicProfileTargetSnapshot {
  if (
    !record(value) ||
    !hasExactKeys(value, [
      "snapshot_version",
      "captured_at",
      "users",
      "handles",
      "snapshot_sha256",
    ]) ||
    value.snapshot_version !== PUBLIC_PROFILE_BACKFILL_TARGET_VERSION ||
    !validDigest(value.snapshot_sha256) ||
    !validTimestamp(value.captured_at) ||
    !Array.isArray(value.users) ||
    !Array.isArray(value.handles)
  )
    throw new Error("target-snapshot-invalid-shape");
  const users: PublicProfileTargetUser[] = [];
  for (const entry of value.users) {
    if (
      !record(entry) ||
      !hasExactKeys(entry, ["user_id", "status"]) ||
      !validId(entry.user_id) ||
      !isOneOf(["active", "deleted"], entry.status)
    )
      throw new Error("target-snapshot-invalid-user");
    users.push(entry as PublicProfileTargetUser);
  }
  const handles: PublicProfileTargetHandle[] = [];
  for (const entry of value.handles) {
    if (
      !record(entry) ||
      !hasExactKeys(entry, [
        "handle_id",
        "label_normalized",
        "label_display",
        "status",
        "owner_user_id",
        "redirect_target_handle_id",
      ]) ||
      !validId(entry.handle_id) ||
      !validId(entry.label_normalized) ||
      !validId(entry.label_display) ||
      !isOneOf(statuses, entry.status) ||
      !validId(entry.owner_user_id) ||
      (entry.redirect_target_handle_id !== null && !validId(entry.redirect_target_handle_id))
    )
      throw new Error("target-snapshot-invalid-handle");
    handles.push(entry as PublicProfileTargetHandle);
  }
  const normalized = makePublicProfileTargetSnapshot({
    captured_at: value.captured_at,
    users,
    handles,
  });
  if (normalized.snapshot_sha256 !== value.snapshot_sha256)
    throw new Error("target-snapshot-digest-mismatch");
  return normalized;
}

export type TargetIssue = Readonly<{
  readonly code: "target-snapshot-invalid";
  readonly row: import("./public-profile-backfill-types").LegacyGlobalHandleRow;
}>;

const syntheticRow = (
  id: string,
): import("./public-profile-backfill-types").LegacyGlobalHandleRow => ({
  global_handle_id: id || "target-snapshot",
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
});

const validTargetLabel = (handle: PublicProfileTargetHandle): boolean =>
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(handle.label_normalized) &&
  handle.label_normalized.length <= 32 &&
  handle.label_display === `${handle.label_normalized}.pirate`;

export function validateTargetSnapshot(
  target: PublicProfileTargetSnapshot,
): readonly TargetIssue[] {
  const issues: TargetIssue[] = [];
  const seenIds = new Set<string>();
  const seenLabels = new Set<string>();
  const users = new Set<string>();
  const activeOwners = new Set<string>();
  const handlesById = new Map(target.handles.map((handle) => [handle.handle_id, handle]));
  for (const user of target.users) {
    if (!validId(user.user_id) || users.has(user.user_id))
      issues.push({
        code: "target-snapshot-invalid",
        row: syntheticRow(`target-user:${user.user_id}`),
      });
    users.add(user.user_id);
  }
  for (const handle of target.handles) {
    const row = syntheticRow(handle.handle_id);
    if (
      !validId(handle.handle_id) ||
      seenIds.has(handle.handle_id) ||
      !validTargetLabel(handle) ||
      !validId(handle.owner_user_id) ||
      (handle.redirect_target_handle_id !== null && !validId(handle.redirect_target_handle_id))
    )
      issues.push({ code: "target-snapshot-invalid", row });
    if (seenLabels.has(handle.label_normalized))
      issues.push({ code: "target-snapshot-invalid", row });
    seenIds.add(handle.handle_id);
    seenLabels.add(handle.label_normalized);
    if (!users.has(handle.owner_user_id)) issues.push({ code: "target-snapshot-invalid", row });
    if (handle.status === "active" && activeOwners.has(handle.owner_user_id))
      issues.push({ code: "target-snapshot-invalid", row });
    if (handle.status === "active") activeOwners.add(handle.owner_user_id);
    if (
      (handle.status === "active" && handle.redirect_target_handle_id !== null) ||
      (handle.status === "redirect" && handle.redirect_target_handle_id === null) ||
      (handle.status === "retired" && handle.redirect_target_handle_id !== null)
    )
      issues.push({ code: "target-snapshot-invalid", row });
    if (handle.status === "redirect" && handle.redirect_target_handle_id !== null) {
      const redirectTarget = handlesById.get(handle.redirect_target_handle_id);
      if (
        redirectTarget === undefined ||
        redirectTarget.status !== "active" ||
        redirectTarget.owner_user_id !== handle.owner_user_id ||
        redirectTarget.handle_id === handle.handle_id
      )
        issues.push({ code: "target-snapshot-invalid", row });
    }
  }
  return issues;
}
