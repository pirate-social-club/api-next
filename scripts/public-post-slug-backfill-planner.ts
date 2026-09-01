import {
  createOpaquePostSlugCandidate,
  createPostSlugCandidate,
  hasDescriptivePostSlugPolicy,
  isLogicalPostSlug,
  selectPostSlugSource,
} from "../packages/application/src/post-slug.ts";
import {
  canonicalJson,
  POST_SLUG_BACKFILL_CURSOR_PREFIX,
  POST_SLUG_BACKFILL_CURSOR_VERSION,
  POST_SLUG_BACKFILL_PAGE_SIZE_MAX,
  POST_SLUG_BACKFILL_PAGE_SIZE_MIN,
  POST_SLUG_BACKFILL_REPORT_VERSION,
  type PostSlugBackfillCursor,
  type PostSlugBackfillDecision,
  type PostSlugBackfillIssueCode,
  type PostSlugBackfillPagePlan,
  type PostSlugBackfillPageReport,
  type PostSlugBackfillPostRow,
  postSlugBackfillPageDigest,
  sha256,
} from "./public-post-slug-backfill-types.ts";

const POSTGRES_MICROSECOND_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3})\d{3}Z$/u;
const VALID_POST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u;
const VALID_STATUSES = new Set([
  "draft",
  "processing",
  "published",
  "failed",
  "hidden",
  "removed",
  "deleted",
  "manual_review",
  "blocked",
  "processing_failed",
  "abandoned",
]);
const VALID_VISIBILITIES = new Set(["public", "members_only"]);
const VALID_RATINGS = new Set(["general", "adult_18"]);
const VALID_COMMUNITY_STATUSES = new Set(["active", "hidden", "archived"]);
const SKIP_STATUSES = new Set([
  "draft",
  "processing",
  "failed",
  "deleted",
  "manual_review",
  "blocked",
  "processing_failed",
  "abandoned",
]);

export class PostSlugBackfillPlannerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostSlugBackfillPlannerError";
  }
}

const fail = (message: string): never => {
  throw new PostSlugBackfillPlannerError(message);
};

const validTimestamp = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const match = POSTGRES_MICROSECOND_TIMESTAMP.exec(value);
  const millisecondTimestamp = match === null ? undefined : `${match[1]}Z`;
  if (millisecondTimestamp === undefined) return false;
  const millis = Date.parse(millisecondTimestamp);
  return Number.isFinite(millis) && new Date(millis).toISOString() === millisecondTimestamp;
};

const validPostId = (value: unknown): value is string =>
  typeof value === "string" && VALID_POST_ID.test(value);

const base64UrlEncode = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
};

const base64UrlDecode = (value: string): string => {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) fail("backfill cursor is not base64url");
  const padding = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4));
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    );
  } catch {
    fail("backfill cursor is not valid UTF-8 base64url");
  }
};

const cursorPayload = (cursor: PostSlugBackfillCursor): string =>
  JSON.stringify({ v: cursor.version, t: cursor.createdAt, p: cursor.postId });

export const encodePostSlugBackfillCursor = (cursor: PostSlugBackfillCursor): string => {
  validateCursor(cursor);
  const encoded = `${POST_SLUG_BACKFILL_CURSOR_PREFIX}${base64UrlEncode(cursorPayload(cursor))}`;
  if (encoded.length > 1_024) fail("backfill cursor is too long");
  return encoded;
};

export const decodePostSlugBackfillCursor = (
  value: string | null | undefined,
): PostSlugBackfillCursor | null => {
  if (value === undefined || value === null) return null;
  if (value.length > 1_024 || !value.startsWith(POST_SLUG_BACKFILL_CURSOR_PREFIX)) {
    fail("backfill cursor has an invalid prefix or length");
  }
  const encoded = value.slice(POST_SLUG_BACKFILL_CURSOR_PREFIX.length);
  const decoded = base64UrlDecode(encoded);
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    fail("backfill cursor is not JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("backfill cursor is not an object");
  }
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "p,t,v") fail("backfill cursor has extra fields");
  if (
    record.v !== POST_SLUG_BACKFILL_CURSOR_VERSION ||
    typeof record.t !== "string" ||
    typeof record.p !== "string"
  ) {
    fail("backfill cursor has an invalid payload");
  }
  const cursor: PostSlugBackfillCursor = {
    version: POST_SLUG_BACKFILL_CURSOR_VERSION,
    createdAt: record.t,
    postId: record.p,
  };
  validateCursor(cursor);
  if (encodePostSlugBackfillCursor(cursor) !== value) fail("backfill cursor is not canonical");
  return cursor;
};

function validateCursor(cursor: PostSlugBackfillCursor): void {
  if (
    cursor.version !== POST_SLUG_BACKFILL_CURSOR_VERSION ||
    !validTimestamp(cursor.createdAt) ||
    !validPostId(cursor.postId)
  ) {
    fail("backfill cursor has invalid version, timestamp, or post id");
  }
}

const compareTextBytewise = (left: string, right: string): number => {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const leftByte = leftBytes[index];
    const rightByte = rightBytes[index];
    if (leftByte === undefined || rightByte === undefined) break;
    if (leftByte !== rightByte) return leftByte < rightByte ? -1 : 1;
  }
  return Math.sign(leftBytes.length - rightBytes.length);
};

const compareCursor = (left: PostSlugBackfillCursor, right: PostSlugBackfillCursor): number =>
  left.createdAt < right.createdAt
    ? -1
    : left.createdAt > right.createdAt
      ? 1
      : compareTextBytewise(left.postId, right.postId);

const validatePageSize = (pageSize: number): void => {
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize < POST_SLUG_BACKFILL_PAGE_SIZE_MIN ||
    pageSize > POST_SLUG_BACKFILL_PAGE_SIZE_MAX
  ) {
    fail("backfill page size is outside the bounded range");
  }
};

const validateRow = (row: PostSlugBackfillPostRow): void => {
  if (
    !validPostId(row.post_id) ||
    !validPostId(row.community_id) ||
    !validTimestamp(row.created_at) ||
    typeof row.post_type !== "string" ||
    row.post_type.length === 0 ||
    row.post_type.length > 128 ||
    !VALID_STATUSES.has(row.status) ||
    !VALID_VISIBILITIES.has(row.visibility) ||
    (row.content_rating !== null && !VALID_RATINGS.has(row.content_rating)) ||
    !VALID_COMMUNITY_STATUSES.has(row.community_status)
  ) {
    fail("backfill source row is invalid");
  }
  if (row.existing_slug !== null && !isLogicalPostSlug(row.existing_slug)) {
    fail("backfill source alias is invalid");
  }
  if (
    (Object.hasOwn(row, "title") &&
      row.title !== undefined &&
      row.title !== null &&
      typeof row.title !== "string") ||
    (Object.hasOwn(row, "body") &&
      row.body !== undefined &&
      row.body !== null &&
      typeof row.body !== "string")
  ) {
    fail("backfill source title or body is invalid");
  }
  const sourceEligible =
    row.status === "published" &&
    row.community_status === "active" &&
    row.visibility === "public" &&
    row.content_rating === "general" &&
    (row.post_type === "text" || row.post_type === "song");
  if (!sourceEligible && (row.title != null || row.body != null)) {
    fail("guarded backfill row carries forbidden source text");
  }
};

const opaqueCandidate = (postType: string) =>
  createOpaquePostSlugCandidate(postType === "song" ? "song" : "text");

const decisionForRow = (row: PostSlugBackfillPostRow): PostSlugBackfillDecision => {
  if (!hasDescriptivePostSlugPolicy(row.post_type)) {
    return {
      post_id: row.post_id,
      created_at: row.created_at,
      post_type: row.post_type,
      policy: "blocked",
      existing_slug: row.existing_slug,
      candidate: null,
      issue: "unsupported-post-type",
    };
  }

  if (row.status === "removed") {
    return {
      post_id: row.post_id,
      created_at: row.created_at,
      post_type: row.post_type,
      policy: "blocked",
      existing_slug: row.existing_slug,
      candidate: null,
      issue: "removed-not-normalized",
    };
  }

  if (SKIP_STATUSES.has(row.status)) {
    return {
      post_id: row.post_id,
      created_at: row.created_at,
      post_type: row.post_type,
      policy: "skip",
      existing_slug: row.existing_slug,
      candidate: null,
      issue: null,
    };
  }

  if (row.status === "hidden") {
    return {
      post_id: row.post_id,
      created_at: row.created_at,
      post_type: row.post_type,
      policy: "opaque",
      existing_slug: row.existing_slug,
      candidate: opaqueCandidate(row.post_type),
      issue: null,
    };
  }

  if (row.status !== "published") {
    return {
      post_id: row.post_id,
      created_at: row.created_at,
      post_type: row.post_type,
      policy: "blocked",
      existing_slug: row.existing_slug,
      candidate: null,
      issue: "unsupported-status",
    };
  }

  const descriptiveEligible =
    row.community_status === "active" &&
    row.visibility === "public" &&
    row.content_rating === "general";
  if (!descriptiveEligible) {
    return {
      post_id: row.post_id,
      created_at: row.created_at,
      post_type: row.post_type,
      policy: "opaque",
      existing_slug: row.existing_slug,
      candidate: opaqueCandidate(row.post_type),
      issue: null,
    };
  }

  const candidate = createPostSlugCandidate({
    source: selectPostSlugSource({
      postType: row.post_type,
      title: row.title ?? null,
      body: row.body ?? null,
    }),
    postType: row.post_type,
  });
  return {
    post_id: row.post_id,
    created_at: row.created_at,
    post_type: row.post_type,
    policy: candidate.kind === "descriptive" ? "descriptive" : "opaque",
    existing_slug: row.existing_slug,
    candidate,
    issue: null,
  };
};

const collisionClasses = (
  decisions: readonly PostSlugBackfillDecision[],
): ReadonlyArray<Readonly<{ readonly candidate: string; readonly count: number }>> => {
  const counts = new Map<string, number>();
  for (const decision of decisions) {
    if (decision.candidate?.kind !== "descriptive") continue;
    counts.set(decision.candidate.slug, (counts.get(decision.candidate.slug) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([candidate, count]) => ({ candidate, count }));
};

const makeReport = (input: {
  readonly cursor: PostSlugBackfillCursor | null;
  readonly upperBound: PostSlugBackfillCursor;
  readonly decisions: readonly PostSlugBackfillDecision[];
}): PostSlugBackfillPageReport => {
  const issueCounts: Partial<Record<PostSlugBackfillIssueCode, number>> = {};
  for (const decision of input.decisions) {
    if (decision.issue !== null)
      issueCounts[decision.issue] = (issueCounts[decision.issue] ?? 0) + 1;
  }
  const reportWithoutDigest = {
    report_version: POST_SLUG_BACKFILL_REPORT_VERSION,
    input_count: input.decisions.length,
    existing_count: input.decisions.filter(({ existing_slug }) => existing_slug !== null).length,
    descriptive_count: input.decisions.filter(({ policy }) => policy === "descriptive").length,
    opaque_count: input.decisions.filter(({ policy }) => policy === "opaque").length,
    skipped_count: input.decisions.filter(({ policy }) => policy === "skip").length,
    blocked_count: input.decisions.filter(({ policy }) => policy === "blocked").length,
    issue_counts: issueCounts,
    collision_classes: collisionClasses(input.decisions),
  } satisfies Omit<PostSlugBackfillPageReport, "page_digest">;
  return {
    ...reportWithoutDigest,
    page_digest: postSlugBackfillPageDigest({
      cursor: input.cursor,
      upper_bound: input.upperBound,
      decisions: input.decisions,
    }),
  };
};

export type PlanPostSlugBackfillPageInput = Readonly<{
  /** Rows are the page plus at most one look-ahead row from the ordered query. */
  readonly rows: readonly PostSlugBackfillPostRow[];
  readonly page_size: number;
  readonly cursor?: string | null;
  readonly upper_bound: string;
}>;

export function planPostSlugBackfillPage(
  input: PlanPostSlugBackfillPageInput,
): PostSlugBackfillPagePlan {
  validatePageSize(input.page_size);
  const cursor = decodePostSlugBackfillCursor(input.cursor);
  const upperBound = decodePostSlugBackfillCursor(input.upper_bound);
  if (upperBound === null) fail("backfill upper bound is required");
  if (cursor !== null && compareCursor(cursor, upperBound) >= 0) {
    fail("backfill cursor must precede its upper bound");
  }
  if (input.rows.length > input.page_size + 1) fail("backfill page exceeds its bounded look-ahead");

  let previous = cursor;
  for (const row of input.rows) {
    validateRow(row);
    const position: PostSlugBackfillCursor = {
      version: POST_SLUG_BACKFILL_CURSOR_VERSION,
      createdAt: row.created_at,
      postId: row.post_id,
    };
    if (
      (previous !== null && compareCursor(position, previous) <= 0) ||
      compareCursor(position, upperBound) > 0
    ) {
      fail("backfill page order is not monotonic or exceeds its upper bound");
    }
    previous = position;
  }

  const hasMore = input.rows.length > input.page_size;
  const selectedRows = input.rows.slice(0, input.page_size);
  const decisions = selectedRows.map(decisionForRow);
  const lastRow = selectedRows[selectedRows.length - 1];
  const nextCursor =
    hasMore && lastRow !== undefined
      ? {
          version: POST_SLUG_BACKFILL_CURSOR_VERSION,
          createdAt: lastRow.created_at,
          postId: lastRow.post_id,
        }
      : null;
  const report = makeReport({ cursor, upperBound, decisions });
  return {
    cursor,
    upper_bound: upperBound,
    next_cursor: nextCursor,
    has_more: hasMore,
    decisions,
    report,
  };
}

export const postSlugBackfillPlanDigest = (plan: PostSlugBackfillPagePlan): string =>
  sha256(
    canonicalJson({
      cursor: plan.cursor,
      upper_bound: plan.upper_bound,
      next_cursor: plan.next_cursor,
      has_more: plan.has_more,
      page_digest: plan.report.page_digest,
    }),
  );
