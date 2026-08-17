import {
  type LegacyGlobalHandleRow,
  makePublicProfileBackfillManifest,
  makePublicProfileTargetSnapshot,
  type PublicProfileTargetHandle,
  type PublicProfileTargetUser,
} from "./public-profile-backfill.ts";

const dates = {
  issued_at: "2026-08-16T00:00:00.000Z",
  replaced_at: null,
  created_at: "2026-08-16T00:00:00.000Z",
  updated_at: "2026-08-16T00:00:00.000Z",
} as const;

export function row(
  input: Partial<LegacyGlobalHandleRow> &
    Pick<LegacyGlobalHandleRow, "global_handle_id" | "user_id" | "label_normalized">,
): LegacyGlobalHandleRow {
  const { global_handle_id, user_id, label_normalized, ...overrides } = input;
  return {
    global_handle_id,
    user_id,
    label_normalized,
    label_display: `${label_normalized}.pirate`,
    status: "active",
    tier: "standard",
    issuance_source: "generated_signup",
    redirect_target_global_handle_id: null,
    price_paid_cents: null,
    free_rename_consumed: 0,
    ...dates,
    ...overrides,
  };
}

export function user(
  user_id: string,
  status: "active" | "deleted" = "active",
): PublicProfileTargetUser {
  return { user_id, status };
}

export function targetHandle(
  input: Partial<PublicProfileTargetHandle> &
    Pick<PublicProfileTargetHandle, "handle_id" | "owner_user_id" | "label_normalized">,
): PublicProfileTargetHandle {
  const { handle_id, owner_user_id, label_normalized, ...overrides } = input;
  return {
    handle_id,
    owner_user_id,
    label_normalized,
    label_display: `${label_normalized}.pirate`,
    status: "active",
    redirect_target_handle_id: null,
    ...overrides,
  };
}

export function manifest(rows: readonly LegacyGlobalHandleRow[]) {
  const ownerIds = [...new Set(rows.map((value) => value.user_id))].sort();
  return makePublicProfileBackfillManifest({
    snapshot_at: "2026-08-16T01:00:00.000Z",
    rows,
    owner_mappings: ownerIds.map((legacy_user_id) => ({
      legacy_user_id,
      api_next_user_id: legacy_user_id,
      legacy_owner_state: "active",
      reviewed: false,
    })),
    handle_mappings: rows.map((value) => ({
      legacy_handle_id: value.global_handle_id,
      api_next_handle_id: `target_${value.global_handle_id}`,
    })),
  });
}

export function mappedHandle(handleId: string): string {
  return `target_${handleId}`;
}

export function snapshot(
  users: readonly PublicProfileTargetUser[],
  handles: readonly PublicProfileTargetHandle[] = [],
) {
  return makePublicProfileTargetSnapshot({
    captured_at: "2026-08-16T02:00:00.000Z",
    users,
    handles,
  });
}
