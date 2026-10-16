import { expect, test } from "bun:test";
import { Schema } from "effect";
import { AvailableCommentNavigationV1, ResolveCommentNavigationV1 } from "./comment-navigation.ts";

test("navigation is authenticated and uses the existing bare age variant without leaking branch metadata", () => {
  expect(ResolveCommentNavigationV1.path).toBe("/comments/:commentId/location");
  const locked = {
    kind: "age_locked",
    content_rating: "adult_18",
    next_action: { kind: "verify_minimum_age", minimum_age: 18 },
  };
  const decode = Schema.decodeUnknownSync(ResolveCommentNavigationV1.response, {
    onExcessProperty: "error",
  });
  expect(decode(locked)).toEqual(locked);
  expect(() => decode({ ...locked, post_id: "private" })).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(AvailableCommentNavigationV1)({
      kind: "available",
      post_path: "/comments/x",
      post_id: "p",
      community_id: "c",
      target_comment_id: "t",
      ancestor_comment_ids: [],
      windows: [],
    }),
  ).toThrow();
});
