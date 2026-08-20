import { describe, expect, test } from "bun:test";
import { BadRequest, InternalError, NotFound } from "@pirate/contracts";
import { Effect } from "effect";
import {
  type PublicCommunityThreadsDocument,
  PublicCommunityThreadsRepositoryError,
  type PublicCommunityThreadsStoreService,
} from "../../ports.ts";
import {
  getPublicCommunityThreads,
  normalizePublicCommunityRef,
} from "./public-community-threads.ts";

const emptyDocument: PublicCommunityThreadsDocument = {
  community: {
    id: "community-a",
    object: "community_preview",
    route_slug: "alpha-community",
    display_name: "Alpha Community",
    membership_mode: "open",
    human_verification_lane: null,
    moderators: [],
    membership_gate_summaries: [],
    rules: [],
    created: 1,
  },
  items: [],
  next_cursor: null,
};

describe("public community threads use case", () => {
  test("accepts one exact slug candidate and rejects aliases rather than rewriting", () => {
    expect(normalizePublicCommunityRef("alpha-community")).toBe("alpha-community");
    for (const alias of [
      "Alpha-Community",
      "Alpha%2DCommunity",
      "ｍｕｓｉｃ",
      "ⓜⓤⓢⓘⓒ",
      "alpha%2Fcommunity",
      "%E0%A4%A",
    ]) {
      expect(() => normalizePublicCommunityRef(alias), alias).toThrow(BadRequest);
    }
  });

  test("passes the exact query contract and unmodified candidate to storage", async () => {
    let observed: unknown;
    const store: PublicCommunityThreadsStoreService = {
      listPublicCommunityThreads: (input) => {
        observed = input;
        return Effect.succeed(emptyDocument);
      },
    };

    await expect(
      Effect.runPromise(
        getPublicCommunityThreads(
          {
            communityRef: "alpha-community",
            query: { surface: "threads", sort: "new", locale: "ka" },
          },
          { publicCommunityThreadsStore: store },
        ),
      ),
    ).resolves.toEqual(emptyDocument);
    expect(observed).toEqual({
      communityRef: "alpha-community",
      slugCandidate: "alpha-community",
      query: { surface: "threads", sort: "new", locale: "ka" },
    });
  });

  test("attempts an unrestricted exact ID before treating its slug candidate as unsafe", async () => {
    let observed: unknown;
    const store: PublicCommunityThreadsStoreService = {
      listPublicCommunityThreads: (input) => {
        observed = input;
        return Effect.succeed(emptyDocument);
      },
    };

    await expect(
      Effect.runPromise(
        getPublicCommunityThreads(
          {
            communityRef: "community_1",
            query: { surface: "threads", sort: "new" },
          },
          { publicCommunityThreadsStore: store },
        ),
      ),
    ).resolves.toEqual(emptyDocument);
    expect(observed).toEqual({
      communityRef: "community_1",
      slugCandidate: null,
      query: { surface: "threads", sort: "new" },
    });
  });

  test("rejects unsupported query members before storage", async () => {
    let called = false;
    const store: PublicCommunityThreadsStoreService = {
      listPublicCommunityThreads: () => {
        called = true;
        return Effect.succeed(emptyDocument);
      },
    };
    for (const query of [
      { surface: "videos", sort: "new" },
      { surface: "threads", sort: "best" },
      { surface: "threads", sort: "new", time_range: "day" },
    ] as const) {
      const exit = await Effect.runPromiseExit(
        getPublicCommunityThreads(
          { communityRef: "alpha", query: query as never },
          { publicCommunityThreadsStore: store },
        ),
      );
      expect(String(exit)).toContain(BadRequest.name);
    }
    expect(called).toBe(false);
  });

  test("maps unknown communities, malformed cursors, and invalid rows", async () => {
    const notFoundStore: PublicCommunityThreadsStoreService = {
      listPublicCommunityThreads: () => Effect.succeed(null),
    };
    const cursorStore: PublicCommunityThreadsStoreService = {
      listPublicCommunityThreads: () =>
        Effect.fail(
          new PublicCommunityThreadsRepositoryError({
            operation: "list-public-community-threads",
            reason: "invalid-cursor",
          }),
        ),
    };
    const rowStore: PublicCommunityThreadsStoreService = {
      listPublicCommunityThreads: () =>
        Effect.fail(
          new PublicCommunityThreadsRepositoryError({
            operation: "list-public-community-threads",
            reason: "invalid-row",
          }),
        ),
    };
    const input = { communityRef: "alpha", query: { surface: "threads", sort: "new" } } as const;
    expect(
      String(
        await Effect.runPromiseExit(
          getPublicCommunityThreads(input, { publicCommunityThreadsStore: notFoundStore }),
        ),
      ),
    ).toContain(NotFound.name);
    expect(
      String(
        await Effect.runPromiseExit(
          getPublicCommunityThreads(input, { publicCommunityThreadsStore: cursorStore }),
        ),
      ),
    ).toContain(BadRequest.name);
    expect(
      String(
        await Effect.runPromiseExit(
          getPublicCommunityThreads(input, { publicCommunityThreadsStore: rowStore }),
        ),
      ),
    ).toContain(InternalError.name);
  });
});
