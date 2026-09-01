import type { ControlPlaneError, ControlPlaneTransaction } from "@pirate/application";
import {
  isLogicalPostSlug,
  POST_SLUG_POLICY_VERSION,
  type PostSlugCandidate,
  postSlugCollisionCandidate,
  postSlugOpaqueToken,
} from "@pirate/application/post-slug";
import { Data, Effect } from "effect";

export type PostSlugAliasRecord = Readonly<{
  slug: string;
  postId: string;
  slugPolicyVersion: typeof POST_SLUG_POLICY_VERSION;
  createdAt: string;
}>;

export class PublicPostSlugRepositoryError extends Data.TaggedError(
  "PublicPostSlugRepositoryError",
)<{
  readonly reason: "invalid-input" | "invalid-row" | "collision-exhausted";
}> {}

type Row = Readonly<Record<string, unknown>>;
type EnsureOptions = Readonly<{
  nextOpaqueToken?: () => string;
  maxAttempts?: number;
}>;

const OPAQUE_TOKEN = /^[0-9abcdefghjkmnpqrstvwxyz]{10}$/u;

const repositoryError = (
  reason: PublicPostSlugRepositoryError["reason"],
): PublicPostSlugRepositoryError => new PublicPostSlugRepositoryError({ reason });

const isoTimestamp = (value: unknown): string | null => {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value !== "string") return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
};

const aliasRecord = (row: Row): PostSlugAliasRecord | null => {
  const slug = row.slug;
  const postId = row.post_id;
  const policy = row.slug_policy_version;
  const createdAt = isoTimestamp(row.created_at);
  if (
    typeof slug !== "string" ||
    !isLogicalPostSlug(slug) ||
    typeof postId !== "string" ||
    postId.length === 0 ||
    postId.trim() !== postId ||
    policy !== POST_SLUG_POLICY_VERSION ||
    createdAt === null
  ) {
    return null;
  }
  return { slug, postId, slugPolicyVersion: policy, createdAt };
};

const lookupByPostId = (transaction: ControlPlaneTransaction, postId: string) =>
  transaction.execute<Row>({
    label: "public-post-slug.lookup-by-post-id",
    text: `SELECT slug, post_id, slug_policy_version, created_at
             FROM post_slug_aliases
            WHERE post_id = $1`,
    values: [postId],
    readonly: true,
  });

const insertAlias = (transaction: ControlPlaneTransaction, postId: string, slug: string) =>
  transaction.execute<Row>({
    label: "public-post-slug.insert",
    text: `INSERT INTO post_slug_aliases (slug, post_id, slug_policy_version)
          VALUES ($1, $2, $3)
          ON CONFLICT DO NOTHING
          RETURNING slug, post_id, slug_policy_version, created_at`,
    values: [slug, postId, POST_SLUG_POLICY_VERSION],
    readonly: false,
  });

const secureOpaqueToken = (): string =>
  postSlugOpaqueToken(crypto.getRandomValues(new Uint8Array(10)));

const nextSlug = (
  candidate: PostSlugCandidate,
  attempt: number,
  nextOpaqueToken: () => string,
): string => {
  if (candidate.kind === "descriptive") {
    return postSlugCollisionCandidate(candidate.slug, attempt);
  }
  const token = nextOpaqueToken();
  if (!OPAQUE_TOKEN.test(token)) throw repositoryError("invalid-input");
  return `${candidate.prefix}-${token}`;
};

export const ensurePostSlugAliasInTransaction = (
  transaction: ControlPlaneTransaction,
  input: Readonly<{
    postId: string;
    candidate: PostSlugCandidate;
  }>,
  options: EnsureOptions = {},
): Effect.Effect<PostSlugAliasRecord, PublicPostSlugRepositoryError | ControlPlaneError> =>
  Effect.gen(function* () {
    if (
      input.postId.length === 0 ||
      input.postId.trim() !== input.postId ||
      (input.candidate.kind === "descriptive" && !isLogicalPostSlug(input.candidate.slug))
    ) {
      return yield* repositoryError("invalid-input");
    }

    const existing = yield* lookupByPostId(transaction, input.postId);
    if (existing.rows.length > 1) return yield* repositoryError("invalid-row");
    if (existing.rows.length === 1) {
      const decoded = aliasRecord(existing.rows[0] as Row);
      return decoded === null ? yield* repositoryError("invalid-row") : decoded;
    }

    const maxAttempts = options.maxAttempts ?? 10_000;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
      return yield* repositoryError("invalid-input");
    }
    const nextOpaqueToken = options.nextOpaqueToken ?? secureOpaqueToken;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const slug = yield* Effect.try({
        try: () => nextSlug(input.candidate, attempt, nextOpaqueToken),
        catch: () => repositoryError("invalid-input"),
      });
      const inserted = yield* insertAlias(transaction, input.postId, slug);
      if (inserted.rows.length > 1) return yield* repositoryError("invalid-row");
      if (inserted.rows.length === 1) {
        const decoded = aliasRecord(inserted.rows[0] as Row);
        return decoded === null ? yield* repositoryError("invalid-row") : decoded;
      }

      const winner = yield* lookupByPostId(transaction, input.postId);
      if (winner.rows.length > 1) return yield* repositoryError("invalid-row");
      if (winner.rows.length === 1) {
        const decoded = aliasRecord(winner.rows[0] as Row);
        return decoded === null ? yield* repositoryError("invalid-row") : decoded;
      }
    }

    return yield* repositoryError("collision-exhausted");
  });
