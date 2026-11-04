import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { LocalizedPostDocument } from "../ports.ts";
import {
  getPublicProfileActivity,
  type ProfileActivityReference,
  type ProfileActivityStore,
} from "./profile-activity.ts";

const reference: ProfileActivityReference = {
  kind: "post",
  activity_id: "post",
  activity_at: "2026-10-05T10:00:00.123456Z",
  community_id: "crew",
  post_id: "post",
  post_slug: "harbor",
};
const content = {
  post: {
    id: "post",
    status: "published",
    identity_mode: "public",
    author_persona: { persona_id: "persona" },
  },
} as Exclude<LocalizedPostDocument, { kind: "age_locked" }>;
describe("profile activity projection", () => {
  test("projects live persona content and uses the allocated post destination", async () => {
    const calls: unknown[] = [];
    const page = await Effect.runPromise(
      getPublicProfileActivity(
        { personaId: "persona", viewerId: "viewer", surface: "posts" },
        {
          list: (input) => {
            calls.push(input);
            return Effect.succeed([reference]);
          },
        },
        {
          getPost: (input) => {
            calls.push(input);
            return Effect.succeed(content);
          },
        },
      ),
    );
    expect(page.items[0]).toMatchObject({ kind: "post", href: "/posts/harbor" });
    expect(calls[0]).toEqual({
      personaId: "persona",
      viewerId: "viewer",
      surface: "posts",
      cursor: null,
    });
    expect(calls[1]).toMatchObject({ viewerUserId: "viewer", postId: "post" });
  });
  test("drops content that changed authorship or publication state after selection", async () => {
    for (const post of [
      { ...content.post, status: "hidden" as const },
      { ...content.post, identity_mode: "anonymous" as const },
      { ...content.post, author_persona: null },
    ]) {
      const page = await Effect.runPromise(
        getPublicProfileActivity(
          { personaId: "persona" },
          { list: () => Effect.succeed([reference]) },
          { getPost: () => Effect.succeed({ ...content, post }) },
        ),
      );
      expect(page.items).toEqual([]);
    }
  });
  test("rejects cursors from another persona, tab or invalid calendar before reading", async () => {
    let reads = 0;
    const store: ProfileActivityStore = {
      list: () => {
        reads++;
        return Effect.succeed([]);
      },
    };
    const cursor = {
      persona_id: "persona",
      surface: "overview",
      at: reference.activity_at,
      id: "post",
      kind: "post",
    };
    for (const value of [
      "bad",
      JSON.stringify({ ...cursor, persona_id: "foreign" }),
      JSON.stringify({ ...cursor, surface: "posts" }),
      JSON.stringify({ ...cursor, at: "2026-02-30T10:00:00.123456Z" }),
    ])
      await expect(
        Effect.runPromise(
          getPublicProfileActivity({ personaId: "persona", cursor: value }, store, {
            getPost: () => Effect.succeed(null),
          }),
        ),
      ).rejects.toMatchObject({ _tag: "BadRequest" });
    expect(reads).toBe(0);
  });
  test("retains a progress cursor even if content disappears while projecting", async () => {
    const refs = Array.from({ length: 21 }, (_, i) => ({
      ...reference,
      activity_id: `post-${i}`,
      post_id: `post-${i}`,
    }));
    const page = await Effect.runPromise(
      getPublicProfileActivity(
        { personaId: "persona" },
        { list: () => Effect.succeed(refs) },
        { getPost: () => Effect.succeed(null) },
      ),
    );
    expect(page.items).toEqual([]);
    if (page.next_cursor === null) throw new Error("Expected progress cursor");
    expect(JSON.parse(page.next_cursor)).toMatchObject({
      persona_id: "persona",
      id: "post-19",
      surface: "overview",
    });
  });
});
