import type {
  POST_SLUG_POLICY_VERSION,
  PostSlugCandidate,
} from "../packages/application/src/post-slug.ts";
import { canonicalJson, sha256 } from "./public-profile-backfill-types.ts";

export { canonicalJson, sha256 } from "./public-profile-backfill-types.ts";

export const POST_SLUG_BACKFILL_CURSOR_VERSION = 1 as const;
export const POST_SLUG_BACKFILL_AUTHORIZATION_VERSION = 1 as const;
export const POST_SLUG_BACKFILL_REPORT_VERSION = 1 as const;
export const POST_SLUG_BACKFILL_PAGE_SIZE_MIN = 1;
export const POST_SLUG_BACKFILL_PAGE_SIZE_MAX = 1_000;
export const POST_SLUG_BACKFILL_MAX_PAGES = 1_000_000;
export const POST_SLUG_BACKFILL_CURSOR_PREFIX = "ppsb1.";

export type PostSlugBackfillCursor = Readonly<{
  readonly version: typeof POST_SLUG_BACKFILL_CURSOR_VERSION;
  readonly createdAt: string;
  readonly postId: string;
}>;

export type PostSlugBackfillPostStatus =
  | "draft"
  | "processing"
  | "published"
  | "failed"
  | "hidden"
  | "removed"
  | "deleted"
  | "manual_review"
  | "blocked"
  | "processing_failed"
  | "abandoned";

export type PostSlugBackfillPostRow = Readonly<{
  readonly post_id: string;
  readonly community_id: string;
  readonly created_at: string;
  readonly post_type: string;
  readonly status: PostSlugBackfillPostStatus;
  readonly visibility: "public" | "members_only";
  readonly content_rating: "general" | "adult_18" | null;
  readonly community_status: "active" | "hidden" | "archived";
  /** Existing immutable alias, when this Post was already ensured by publication or a replay. */
  readonly existing_slug: string | null;
  /** Present only for source rows that are eligible for descriptive generation. */
  readonly title?: string | null;
  /** Present only for source rows that are eligible for descriptive generation. */
  readonly body?: string | null;
}>;

export type PostSlugBackfillIssueCode =
  | "removed-not-normalized"
  | "invalid-row"
  | "invalid-order"
  | "unsupported-status";

export type PostSlugBackfillDecision = Readonly<{
  readonly post_id: string;
  readonly created_at: string;
  readonly post_type: string;
  readonly policy: "descriptive" | "opaque" | "skip" | "blocked";
  readonly existing_slug: string | null;
  readonly candidate: PostSlugCandidate | null;
  readonly issue: PostSlugBackfillIssueCode | null;
}>;

export type PostSlugBackfillPageBounds = Readonly<{
  readonly page_size: number;
  readonly start_cursor: string | null;
  readonly upper_bound: string;
  readonly max_pages: number;
}>;

export type PostSlugBackfillPageReport = Readonly<{
  readonly report_version: typeof POST_SLUG_BACKFILL_REPORT_VERSION;
  readonly page_digest: string;
  readonly input_count: number;
  readonly existing_count: number;
  readonly descriptive_count: number;
  readonly opaque_count: number;
  readonly skipped_count: number;
  readonly blocked_count: number;
  readonly issue_counts: Readonly<Partial<Record<PostSlugBackfillIssueCode, number>>>;
  readonly collision_classes: ReadonlyArray<
    Readonly<{ readonly candidate: string; readonly count: number }>
  >;
}>;

export type PostSlugBackfillPagePlan = Readonly<{
  readonly cursor: PostSlugBackfillCursor | null;
  readonly upper_bound: PostSlugBackfillCursor;
  readonly next_cursor: PostSlugBackfillCursor | null;
  readonly has_more: boolean;
  readonly decisions: readonly PostSlugBackfillDecision[];
  readonly report: PostSlugBackfillPageReport;
}>;

export type PostSlugBackfillAuthorization = Readonly<{
  readonly record_version: typeof POST_SLUG_BACKFILL_AUTHORIZATION_VERSION;
  readonly run_id: string;
  readonly repository: "api-next";
  readonly database_environment: string;
  readonly policy_version: typeof POST_SLUG_POLICY_VERSION;
  readonly actor_role: "operator";
  readonly authorized_at: string;
  readonly expires_at: string;
  readonly page_bounds: PostSlugBackfillPageBounds;
  readonly authorized_page_digests: readonly string[];
  readonly dry_run_result_digest: string;
  readonly canonical_digest: string;
}>;

export const postSlugBackfillPageDigest = (input: {
  readonly cursor: PostSlugBackfillCursor | null;
  readonly upper_bound: PostSlugBackfillCursor;
  readonly decisions: readonly PostSlugBackfillDecision[];
}): string =>
  sha256(
    canonicalJson({
      cursor: input.cursor,
      upper_bound: input.upper_bound,
      // existing_slug is an observation, not an action. Excluding it makes an
      // immutable alias created by publication or a prior committed attempt a
      // safe no-op replay while the remaining fields still bind every action.
      decisions: input.decisions.map(
        ({ post_id, created_at, post_type, policy, candidate, issue }) => ({
          post_id,
          created_at,
          post_type,
          policy,
          candidate,
          issue,
        }),
      ),
    }),
  );

export const postSlugBackfillResultDigest = (input: {
  readonly run_id: string;
  readonly policy_version: typeof POST_SLUG_POLICY_VERSION;
  readonly page_digests: readonly string[];
  readonly counts: Readonly<{
    readonly input: number;
    readonly descriptive: number;
    readonly opaque: number;
    readonly skipped: number;
    readonly blocked: number;
  }>;
}): string => sha256(canonicalJson(input));
