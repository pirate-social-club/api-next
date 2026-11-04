import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  type CommunityNavigationStore,
  listMyModerationCommunities,
  listPopularCommunities,
} from "./community-navigation.ts";

const item = (id: string) => ({
  community_id: id,
  display_name: id,
  resource_href: `/c/${id}`,
  member_count: 0,
});
describe("community navigation reads", () => {
  test("defaults to a bounded member-ranked discovery read", async () => {
    const limits: number[] = [];
    const store: CommunityNavigationStore = {
      popular: (limit) => {
        limits.push(limit);
        return Effect.succeed([item("crew")]);
      },
      moderated: () => Effect.succeed([]),
    };
    expect(await Effect.runPromise(listPopularCommunities({}, store))).toMatchObject({
      ranked_by: "members",
      items: [item("crew")],
    });
    expect(limits).toEqual([20]);
    for (const limit of ["0", "101", "no", "1.5"])
      await expect(
        Effect.runPromise(listPopularCommunities({ limit }, store)),
      ).rejects.toMatchObject({ _tag: "BadRequest" });
    expect(limits).toEqual([20]);
  });
  test("moderation pagination retains account scope and capability", async () => {
    const calls: unknown[] = [];
    const rows = Array.from({ length: 101 }, (_, i) => item(`crew-${i}`));
    const store: CommunityNavigationStore = {
      popular: () => Effect.succeed([]),
      moderated: (account, cursor) => {
        calls.push([account, cursor]);
        return Effect.succeed(rows);
      },
    };
    const page = await Effect.runPromise(
      listMyModerationCommunities("account", { cursor: "crew" }, store),
    );
    expect(calls).toEqual([["account", "crew"]]);
    expect(page.capability).toBe("moderation.view");
    expect(page.items).toHaveLength(100);
    expect(page.next_cursor).toBe("crew-99");
  });
});
