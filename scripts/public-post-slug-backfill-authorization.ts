import { POST_SLUG_POLICY_VERSION } from "../packages/application/src/post-slug.ts";
import { decodePostSlugBackfillCursor } from "./public-post-slug-backfill-planner.ts";
import {
  canonicalJson,
  POST_SLUG_BACKFILL_AUTHORIZATION_VERSION,
  POST_SLUG_BACKFILL_MAX_PAGES,
  POST_SLUG_BACKFILL_PAGE_SIZE_MAX,
  POST_SLUG_BACKFILL_PAGE_SIZE_MIN,
  type PostSlugBackfillAuthorization,
  sha256,
} from "./public-post-slug-backfill-types.ts";

const DIGEST = /^[0-9a-f]{64}$/u;
const RUN_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
const ENVIRONMENT = /^[a-z][a-z0-9_-]{0,63}$/u;
const RFC3339_UTC_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export class PostSlugBackfillAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostSlugBackfillAuthorizationError";
  }
}

const fail = (message: string): never => {
  throw new PostSlugBackfillAuthorizationError(message);
};

const exactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean =>
  Object.keys(value).sort().join(",") === [...expected].sort().join(",");

const canonicalTimestamp = (value: unknown): value is string =>
  typeof value === "string" &&
  RFC3339_UTC_MILLISECONDS.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

export const postSlugBackfillAuthorizationDigest = (
  record: Omit<PostSlugBackfillAuthorization, "canonical_digest">,
): string => sha256(canonicalJson(record));

export function parsePostSlugBackfillAuthorization(
  raw: unknown,
  options: Readonly<{ now?: Date }> = {},
): PostSlugBackfillAuthorization {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail("backfill authorization is not an object");
  }
  const record = raw as Record<string, unknown>;
  if (
    !exactKeys(record, [
      "record_version",
      "run_id",
      "repository",
      "database_environment",
      "policy_version",
      "actor_role",
      "authorized_at",
      "expires_at",
      "page_bounds",
      "authorized_page_digests",
      "dry_run_result_digest",
      "canonical_digest",
    ])
  ) {
    fail("backfill authorization has missing or extra fields");
  }
  const pageBoundsRaw = record.page_bounds;
  if (pageBoundsRaw === null || typeof pageBoundsRaw !== "object" || Array.isArray(pageBoundsRaw)) {
    fail("backfill authorization page bounds are invalid");
  }
  const pageBounds = pageBoundsRaw as Record<string, unknown>;
  if (!exactKeys(pageBounds, ["page_size", "start_cursor", "upper_bound", "max_pages"])) {
    fail("backfill authorization page bounds have missing or extra fields");
  }
  if (
    record.record_version !== POST_SLUG_BACKFILL_AUTHORIZATION_VERSION ||
    typeof record.run_id !== "string" ||
    !RUN_ID.test(record.run_id) ||
    record.repository !== "api-next" ||
    typeof record.database_environment !== "string" ||
    !ENVIRONMENT.test(record.database_environment) ||
    record.policy_version !== POST_SLUG_POLICY_VERSION ||
    record.actor_role !== "operator" ||
    !canonicalTimestamp(record.authorized_at) ||
    !canonicalTimestamp(record.expires_at) ||
    typeof record.canonical_digest !== "string" ||
    !DIGEST.test(record.canonical_digest) ||
    typeof record.dry_run_result_digest !== "string" ||
    !DIGEST.test(record.dry_run_result_digest)
  ) {
    fail("backfill authorization scope is invalid");
  }
  if (
    !Number.isSafeInteger(pageBounds.page_size) ||
    (pageBounds.page_size as number) < POST_SLUG_BACKFILL_PAGE_SIZE_MIN ||
    (pageBounds.page_size as number) > POST_SLUG_BACKFILL_PAGE_SIZE_MAX ||
    !Number.isSafeInteger(pageBounds.max_pages) ||
    (pageBounds.max_pages as number) < 1 ||
    (pageBounds.max_pages as number) > POST_SLUG_BACKFILL_MAX_PAGES ||
    (pageBounds.start_cursor !== null && typeof pageBounds.start_cursor !== "string") ||
    typeof pageBounds.upper_bound !== "string"
  ) {
    fail("backfill authorization page bounds are outside the bounded range");
  }
  const start = decodePostSlugBackfillCursor(pageBounds.start_cursor as string | null);
  const upper = decodePostSlugBackfillCursor(pageBounds.upper_bound);
  if (upper === null) fail("backfill authorization upper bound is required");
  if (
    start !== null &&
    (start.createdAt > upper.createdAt ||
      (start.createdAt === upper.createdAt && start.postId >= upper.postId))
  ) {
    fail("backfill authorization cursor bounds are not monotonic");
  }
  if (
    !Array.isArray(record.authorized_page_digests) ||
    record.authorized_page_digests.length !== pageBounds.max_pages ||
    record.authorized_page_digests.some(
      (digest) => typeof digest !== "string" || !DIGEST.test(digest),
    )
  ) {
    fail("backfill authorization page digests are invalid");
  }
  if (Date.parse(record.expires_at) <= Date.parse(record.authorized_at)) {
    fail("backfill authorization expiry must follow authorization");
  }
  const now = (options.now ?? new Date()).getTime();
  if (
    !Number.isFinite(now) ||
    now < Date.parse(record.authorized_at) ||
    now >= Date.parse(record.expires_at)
  ) {
    fail("backfill authorization is not currently valid or has expired");
  }

  const parsed = {
    record_version: POST_SLUG_BACKFILL_AUTHORIZATION_VERSION,
    run_id: record.run_id,
    repository: "api-next",
    database_environment: record.database_environment,
    policy_version: POST_SLUG_POLICY_VERSION,
    actor_role: "operator",
    authorized_at: record.authorized_at,
    expires_at: record.expires_at,
    page_bounds: {
      page_size: pageBounds.page_size as number,
      start_cursor: pageBounds.start_cursor as string | null,
      upper_bound: pageBounds.upper_bound,
      max_pages: pageBounds.max_pages as number,
    },
    authorized_page_digests: record.authorized_page_digests as readonly string[],
    dry_run_result_digest: record.dry_run_result_digest,
    canonical_digest: record.canonical_digest,
  } satisfies PostSlugBackfillAuthorization;
  const { canonical_digest: canonicalDigest, ...unsigned } = parsed;
  if (postSlugBackfillAuthorizationDigest(unsigned) !== canonicalDigest) {
    fail("backfill authorization digest does not match its canonical record");
  }
  return parsed;
}
