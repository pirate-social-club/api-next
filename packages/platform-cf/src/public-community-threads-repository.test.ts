import { describe, expect, test } from "bun:test";
import {
  ControlPlaneDb,
  type ControlPlaneResult,
  type ControlPlaneStatement,
  PublicCommunityThreadsRepositoryError,
} from "@pirate/application";
import { Cause, Effect, Exit, Result } from "effect";
import { makeControlPlanePublicCommunityThreadsRepository } from "./public-community-threads-repository.ts";

type Row = Readonly<Record<string, unknown>>;

const community = (overrides: Row = {}): Row => ({
  community_id: "community-a",
  status: "active",
  display_name: "Alpha Community",
  route_slug: "alpha-community",
  membership_mode: "open",
  human_verification_lane: null,
  created_at: new Date("2026-08-17T10:00:00.000Z"),
  member_count: "2",
  follower_count: "3",
  ...overrides,
});

const post = (index: number, overrides: Row = {}): Row => ({
  post_id: `post_${index.toString().padStart(2, "0")}`,
  community_id: "community-a",
  author_user_id: "usr_author",
  body: `post ${index}`,
  title: null,
  created_at: new Date(1_787_000_000_000 - index * 1_000),
  upvote_count: "2",
  downvote_count: "1",
  comment_count: "0",
  ...overrides,
});

function fakeDb(responses: readonly (readonly Row[])[], calls: ControlPlaneStatement[]) {
  let index = 0;
  const execute = <R = unknown>(
    statement: ControlPlaneStatement,
  ): Effect.Effect<ControlPlaneResult<R>, never> => {
    calls.push(statement);
    const rows = responses[index++] ?? [];
    return Effect.succeed({ rows: rows as readonly R[], rowCount: rows.length });
  };
  return {
    execute,
    withTransaction: <A, E, R>(
      use: (transaction: { execute: typeof execute }) => Effect.Effect<A, E, R>,
    ) => use({ execute }),
  } satisfies ControlPlaneDb["Service"];
}

const runWith = <A, E>(
  effect: Effect.Effect<A, E, ControlPlaneDb>,
  db: ControlPlaneDb["Service"],
) => Effect.runPromiseExit(Effect.provideService(effect, ControlPlaneDb, db));

const input = (communityRef: string, query: Record<string, unknown> = {}) => ({
  communityRef,
  slugCandidate: decodeURIComponent(communityRef).toLowerCase(),
  query: { surface: "threads" as const, sort: "new" as const, ...query },
});

const failureOf = <E>(exit: Exit.Exit<unknown, E>): E | undefined => {
  if (!Exit.isFailure(exit)) return undefined;
  const failure = Cause.findError(exit.cause);
  return Result.isSuccess(failure) ? failure.success : undefined;
};

describe("public community threads Postgres repository", () => {
  test("resolves an exact community ID before a colliding slug", async () => {
    const calls: ControlPlaneStatement[] = [];
    const repository = makeControlPlanePublicCommunityThreadsRepository({
      now: () => 1_787_000_000_000,
    });
    const result = await runWith(
      repository.listPublicCommunityThreads(input("collision")),
      fakeDb(
        [
          [community({ community_id: "collision", route_slug: "different" })],
          [post(0, { community_id: "collision" })],
        ],
        calls,
      ),
    );
    expect(Exit.isSuccess(result)).toBe(true);
    if (Exit.isSuccess(result)) expect(result.value?.community.id).toBe("collision");
    expect(calls.map((call) => call.label)).toEqual([
      "public-community-threads.communities.resolve-id",
      "public-community-threads.posts.list-text",
    ]);
    expect(calls[0]?.values).toEqual(["collision"]);
  });

  test("uses the current persisted slug only after the exact ID misses", async () => {
    const calls: ControlPlaneStatement[] = [];
    const repository = makeControlPlanePublicCommunityThreadsRepository({
      now: () => 1_787_000_000_000,
    });
    const result = await runWith(
      repository.listPublicCommunityThreads(input("Alpha%2DCommunity", { locale: "ka" })),
      fakeDb([[], [community()], [post(0)]], calls),
    );
    expect(Exit.isSuccess(result)).toBe(true);
    if (Exit.isSuccess(result)) {
      expect(result.value?.community.id).toBe("community-a");
      expect(result.value?.items[0]?.resolved_locale).toBe("ka");
    }
    expect(calls[1]?.values).toEqual(["alpha-community"]);
  });

  test("does not fall back from an inactive exact ID or an unknown slug", async () => {
    const inactiveCalls: ControlPlaneStatement[] = [];
    const inactive = await runWith(
      repositoryFor().listPublicCommunityThreads(input("collision")),
      fakeDb([[community({ community_id: "collision", status: "archived" })]], inactiveCalls),
    );
    expect(Exit.isSuccess(inactive)).toBe(true);
    if (Exit.isSuccess(inactive)) expect(inactive.value).toBeNull();
    expect(inactiveCalls).toHaveLength(1);

    const unknown = await runWith(
      repositoryFor().listPublicCommunityThreads(input("missing")),
      fakeDb([[], []], []),
    );
    expect(Exit.isSuccess(unknown)).toBe(true);
    if (Exit.isSuccess(unknown)) expect(unknown.value).toBeNull();
  });

  test("filters to active-community public published text posts and orders newest-first", async () => {
    const calls: ControlPlaneStatement[] = [];
    const result = await runWith(
      repositoryFor().listPublicCommunityThreads(input("alpha")),
      fakeDb([[community()], [post(0), post(1)]], calls),
    );
    expect(Exit.isSuccess(result)).toBe(true);
    if (Exit.isSuccess(result)) {
      expect(result.value?.items.map((item) => item.post.id)).toEqual(["post_00", "post_01"]);
      expect(result.value?.items[0]?.viewer_vote).toBeNull();
      expect(result.value?.items[0]?.viewer_reaction_kinds).toEqual([]);
      expect(result.value?.community.viewer_following).toBeUndefined();
    }
    expect(calls[1]?.text).toContain("p.post_type = 'text'");
    expect(calls[1]?.text).toContain("p.status = 'published'");
    expect(calls[1]?.text).toContain("p.visibility = 'public'");
    expect(calls[1]?.text).toContain("ORDER BY p.created_at DESC, p.post_id DESC");
    expect(calls[1]?.values[0]).toBe("community-a");
  });

  test("rejects malformed and cross-community cursors", async () => {
    const malformedCalls: ControlPlaneStatement[] = [];
    const malformed = await runWith(
      repositoryFor().listPublicCommunityThreads(input("alpha", { cursor: "pct1.not-base64" })),
      fakeDb([[community()]], malformedCalls),
    );
    expect(failureOf(malformed)).toEqual(
      new PublicCommunityThreadsRepositoryError({
        operation: "list-public-community-threads",
        reason: "invalid-cursor",
      }),
    );
    expect(malformedCalls).toHaveLength(1);

    const firstCalls: ControlPlaneStatement[] = [];
    const first = await runWith(
      repositoryFor().listPublicCommunityThreads(input("alpha")),
      fakeDb([[community()], Array.from({ length: 21 }, (_, index) => post(index))], firstCalls),
    );
    expect(Exit.isSuccess(first)).toBe(true);
    if (!Exit.isSuccess(first) || first.value === null || first.value.next_cursor === null)
      throw new Error("cursor missing");
    const firstCursor = first.value.next_cursor;

    const crossCommunity = await runWith(
      repositoryFor().listPublicCommunityThreads(input("beta", { cursor: firstCursor })),
      fakeDb([[community({ community_id: "community-b", route_slug: "beta" })]], []),
    );
    expect(failureOf(crossCommunity)).toEqual(
      new PublicCommunityThreadsRepositoryError({
        operation: "list-public-community-threads",
        reason: "invalid-cursor",
      }),
    );
  });

  test("returns a structurally bound newest cursor without overlap", async () => {
    const repository = repositoryFor();
    const first = await runWith(
      repository.listPublicCommunityThreads(input("alpha")),
      fakeDb([[community()], Array.from({ length: 21 }, (_, index) => post(index))], []),
    );
    expect(Exit.isSuccess(first)).toBe(true);
    if (!Exit.isSuccess(first) || first.value === null || first.value.next_cursor === null)
      throw new Error("cursor missing");
    const firstCursor = first.value.next_cursor;
    const secondCalls: ControlPlaneStatement[] = [];
    const second = await runWith(
      repository.listPublicCommunityThreads(input("alpha", { cursor: firstCursor })),
      fakeDb([[community()], [post(20)]], secondCalls),
    );
    expect(Exit.isSuccess(second)).toBe(true);
    if (Exit.isSuccess(second))
      expect(second.value?.items.map((item) => item.post.id)).toEqual(["post_20"]);
    expect(secondCalls[1]?.values[2]).toBe(1_787_000_000_000 - 19_000);
    expect(secondCalls[1]?.values[3]).toBe("post_19");
  });
});

const repositoryFor = () =>
  makeControlPlanePublicCommunityThreadsRepository({ now: () => 1_787_000_000_000 });
