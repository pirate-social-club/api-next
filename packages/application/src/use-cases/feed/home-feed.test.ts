import { describe, expect, test } from "bun:test";
import { BadRequest, InternalError } from "@pirate/contracts";
import { Effect } from "effect";
import { FeedRepositoryError, type FeedStore, type HomeFeedDocument } from "../../ports.ts";
import { getHomeFeed, getPublicHomeFeed } from "./home-feed.ts";

const emptyFeed: HomeFeedDocument = {
  items: [],
  top_communities: [],
  next_cursor: null,
};

describe("home feed use cases", () => {
  test("public feed never invents a viewer", async () => {
    let observed: unknown;
    const feedStore: FeedStore["Service"] = {
      listHome: (input) => {
        observed = input;
        return Effect.succeed(emptyFeed);
      },
    };

    expect(await Effect.runPromise(getPublicHomeFeed({ sort: "new" }, { feedStore }))).toEqual(
      emptyFeed,
    );
    expect(observed).toEqual({ query: { sort: "new" } });
  });

  test("authenticated feed passes only the canonical viewer ID", async () => {
    let observed: unknown;
    const feedStore: FeedStore["Service"] = {
      listHome: (input) => {
        observed = input;
        return Effect.succeed(emptyFeed);
      },
    };

    await Effect.runPromise(
      getHomeFeed({ query: { locale: "en" }, viewerUserId: "usr_1" }, { feedStore }),
    );
    expect(observed).toEqual({ query: { locale: "en" }, viewerUserId: "usr_1" });
  });

  test("rejects malformed viewer, locale, and cursor values before storage", async () => {
    const feedStore: FeedStore["Service"] = {
      listHome: () => Effect.succeed(emptyFeed),
    };

    for (const input of [
      { query: {}, viewerUserId: " usr_1" },
      { query: { locale: "" } },
      { query: { cursor: "bad\u0000cursor" } },
    ] as const) {
      const exit = await Effect.runPromiseExit(getHomeFeed(input, { feedStore }));
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") expect(String(exit.cause)).toContain(BadRequest.name);
    }
  });

  test("maps invalid cursors to BadRequest and redacts invalid rows", async () => {
    const invalidCursor: FeedStore["Service"] = {
      listHome: () =>
        Effect.fail(new FeedRepositoryError({ operation: "list-home", reason: "invalid-cursor" })),
    };
    const invalidRow: FeedStore["Service"] = {
      listHome: () =>
        Effect.fail(new FeedRepositoryError({ operation: "list-home", reason: "invalid-row" })),
    };

    const cursorExit = await Effect.runPromiseExit(
      getHomeFeed({ query: { cursor: "opaque" } }, { feedStore: invalidCursor }),
    );
    const rowExit = await Effect.runPromiseExit(
      getHomeFeed({ query: {} }, { feedStore: invalidRow }),
    );

    expect(String(cursorExit)).toContain(BadRequest.name);
    expect(String(rowExit)).toContain(InternalError.name);
  });
});
