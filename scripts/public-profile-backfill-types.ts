import { createHash } from "node:crypto";

export const PUBLIC_PROFILE_BACKFILL_MANIFEST_VERSION = 1 as const;
export const PUBLIC_PROFILE_BACKFILL_TARGET_VERSION = 1 as const;
export const PUBLIC_PROFILE_BACKFILL_REPORT_VERSION = 1 as const;

export const sourceColumns = [
  "global_handle_id",
  "user_id",
  "label_normalized",
  "label_display",
  "status",
  "tier",
  "issuance_source",
  "redirect_target_global_handle_id",
  "price_paid_cents",
  "free_rename_consumed",
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
  readonly price_paid_cents: number | null;
  readonly free_rename_consumed: 0 | 1;
  readonly issued_at: string;
  readonly replaced_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}>;

export type LegacyOwnerMapping = Readonly<{
  readonly legacy_user_id: string;
  readonly api_next_user_id: string;
  readonly legacy_owner_state: "active" | "merged" | "tombstoned";
  readonly reviewed: boolean;
}>;

export type LegacyHandleMapping = Readonly<{
  readonly legacy_handle_id: string;
  readonly api_next_handle_id: string;
}>;

export type PublicProfileBackfillManifest = Readonly<{
  readonly manifest_version: typeof PUBLIC_PROFILE_BACKFILL_MANIFEST_VERSION;
  readonly source: Readonly<{
    readonly system: "legacy-api";
    readonly relation: "global_handles";
    readonly snapshot_at: string;
    readonly columns: readonly (typeof sourceColumns)[number][];
    readonly row_count: number;
    readonly source_sha256: string;
  }>;
  readonly rows: readonly LegacyGlobalHandleRow[];
  readonly owner_mappings: readonly LegacyOwnerMapping[];
  readonly handle_mappings: readonly LegacyHandleMapping[];
  readonly owner_mappings_sha256: string;
  readonly handle_mappings_sha256: string;
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
  | "missing-owner-mapping"
  | "owner-not-active"
  | "foreign-owner"
  | "active-owner-collision"
  | "target-handle-conflict"
  | "ownership-transfer"
  | "target-label-collision"
  | "missing-handle-mapping"
  | "redirect-target-missing"
  | "redirect-target-not-active"
  | "redirect-cycle"
  | "target-snapshot-invalid"
  | "manifest-invalid";

export type BackfillOperation = Readonly<{
  readonly kind: "insert" | "redirect";
  readonly row: LegacyGlobalHandleRow;
  readonly api_next_handle_id: string;
  readonly api_next_owner_user_id: string;
  readonly api_next_redirect_target_handle_id: string | null;
}>;

export type PublicProfileBackfillReport = Readonly<{
  readonly report_version: typeof PUBLIC_PROFILE_BACKFILL_REPORT_VERSION;
  readonly manifest_sha256: string;
  readonly owner_mappings_sha256: string;
  readonly handle_mappings_sha256: string;
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
  readonly issue_fingerprints: readonly string[];
  readonly issue_fingerprints_truncated: boolean;
  readonly note: "renames-disabled-immutable-handle-ids";
  readonly persisted_fields: readonly [
    "handle_id",
    "label_normalized",
    "label_display",
    "status",
    "owner_user_id",
    "redirect_target_handle_id",
  ];
  readonly omitted_source_fields: readonly [
    "tier",
    "issuance_source",
    "price_paid_cents",
    "free_rename_consumed",
    "issued_at",
    "replaced_at",
    "created_at",
    "updated_at",
  ];
}>;

export type PublicProfileBackfillPlan = Readonly<{
  readonly manifest: PublicProfileBackfillManifest;
  readonly target: PublicProfileTargetSnapshot;
  readonly operations: readonly BackfillOperation[];
  readonly report: PublicProfileBackfillReport;
}>;

export type PublicProfileBackfillQueryResult<Row> = Readonly<{ readonly rows: readonly Row[] }>;

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

export const REPORT_ITEM_LIMIT = 256;
export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

export const manifestDigest = (
  manifest: Omit<PublicProfileBackfillManifest, "manifest_sha256">,
): string => sha256(canonicalJson(manifest));

export const targetDigest = (
  target: Omit<PublicProfileTargetSnapshot, "snapshot_sha256">,
): string => sha256(canonicalJson(target));

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
