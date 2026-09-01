import { describe, expect, test } from "bun:test";
import { parsePostSlugBackfillDryRunArgs } from "./public-post-slug-backfill.ts";
import {
  type PostSlugBackfillAuthorization,
  parsePostSlugBackfillAuthorization,
  postSlugBackfillAuthorizationDigest,
} from "./public-post-slug-backfill-authorization.ts";
import {
  decodePostSlugBackfillCursor,
  encodePostSlugBackfillCursor,
  planPostSlugBackfillPage,
} from "./public-post-slug-backfill-planner.ts";
import {
  type PostSlugBackfillDatabase,
  runAuthorizedPostSlugBackfillPage,
  runPostSlugBackfillDryRunPage,
} from "./public-post-slug-backfill-transaction.ts";
import {
  type PostSlugBackfillPostRow,
  postSlugBackfillResultDigest,
} from "./public-post-slug-backfill-types.ts";

const at = (second: number): string =>
  `2026-09-01T00:00:${String(second).padStart(2, "0")}.000000Z`;
const cursor = (second: number, postId: string): string =>
  encodePostSlugBackfillCursor({ version: 1, createdAt: at(second), postId });

const row = (
  second: number,
  postId: string,
  overrides: Partial<PostSlugBackfillPostRow> = {},
): PostSlugBackfillPostRow => ({
  post_id: postId,
  community_id: "backfill-community",
  created_at: at(second),
  post_type: "text",
  status: "published",
  visibility: "public",
  content_rating: "general",
  community_status: "active",
  existing_slug: null,
  title: `Title ${second}`,
  body: null,
  ...overrides,
});

const upperBound = cursor(59, "post-upper");

const authorizationFor = (
  pageDigest: string,
  overrides: Partial<Omit<PostSlugBackfillAuthorization, "canonical_digest">> = {},
): PostSlugBackfillAuthorization => {
  const unsigned = {
    record_version: 1 as const,
    run_id: "public-post-slug-run-1",
    repository: "api-next" as const,
    database_environment: "staging",
    policy_version: "post-slug-v1" as const,
    actor_role: "operator" as const,
    authorized_at: "2026-09-01T00:00:00.000Z",
    expires_at: "2026-09-02T00:00:00.000Z",
    page_bounds: {
      page_size: 10,
      start_cursor: null,
      upper_bound: upperBound,
      max_pages: 1,
    },
    authorized_page_digests: [pageDigest],
    dry_run_result_digest: "a".repeat(64),
    ...overrides,
  };
  return {
    ...unsigned,
    canonical_digest: postSlugBackfillAuthorizationDigest(unsigned),
  };
};

describe("public Post slug backfill planner", () => {
  test("accepts only the bounded dry-run CLI surface", () => {
    expect(parsePostSlugBackfillDryRunArgs(["--dry-run"])).toEqual({
      cursor: null,
      pageSize: 100,
    });
    expect(
      parsePostSlugBackfillDryRunArgs([
        "--dry-run",
        "--page-size",
        "1000",
        "--cursor",
        cursor(1, "post-1"),
        "--upper-bound",
        upperBound,
      ]),
    ).toEqual({ cursor: cursor(1, "post-1"), upperBound, pageSize: 1000 });
    expect(() => parsePostSlugBackfillDryRunArgs(["--apply"])).toThrow("Usage");
    expect(() => parsePostSlugBackfillDryRunArgs(["--dry-run", "--cursor"])).toThrow(
      "requires a value",
    );
    expect(() => parsePostSlugBackfillDryRunArgs(["--dry-run", "--page-size", "1001"])).toThrow(
      "between 1 and 1000",
    );
    expect(() =>
      parsePostSlugBackfillDryRunArgs(["--dry-run", "--page-size", "10", "--page-size", "20"]),
    ).toThrow("Duplicate");
  });

  test("uses a strict canonical stable cursor", () => {
    const encoded = cursor(1, "post-1");
    expect(decodePostSlugBackfillCursor(encoded)).toEqual({
      version: 1,
      createdAt: at(1),
      postId: "post-1",
    });
    expect(() => decodePostSlugBackfillCursor(encoded.replace("ppsb1.", "pps1."))).toThrow(
      "invalid prefix",
    );
    expect(() => decodePostSlugBackfillCursor(`${encoded}=`)).toThrow();
    expect(() =>
      encodePostSlugBackfillCursor({
        version: 1,
        createdAt: "2026-09-01T00:00:01.000Z",
        postId: "post-1",
      }),
    ).toThrow("invalid version, timestamp, or post id");
  });

  test("orders exact microseconds and post ids with PostgreSQL C-collation semantics", () => {
    const plan = planPostSlugBackfillPage({
      rows: [
        row(1, "post-z", { created_at: "2026-09-01T00:00:01.000001Z" }),
        row(1, "post-A", { created_at: "2026-09-01T00:00:01.000002Z" }),
        row(1, "post-a", { created_at: "2026-09-01T00:00:01.000002Z" }),
      ],
      page_size: 3,
      upper_bound: cursor(59, "post-upper"),
    });
    expect(plan.decisions.map(({ post_id }) => post_id)).toEqual(["post-z", "post-A", "post-a"]);
  });

  test("classifies descriptive, opaque, existing, skipped, and blocking rows without guarded source", () => {
    const rows = [
      row(1, "post-public", { title: "Same title" }),
      row(2, "post-song", { post_type: "song", title: "Same title" }),
      row(3, "post-member", {
        visibility: "members_only",
        title: null,
        body: null,
      }),
      row(4, "post-adult", { content_rating: "adult_18", title: null, body: null }),
      row(5, "post-hidden", { status: "hidden", title: null, body: null }),
      row(6, "post-inactive", { community_status: "hidden", title: null, body: null }),
      row(7, "post-future", { post_type: "image", title: null, body: null }),
      row(8, "post-draft", { status: "draft", title: null, body: null }),
      row(9, "post-existing", { existing_slug: "already-there" }),
      row(10, "post-removed", { status: "removed", title: null, body: null }),
    ];
    const plan = planPostSlugBackfillPage({
      rows,
      page_size: 10,
      upper_bound: upperBound,
    });
    expect(plan.decisions.map(({ policy }) => policy)).toEqual([
      "descriptive",
      "descriptive",
      "opaque",
      "opaque",
      "opaque",
      "opaque",
      "opaque",
      "skip",
      "descriptive",
      "blocked",
    ]);
    expect(plan.report).toMatchObject({
      input_count: 10,
      existing_count: 1,
      descriptive_count: 3,
      opaque_count: 5,
      skipped_count: 1,
      blocked_count: 1,
      issue_counts: { "removed-not-normalized": 1 },
      collision_classes: [{ candidate: "same-title", count: 2 }],
    });
    expect(plan.decisions[2]?.candidate).toEqual({ kind: "opaque", prefix: "post" });
    expect(plan.decisions[6]?.candidate).toEqual({ kind: "opaque", prefix: "post" });
    expect(JSON.stringify(plan.decisions)).not.toContain("Title 3");
    expect(() =>
      planPostSlugBackfillPage({
        rows: [row(1, "guarded-leak", { visibility: "members_only", title: "secret title" })],
        page_size: 1,
        upper_bound: upperBound,
      }),
    ).toThrow("forbidden source text");
  });

  test("keeps page digests deterministic across an idempotent alias replay", () => {
    const input = {
      rows: [row(1, "post-1")],
      page_size: 10,
      upper_bound: upperBound,
    } as const;
    const first = planPostSlugBackfillPage(input);
    const second = planPostSlugBackfillPage(input);
    expect(second.report.page_digest).toBe(first.report.page_digest);
    const existing = planPostSlugBackfillPage({
      ...input,
      rows: [row(1, "post-1", { existing_slug: "title-1" })],
    });
    expect(existing.report.page_digest).toBe(first.report.page_digest);
    expect(existing.report.existing_count).toBe(1);
  });
});

describe("public Post slug backfill authorization and execution", () => {
  test("accepts only an unexpired canonical authorization record", () => {
    const authorization = authorizationFor("b".repeat(64));
    expect(
      parsePostSlugBackfillAuthorization(authorization, {
        now: new Date("2026-09-01T12:00:00.000Z"),
      }),
    ).toEqual(authorization);
    expect(() =>
      parsePostSlugBackfillAuthorization(
        { ...authorization, database_environment: "production" },
        { now: new Date("2026-09-01T12:00:00.000Z") },
      ),
    ).toThrow("digest does not match");
    expect(() =>
      parsePostSlugBackfillAuthorization(authorization, {
        now: new Date("2026-09-03T00:00:00.000Z"),
      }),
    ).toThrow("expired");
  });

  test("dry-run uses a read-only transaction and performs no writes", async () => {
    const statements: string[] = [];
    const database: PostSlugBackfillDatabase = {
      databaseEnvironment: "staging",
      withTransaction: async (use) =>
        use({
          query: async (text) => {
            statements.push(text);
            if (text.startsWith("SELECT p.post_id")) {
              return {
                rows: [
                  {
                    ...row(1, "post-1"),
                    created_at: at(1),
                  },
                ],
              };
            }
            return { rows: [] };
          },
        }),
    };
    const result = await runPostSlugBackfillDryRunPage({
      database,
      upperBound,
      pageSize: 10,
    });
    expect(result.mode).toBe("dry-run");
    expect(statements[0]).toContain("READ ONLY");
    expect(statements.some((statement) => /INSERT|UPDATE|DELETE/u.test(statement))).toBe(false);

    await expect(
      runPostSlugBackfillDryRunPage({
        database,
        upperBound,
        pageSize: 1001,
      }),
    ).rejects.toThrow("page-size-out-of-range");
    expect(statements.filter((statement) => statement.startsWith("SELECT p.post_id"))).toHaveLength(
      1,
    );
  });

  test("apply requires the authorized page digest and replay remains idempotent", async () => {
    const source = row(1, "post-1");
    const plan = planPostSlugBackfillPage({
      rows: [source],
      page_size: 10,
      upper_bound: upperBound,
    });
    const expectedCounts = {
      input: 1,
      descriptive: 1,
      opaque: 0,
      skipped: 0,
      blocked: 0,
    };
    const authorization = authorizationFor(plan.report.page_digest, {
      dry_run_result_digest: postSlugBackfillResultDigest({
        run_id: "public-post-slug-run-1",
        policy_version: "post-slug-v1",
        page_digests: [plan.report.page_digest],
        counts: expectedCounts,
      }),
    });
    let allocations = 0;
    const database: PostSlugBackfillDatabase = {
      databaseEnvironment: "staging",
      withTransaction: async (use) =>
        use({
          query: async (text) =>
            text.startsWith("SELECT p.post_id")
              ? {
                  rows: [
                    {
                      ...source,
                      created_at: source.created_at,
                      existing_slug: allocations === 0 ? null : "publication-winner-2",
                    },
                  ],
                }
              : { rows: [] },
        }),
    };
    const execute = () =>
      runAuthorizedPostSlugBackfillPage({
        database,
        allocator: async (_transaction, input) => {
          allocations += 1;
          return { postId: input.postId, slug: "title-1" };
        },
        runId: authorization.run_id,
        authorizationRegistry: { getRecordedAuthorization: async () => authorization },
        now: new Date("2026-09-01T12:00:00.000Z"),
      });
    const first = await execute();
    const replay = await execute();
    expect(first.checkpoint).toEqual(replay.checkpoint);
    expect(replay.plan.decisions[0]?.existing_slug).toBe("publication-winner-2");
    expect(first.checkpoint).toMatchObject({
      page_index: 1,
      cursor: upperBound,
      counts: expectedCounts,
      completed_at: "2026-09-01T12:00:00.000Z",
    });
    expect(first.checkpoint?.result_digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(allocations).toBe(1);

    allocations = 0;
    const { canonical_digest: _authorizationDigest, ...authorizedRecord } = authorization;
    const wrongResultRecord = {
      ...authorizedRecord,
      dry_run_result_digest: "d".repeat(64),
    };
    const wrongResultAuthorization = {
      ...wrongResultRecord,
      canonical_digest: postSlugBackfillAuthorizationDigest(wrongResultRecord),
    };
    await expect(
      runAuthorizedPostSlugBackfillPage({
        database,
        allocator: async () => {
          throw new Error("must not allocate");
        },
        runId: authorization.run_id,
        authorizationRegistry: {
          getRecordedAuthorization: async () => wrongResultAuthorization,
        },
        now: new Date("2026-09-01T12:00:00.000Z"),
      }),
    ).rejects.toThrow("result-digest-mismatch");
    expect(allocations).toBe(0);

    await expect(
      runAuthorizedPostSlugBackfillPage({
        database: { ...database, databaseEnvironment: "production" },
        allocator: async () => {
          throw new Error("must not allocate");
        },
        runId: authorization.run_id,
        authorizationRegistry: { getRecordedAuthorization: async () => authorization },
        now: new Date("2026-09-01T12:00:00.000Z"),
      }),
    ).rejects.toThrow("environment-mismatch");

    const tampered = { ...authorization, authorized_page_digests: ["c".repeat(64)] };
    await expect(
      runAuthorizedPostSlugBackfillPage({
        database,
        allocator: async () => {
          throw new Error("must not allocate");
        },
        runId: authorization.run_id,
        authorizationRegistry: { getRecordedAuthorization: async () => tampered },
        now: new Date("2026-09-01T12:00:00.000Z"),
      }),
    ).rejects.toThrow("digest does not match");
  });
});
