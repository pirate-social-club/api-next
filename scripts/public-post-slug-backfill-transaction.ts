import type { PostSlugCandidate } from "../packages/application/src/post-slug.ts";
import { POST_SLUG_POLICY_VERSION } from "../packages/application/src/post-slug.ts";
import { parsePostSlugBackfillAuthorization } from "./public-post-slug-backfill-authorization.ts";
import {
  decodePostSlugBackfillCursor,
  encodePostSlugBackfillCursor,
  planPostSlugBackfillPage,
} from "./public-post-slug-backfill-planner.ts";
import {
  canonicalJson,
  POST_SLUG_BACKFILL_PAGE_SIZE_MAX,
  POST_SLUG_BACKFILL_PAGE_SIZE_MIN,
  type PostSlugBackfillAuthorization,
  type PostSlugBackfillPagePlan,
  type PostSlugBackfillPostRow,
  postSlugBackfillResultDigest,
  sha256,
} from "./public-post-slug-backfill-types.ts";

export type PostSlugBackfillQueryResult<Row> = Readonly<{ readonly rows: readonly Row[] }>;

export interface PostSlugBackfillTransaction {
  readonly query: <Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ) => Promise<PostSlugBackfillQueryResult<Row>>;
}

export interface PostSlugBackfillDatabase {
  readonly databaseEnvironment: string;
  readonly withTransaction: <A>(
    run: (transaction: PostSlugBackfillTransaction) => Promise<A>,
  ) => Promise<A>;
}

export interface PostSlugBackfillAuthorizationRegistry {
  readonly getRecordedAuthorization: (scope: {
    readonly runId: string;
    readonly repository: "api-next";
    readonly databaseEnvironment: string;
  }) => Promise<unknown>;
}

export type PostSlugBackfillAllocator = (
  transaction: PostSlugBackfillTransaction,
  input: Readonly<{ readonly postId: string; readonly candidate: PostSlugCandidate }>,
) => Promise<Readonly<{ readonly slug: string; readonly postId: string }>>;

type BackfillCounts = Readonly<{
  readonly input: number;
  readonly descriptive: number;
  readonly opaque: number;
  readonly skipped: number;
  readonly blocked: number;
}>;

export type PostSlugBackfillCheckpoint = Readonly<{
  readonly checkpoint_version: 1;
  readonly run_id: string;
  readonly authorization_digest: string;
  readonly page_index: number;
  readonly cursor: string | null;
  readonly page_digests: readonly string[];
  readonly counts: BackfillCounts;
  readonly started_at: string;
  readonly updated_at: string;
  readonly completed_at: string | null;
  readonly result_digest: string | null;
  readonly canonical_digest: string;
}>;

export type PostSlugBackfillPageResult = Readonly<{
  readonly mode: "dry-run" | "apply";
  readonly plan: PostSlugBackfillPagePlan;
  readonly checkpoint?: PostSlugBackfillCheckpoint;
}>;

const CHECKPOINT_DIGEST = /^[0-9a-f]{64}$/u;
const exactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean =>
  Object.keys(value).sort().join(",") === [...expected].sort().join(",");
const canonicalTimestamp = (value: unknown): value is string =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const validCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const emptyCounts = (): BackfillCounts => ({
  input: 0,
  descriptive: 0,
  opaque: 0,
  skipped: 0,
  blocked: 0,
});

const checkpointDigest = (value: Omit<PostSlugBackfillCheckpoint, "canonical_digest">): string =>
  sha256(canonicalJson(value));

const parseTimestamp = (value: unknown): string => {
  if (typeof value !== "string") {
    throw new Error("public-post-slug-backfill-invalid-row");
  }
  return value;
};

const stringValue = (row: Record<string, unknown>, key: string): string => {
  const value = row[key];
  if (typeof value !== "string") throw new Error("public-post-slug-backfill-invalid-row");
  return value;
};

const nullableStringValue = (row: Record<string, unknown>, key: string): string | null => {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string") throw new Error("public-post-slug-backfill-invalid-row");
  return value;
};

const rowFromDatabase = (row: Record<string, unknown>): PostSlugBackfillPostRow => ({
  post_id: stringValue(row, "post_id"),
  community_id: stringValue(row, "community_id"),
  created_at: parseTimestamp(row.created_at),
  post_type: stringValue(row, "post_type"),
  status: stringValue(row, "status") as PostSlugBackfillPostRow["status"],
  visibility: stringValue(row, "visibility") as PostSlugBackfillPostRow["visibility"],
  content_rating: nullableStringValue(
    row,
    "content_rating",
  ) as PostSlugBackfillPostRow["content_rating"],
  community_status: stringValue(
    row,
    "community_status",
  ) as PostSlugBackfillPostRow["community_status"],
  existing_slug: nullableStringValue(row, "existing_slug"),
  title: nullableStringValue(row, "title"),
  body: nullableStringValue(row, "body"),
});

const pageSql = `SELECT p.post_id,
       p.community_id,
       to_char(
         p.created_at AT TIME ZONE 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
       ) AS created_at,
       p.post_type,
       p.status,
       p.visibility,
       p.content_rating,
       c.status AS community_status,
       alias.slug AS existing_slug,
       CASE WHEN p.status = 'published'
                  AND c.status = 'active'
                  AND p.visibility = 'public'
                  AND p.content_rating = 'general'
                  AND p.post_type IN ('text', 'song')
            THEN p.title ELSE NULL END AS title,
       CASE WHEN p.status = 'published'
                  AND c.status = 'active'
                  AND p.visibility = 'public'
                  AND p.content_rating = 'general'
                  AND p.post_type IN ('text', 'song')
            THEN p.body ELSE NULL END AS body
  FROM posts AS p
  JOIN communities AS c ON c.community_id = p.community_id
  LEFT JOIN post_slug_aliases AS alias ON alias.post_id = p.post_id
 WHERE ($1::timestamptz IS NULL
        OR p.created_at > $1::timestamptz
        OR (p.created_at = $1::timestamptz
            AND p.post_id COLLATE "C" > $2::text COLLATE "C"))
   AND (p.created_at < $3::timestamptz
        OR (p.created_at = $3::timestamptz
            AND p.post_id COLLATE "C" <= $4::text COLLATE "C"))
 ORDER BY p.created_at ASC, p.post_id COLLATE "C" ASC
 LIMIT $5`;

export async function readPostSlugBackfillPage(
  transaction: PostSlugBackfillTransaction,
  input: Readonly<{
    readonly cursor: PostSlugBackfillAuthorization["page_bounds"]["start_cursor"];
    readonly upperBound: PostSlugBackfillAuthorization["page_bounds"]["upper_bound"];
    readonly pageSize: number;
  }>,
): Promise<readonly PostSlugBackfillPostRow[]> {
  if (
    !Number.isSafeInteger(input.pageSize) ||
    input.pageSize < POST_SLUG_BACKFILL_PAGE_SIZE_MIN ||
    input.pageSize > POST_SLUG_BACKFILL_PAGE_SIZE_MAX
  ) {
    throw new Error("public-post-slug-backfill-page-size-out-of-range");
  }
  const cursor = decodePostSlugBackfillCursor(input.cursor);
  const upper = decodePostSlugBackfillCursor(input.upperBound);
  if (upper === null) throw new Error("public-post-slug-backfill-upper-bound-required");
  const result = await transaction.query(pageSql, [
    cursor?.createdAt ?? null,
    cursor?.postId ?? null,
    upper.createdAt,
    upper.postId,
    input.pageSize + 1,
  ]);
  return result.rows.map(rowFromDatabase);
}

export async function capturePostSlugBackfillUpperBound(
  transaction: PostSlugBackfillTransaction,
): Promise<string | null> {
  const result = await transaction.query<{
    readonly created_at: unknown;
    readonly post_id: unknown;
  }>(`SELECT to_char(
               created_at AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
             ) AS created_at,
             post_id
        FROM posts
       ORDER BY created_at DESC, post_id COLLATE "C" DESC
       LIMIT 1`);
  const row = result.rows[0];
  if (row === undefined) return null;
  return encodePostSlugBackfillCursor({
    version: 1,
    createdAt: parseTimestamp(row.created_at),
    postId: stringValue(row, "post_id"),
  });
}

export async function runPostSlugBackfillDryRunPage(
  input: Readonly<{
    readonly database: PostSlugBackfillDatabase;
    readonly cursor?: string | null;
    readonly upperBound?: string;
    readonly pageSize: number;
  }>,
): Promise<PostSlugBackfillPageResult> {
  return input.database.withTransaction(async (transaction) => {
    await transaction.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const upperBound = input.upperBound ?? (await capturePostSlugBackfillUpperBound(transaction));
    if (upperBound === null) throw new Error("public-post-slug-backfill-no-posts");
    const rows = await readPostSlugBackfillPage(transaction, {
      cursor: input.cursor ?? null,
      upperBound,
      pageSize: input.pageSize,
    });
    return {
      mode: "dry-run",
      plan: planPostSlugBackfillPage({
        rows,
        page_size: input.pageSize,
        cursor: input.cursor ?? null,
        upper_bound: upperBound,
      }),
    };
  });
}

const parseCheckpoint = (
  raw: unknown,
  authorization: PostSlugBackfillAuthorization,
): PostSlugBackfillCheckpoint | null => {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("public-post-slug-backfill-invalid-checkpoint");
  }
  const record = raw as Record<string, unknown>;
  if (
    !exactKeys(record, [
      "checkpoint_version",
      "run_id",
      "authorization_digest",
      "page_index",
      "cursor",
      "page_digests",
      "counts",
      "started_at",
      "updated_at",
      "completed_at",
      "result_digest",
      "canonical_digest",
    ]) ||
    record.counts === null ||
    typeof record.counts !== "object" ||
    Array.isArray(record.counts)
  ) {
    throw new Error("public-post-slug-backfill-invalid-checkpoint");
  }
  const counts = record.counts as Record<string, unknown>;
  if (
    !exactKeys(counts, ["input", "descriptive", "opaque", "skipped", "blocked"]) ||
    !Object.values(counts).every(validCount)
  ) {
    throw new Error("public-post-slug-backfill-invalid-checkpoint");
  }
  const checkpoint = record as unknown as PostSlugBackfillCheckpoint;
  const { canonical_digest: canonicalDigest, ...unsigned } = checkpoint;
  if (
    checkpoint.checkpoint_version !== 1 ||
    checkpoint.run_id !== authorization.run_id ||
    checkpoint.authorization_digest !== authorization.canonical_digest ||
    !Number.isSafeInteger(checkpoint.page_index) ||
    checkpoint.page_index < 1 ||
    checkpoint.page_index > authorization.page_bounds.max_pages ||
    typeof checkpoint.cursor !== "string" ||
    decodePostSlugBackfillCursor(checkpoint.cursor) === null ||
    !Array.isArray(checkpoint.page_digests) ||
    checkpoint.page_digests.length !== checkpoint.page_index ||
    checkpoint.page_digests.some(
      (digest, index) =>
        typeof digest !== "string" ||
        !CHECKPOINT_DIGEST.test(digest) ||
        digest !== authorization.authorized_page_digests[index],
    ) ||
    !canonicalTimestamp(checkpoint.started_at) ||
    !canonicalTimestamp(checkpoint.updated_at) ||
    checkpoint.updated_at < checkpoint.started_at ||
    checkpoint.started_at < authorization.authorized_at ||
    checkpoint.updated_at >= authorization.expires_at ||
    (checkpoint.completed_at !== null && !canonicalTimestamp(checkpoint.completed_at)) ||
    (checkpoint.completed_at !== null && checkpoint.completed_at !== checkpoint.updated_at) ||
    (checkpoint.result_digest !== null &&
      (typeof checkpoint.result_digest !== "string" ||
        !CHECKPOINT_DIGEST.test(checkpoint.result_digest))) ||
    (checkpoint.result_digest !== null &&
      checkpoint.result_digest !== authorization.dry_run_result_digest) ||
    (checkpoint.completed_at === null) !== (checkpoint.result_digest === null) ||
    (checkpoint.completed_at === null &&
      checkpoint.page_index >= authorization.authorized_page_digests.length) ||
    (checkpoint.completed_at !== null &&
      checkpoint.page_index !== authorization.authorized_page_digests.length) ||
    typeof canonicalDigest !== "string" ||
    !CHECKPOINT_DIGEST.test(canonicalDigest) ||
    checkpointDigest(unsigned) !== canonicalDigest
  ) {
    throw new Error("public-post-slug-backfill-invalid-checkpoint");
  }
  return checkpoint;
};

const addCounts = (left: BackfillCounts, plan: PostSlugBackfillPagePlan): BackfillCounts => ({
  input: left.input + plan.report.input_count,
  descriptive: left.descriptive + plan.report.descriptive_count,
  opaque: left.opaque + plan.report.opaque_count,
  skipped: left.skipped + plan.report.skipped_count,
  blocked: left.blocked + plan.report.blocked_count,
});

export async function runAuthorizedPostSlugBackfillPage(
  input: Readonly<{
    readonly database: PostSlugBackfillDatabase;
    readonly allocator: PostSlugBackfillAllocator;
    readonly runId: string;
    readonly authorizationRegistry: PostSlugBackfillAuthorizationRegistry;
    readonly checkpoint?: unknown;
    readonly now?: Date;
  }>,
): Promise<PostSlugBackfillPageResult> {
  const operationNow = input.now ?? new Date();
  const authorization = parsePostSlugBackfillAuthorization(
    await input.authorizationRegistry.getRecordedAuthorization({
      runId: input.runId,
      repository: "api-next",
      databaseEnvironment: input.database.databaseEnvironment,
    }),
    { now: operationNow },
  );
  if (authorization.run_id !== input.runId) {
    throw new Error("public-post-slug-backfill-authorization-run-mismatch");
  }
  if (authorization.database_environment !== input.database.databaseEnvironment) {
    throw new Error("public-post-slug-backfill-authorization-environment-mismatch");
  }
  const checkpoint = parseCheckpoint(input.checkpoint, authorization);
  const pageIndex = checkpoint?.page_index ?? 0;
  if (pageIndex >= authorization.authorized_page_digests.length) {
    throw new Error("public-post-slug-backfill-authorization-exhausted");
  }
  const cursor = checkpoint?.cursor ?? authorization.page_bounds.start_cursor;
  return input.database.withTransaction(async (transaction) => {
    await transaction.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    const rows = await readPostSlugBackfillPage(transaction, {
      cursor,
      upperBound: authorization.page_bounds.upper_bound,
      pageSize: authorization.page_bounds.page_size,
    });
    const plan = planPostSlugBackfillPage({
      rows,
      page_size: authorization.page_bounds.page_size,
      cursor,
      upper_bound: authorization.page_bounds.upper_bound,
    });
    if (plan.report.page_digest !== authorization.authorized_page_digests[pageIndex]) {
      throw new Error("public-post-slug-backfill-page-digest-mismatch");
    }
    if (plan.report.blocked_count !== 0) {
      throw new Error("public-post-slug-backfill-page-blocked");
    }
    const pageDigests = [...(checkpoint?.page_digests ?? []), plan.report.page_digest];
    const counts = addCounts(checkpoint?.counts ?? emptyCounts(), plan);
    const completed = !plan.has_more;
    if (completed && pageDigests.length !== authorization.authorized_page_digests.length) {
      throw new Error("public-post-slug-backfill-authorization-page-count-mismatch");
    }
    if (!completed && pageDigests.length >= authorization.authorized_page_digests.length) {
      throw new Error("public-post-slug-backfill-authorization-page-count-mismatch");
    }
    const now = operationNow.toISOString();
    const cursorAfterPage = completed
      ? authorization.page_bounds.upper_bound
      : plan.next_cursor === null
        ? null
        : encodePostSlugBackfillCursor(plan.next_cursor);
    if (cursorAfterPage === null) throw new Error("public-post-slug-backfill-missing-cursor");
    const resultDigest = completed
      ? postSlugBackfillResultDigest({
          run_id: authorization.run_id,
          policy_version: POST_SLUG_POLICY_VERSION,
          page_digests: pageDigests,
          counts,
        })
      : null;
    if (resultDigest !== null && resultDigest !== authorization.dry_run_result_digest) {
      throw new Error("public-post-slug-backfill-result-digest-mismatch");
    }
    for (const decision of plan.decisions) {
      if (decision.candidate === null || decision.existing_slug !== null) continue;
      const alias = await input.allocator(transaction, {
        postId: decision.post_id,
        candidate: decision.candidate,
      });
      if (alias.postId !== decision.post_id) {
        throw new Error("public-post-slug-backfill-alias-mismatch");
      }
    }
    const unsigned = {
      checkpoint_version: 1 as const,
      run_id: authorization.run_id,
      authorization_digest: authorization.canonical_digest,
      page_index: pageIndex + 1,
      cursor: cursorAfterPage,
      page_digests: pageDigests,
      counts,
      started_at: checkpoint?.started_at ?? now,
      updated_at: now,
      completed_at: completed ? now : null,
      result_digest: resultDigest,
    };
    const nextCheckpoint: PostSlugBackfillCheckpoint = {
      ...unsigned,
      canonical_digest: checkpointDigest(unsigned),
    };
    return { mode: "apply", plan, checkpoint: nextCheckpoint };
  });
}
