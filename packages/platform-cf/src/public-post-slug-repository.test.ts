import { describe, expect, test } from "bun:test";
import type {
  ControlPlaneResult,
  ControlPlaneStatement,
  ControlPlaneTransaction,
} from "@pirate/application";
import { Effect } from "effect";
import {
  ensurePostSlugAliasInTransaction,
  listPublicPostSitemapInTransaction,
  lookupPublicPostBySlugInTransaction,
  lookupPublicPostCanonicalRouteByPostIdInTransaction,
  PublicPostSlugRepositoryError,
} from "./public-post-slug-repository.ts";

type Row = Readonly<Record<string, unknown>>;
type Result = Readonly<{ rows: readonly Row[]; rowCount?: number }>;

const timestamp = "2026-09-01T12:00:00.000Z";
const aliasRow = (slug: string, postId = "post-1"): Row => ({
  slug,
  post_id: postId,
  slug_policy_version: "post-slug-v1",
  created_at: timestamp,
});

const liveRow = (overrides: Row = {}): Row => ({
  alias_slug: "hello-world",
  alias_post_id: "post-1",
  alias_slug_policy_version: "post-slug-v1",
  alias_created_at: timestamp,
  post_id: "post-1",
  community_id: "community-1",
  post_type: "text",
  post_status: "published",
  post_visibility: "public",
  content_rating: "general",
  community_status: "active",
  viewer_is_member: false,
  rating_view_allowed: true,
  ...overrides,
});

const transactionFor = (
  handler: (statement: ControlPlaneStatement) => Result,
): ControlPlaneTransaction => ({
  execute: <Output = unknown>(statement: ControlPlaneStatement) => {
    const result = handler(statement);
    return Effect.succeed({
      rows: result.rows as readonly Output[],
      rowCount: result.rowCount ?? result.rows.length,
    } satisfies ControlPlaneResult<Output>);
  },
});

describe("public post slug allocation", () => {
  test("returns the immutable existing alias without inserting", async () => {
    const labels: string[] = [];
    const transaction = transactionFor((statement) => {
      labels.push(statement.label);
      return { rows: [aliasRow("existing-slug")] };
    });

    await expect(
      Effect.runPromise(
        ensurePostSlugAliasInTransaction(transaction, {
          postId: "post-1",
          candidate: { kind: "descriptive", branch: "ascii", slug: "new-title" },
        }),
      ),
    ).resolves.toEqual({
      slug: "existing-slug",
      postId: "post-1",
      slugPolicyVersion: "post-slug-v1",
      createdAt: timestamp,
    });
    expect(labels).toEqual(["public-post-slug.lookup-by-post-id"]);
  });

  test("allocates base-3 after same-title conflicts", async () => {
    const insertedSlugs: string[] = [];
    let lookupCount = 0;
    const transaction = transactionFor((statement) => {
      if (statement.label === "public-post-slug.lookup-by-post-id") {
        lookupCount += 1;
        return { rows: [] };
      }
      const slug = statement.values[0];
      if (typeof slug !== "string") throw new Error("expected slug parameter");
      insertedSlugs.push(slug);
      return slug === "same-title-3" ? { rows: [aliasRow(slug)] } : { rows: [] };
    });

    const result = await Effect.runPromise(
      ensurePostSlugAliasInTransaction(transaction, {
        postId: "post-1",
        candidate: { kind: "descriptive", branch: "ascii", slug: "same-title" },
      }),
    );

    expect(result.slug).toBe("same-title-3");
    expect(insertedSlugs).toEqual(["same-title", "same-title-2", "same-title-3"]);
    expect(lookupCount).toBe(3);
  });

  test("observes the winner of a same-post race", async () => {
    let lookupCount = 0;
    const transaction = transactionFor((statement) => {
      if (statement.label === "public-post-slug.insert") return { rows: [] };
      lookupCount += 1;
      return lookupCount === 1 ? { rows: [] } : { rows: [aliasRow("race-winner")] };
    });

    const result = await Effect.runPromise(
      ensurePostSlugAliasInTransaction(transaction, {
        postId: "post-1",
        candidate: { kind: "descriptive", branch: "ascii", slug: "candidate" },
      }),
    );

    expect(result.slug).toBe("race-winner");
    expect(lookupCount).toBe(2);
  });

  test("regenerates opaque tokens after a slug collision", async () => {
    const tokens = ["0000000000", "1111111111"];
    const insertedSlugs: string[] = [];
    const transaction = transactionFor((statement) => {
      if (statement.label === "public-post-slug.lookup-by-post-id") return { rows: [] };
      const slug = statement.values[0];
      if (typeof slug !== "string") throw new Error("expected slug parameter");
      insertedSlugs.push(slug);
      return slug === "song-1111111111" ? { rows: [aliasRow(slug)] } : { rows: [] };
    });

    const result = await Effect.runPromise(
      ensurePostSlugAliasInTransaction(
        transaction,
        { postId: "post-1", candidate: { kind: "opaque", prefix: "song" } },
        { nextOpaqueToken: () => tokens.shift() ?? "2222222222" },
      ),
    );

    expect(result.slug).toBe("song-1111111111");
    expect(insertedSlugs).toEqual(["song-0000000000", "song-1111111111"]);
  });

  test("fails closed on invalid injected entropy", async () => {
    const transaction = transactionFor(() => ({ rows: [] }));

    await expect(
      Effect.runPromise(
        ensurePostSlugAliasInTransaction(
          transaction,
          { postId: "post-1", candidate: { kind: "opaque", prefix: "post" } },
          { nextOpaqueToken: () => "contains-u" },
        ),
      ),
    ).rejects.toBeInstanceOf(PublicPostSlugRepositoryError);
  });
});

describe("public post slug live-state lookups", () => {
  test("looks up an exact logical slug and joins current post/community guard facts", async () => {
    const statements: ControlPlaneStatement[] = [];
    const transaction = transactionFor((statement) => {
      statements.push(statement);
      return { rows: [liveRow()] };
    });

    const result = await Effect.runPromise(
      lookupPublicPostBySlugInTransaction(transaction, {
        slug: "hello-world",
      }),
    );

    expect(result).toMatchObject({
      alias: { slug: "hello-world", postId: "post-1" },
      post: {
        postId: "post-1",
        communityId: "community-1",
        status: "published",
        visibility: "public",
        contentRating: "general",
      },
      community: { communityId: "community-1", status: "active" },
      viewer: { userId: undefined, isMember: false, ratingViewAllowed: true, canRead: true },
      canonicalPath: "/posts/hello-world",
    });
    expect(statements).toHaveLength(1);
    expect(statements[0]?.label).toBe("public-post-slug.lookup-by-slug");
    expect(statements[0]?.values).toEqual(["hello-world", null]);
    expect(statements[0]?.text).toContain("WHERE a.slug = $1");
    expect(statements[0]?.text).toContain("JOIN posts AS p ON p.post_id = a.post_id");
    expect(statements[0]?.text).toContain(
      "JOIN communities AS c ON c.community_id = p.community_id",
    );
    expect(statements[0]?.text).toContain("can_account_view_content_rating_v1");
    expect(statements[0]?.text).not.toContain("p.title");
    expect(statements[0]?.text).not.toContain("p.body");
  });

  test("rejects malformed logical keys before any database lookup", async () => {
    let called = false;
    const transaction = transactionFor(() => {
      called = true;
      return { rows: [] };
    });

    await expect(
      Effect.runPromise(
        lookupPublicPostBySlugInTransaction(transaction, {
          slug: "hello%2Fworld",
        }),
      ),
    ).rejects.toMatchObject({ reason: "invalid-input" });
    expect(called).toBe(false);
  });

  test("resolves canonical route by globally unique post id and withholds guarded paths", async () => {
    const statements: ControlPlaneStatement[] = [];
    const transaction = transactionFor((statement) => {
      statements.push(statement);
      return {
        rows: [
          liveRow({
            post_visibility: "public",
            content_rating: "adult_18",
            rating_view_allowed: false,
          }),
        ],
      };
    });

    const result = await Effect.runPromise(
      lookupPublicPostCanonicalRouteByPostIdInTransaction(transaction, {
        postId: "post-1",
        viewerUserId: "viewer-1",
      }),
    );

    expect(result).toMatchObject({
      post: { postId: "post-1", contentRating: "adult_18" },
      viewer: { userId: "viewer-1", ratingViewAllowed: false, canRead: false },
      canonicalPath: null,
    });
    expect(statements[0]?.label).toBe("public-post-slug.lookup-canonical-route-by-post-id");
    expect(statements[0]?.values).toEqual(["post-1", "viewer-1"]);
    expect(statements[0]?.text).toContain("WHERE a.post_id = $1");
  });

  test("uses stable created-at/post-id sitemap order and an opaque resumable cursor", async () => {
    const statements: ControlPlaneStatement[] = [];
    let page = 0;
    const rows = [
      liveRow({ alias_slug: "first", alias_post_id: "post-1", alias_created_at: timestamp }),
      liveRow({ alias_slug: "second", alias_post_id: "post-2", alias_created_at: timestamp }),
      liveRow({
        alias_slug: "third",
        alias_post_id: "post-3",
        alias_created_at: "2026-09-01T12:01:00.000Z",
      }),
    ];
    const transaction = transactionFor((statement) => {
      statements.push(statement);
      page += 1;
      return { rows: page === 1 ? rows : [rows[2] as Row] };
    });

    const first = await Effect.runPromise(
      listPublicPostSitemapInTransaction(transaction, { limit: 2 }),
    );
    expect(first).toMatchObject({
      object: "public_post_sitemap_page",
      items: [{ canonical_path: "/posts/first" }, { canonical_path: "/posts/second" }],
    });
    expect(first.next_cursor).toStartWith("pps1.");
    expect(first.items[0]).not.toHaveProperty("post_id");
    expect(statements[0]?.values).toEqual([null, null, 3]);
    expect(statements[0]?.text).toContain("ORDER BY a.created_at ASC, a.post_id ASC");
    expect(statements[0]?.text).toContain("c.status = 'active'");
    expect(statements[0]?.text).toContain("p.status = 'published'");
    expect(statements[0]?.text).toContain("p.visibility = 'public'");
    expect(statements[0]?.text).toContain("p.content_rating = 'general'");

    const second = await Effect.runPromise(
      listPublicPostSitemapInTransaction(transaction, {
        cursor: first.next_cursor ?? undefined,
        limit: 2,
      }),
    );
    expect(second).toEqual({
      object: "public_post_sitemap_page",
      items: [{ canonical_path: "/posts/third" }],
      next_cursor: null,
    });
    expect(statements[1]?.values).toEqual(["2026-09-01T12:00:00.000Z", "post-2", 3]);
  });

  test("fails closed when a database row violates sitemap live-state filters", async () => {
    const transaction = transactionFor(() => ({
      rows: [liveRow({ post_status: "hidden" })],
    }));
    await expect(
      Effect.runPromise(listPublicPostSitemapInTransaction(transaction, { limit: 1 })),
    ).rejects.toMatchObject({ reason: "invalid-row" });
  });

  test.each([0, 1_001, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects sitemap limit %s before lookup",
    async (limit) => {
      const transaction = transactionFor(() => ({ rows: [] }));
      await expect(
        Effect.runPromise(listPublicPostSitemapInTransaction(transaction, { limit })),
      ).rejects.toMatchObject({ reason: "invalid-input" });
    },
  );

  test("rejects malformed sitemap cursors without querying", async () => {
    const transaction = transactionFor(() => ({ rows: [] }));
    await expect(
      Effect.runPromise(
        listPublicPostSitemapInTransaction(transaction, {
          cursor: "not-a-cursor",
          limit: 10,
        }),
      ),
    ).rejects.toMatchObject({ reason: "invalid-cursor" });
  });
});
