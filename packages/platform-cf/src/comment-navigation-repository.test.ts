import { expect, test } from "bun:test";
import {
  ControlPlaneDb,
  type ControlPlaneStatement,
  ControlPlaneStatementFailed,
} from "@pirate/application";
import { BadRequest, InternalError, NotFound } from "@pirate/contracts";
import { Effect, Layer } from "effect";
import { makeControlPlaneCommentNavigationStore } from "./comment-navigation-repository.ts";
import { makeCommentThreadStore } from "./comment-thread-repository.ts";

const locked = {
  kind: "age_locked",
  content_rating: "adult_18",
  next_action: { kind: "verify_minimum_age", minimum_age: 18 },
};
const document = {
  kind: "available",
  post_id: "post",
  community_id: "community",
  target_comment_id: "comment",
  ancestor_comment_ids: [],
  windows: [
    {
      parent_comment_id: null,
      branch_comment_id: "comment",
      earlier_items_omitted: false,
      next_cursor: null,
      items: [
        {
          comment_id: "comment",
          parent_comment_id: null,
          body: "body",
          author_persona: null,
          depth: 0,
          reply_count: 0,
          status: "published",
          content_rating: "general",
          created_at: "2026-10-16T00:00:00Z",
        },
      ],
    },
  ],
};
function store(result: unknown) {
  const statements: ControlPlaneStatement[] = [];
  const execute: ControlPlaneDb["Service"]["execute"] = (statement) => {
    statements.push(statement);
    return Effect.succeed({ rows: [{ result }] as never, rowCount: 1 });
  };
  const runtime = Layer.succeed(ControlPlaneDb, {
    execute,
    withTransaction: (use) => use({ execute }),
  });
  return {
    statements,
    repository: makeControlPlaneCommentNavigationStore(runtime),
    threads: makeCommentThreadStore(runtime),
  };
}
test("resolver makes one read-only statement and encodes a real Unicode alias, independent of public metadata", async () => {
  const { statements, repository } = store({
    post_type: "text",
    post_id: "post",
    post_slug: "世界の歌",
    document,
  });
  const result = await Effect.runPromise(
    repository.resolve({ viewerUserId: "viewer", commentId: "comment" }),
  );
  expect(result).toMatchObject({
    kind: "available",
    post_path: `/posts/${encodeURIComponent("世界の歌")}`,
  });
  expect(statements).toHaveLength(1);
  expect(statements[0]).toMatchObject({ readonly: true, values: ["viewer", "comment"] });
});
test("ordinary continuation keeps its wire result and scoped row cursor in one read-only snapshot", async () => {
  const { statements, threads } = store({
    kind: "available",
    document: { items: [], next_cursor: null },
  });
  expect(
    await Effect.runPromise(
      threads.list({
        viewerUserId: "reader",
        postId: "post",
        parentCommentId: "parent",
        cursor: "hidden-row",
      }),
    ),
  ).toEqual({ items: [], next_cursor: null });
  expect(statements).toHaveLength(1);
  expect(statements[0]).toMatchObject({
    readonly: true,
    values: ["reader", "post", "parent", "hidden-row"],
  });
  for (const kind of ["post_not_found", "comment_not_found", "invalid_cursor"])
    await expect(
      Effect.runPromise(store({ kind }).threads.list({ viewerUserId: "reader", postId: "post" })),
    ).rejects.toBeInstanceOf(kind === "invalid_cursor" ? BadRequest : NotFound);
});
test("null and invalid aliases redact to NotFound; existing target age variant carries no identifiers", async () => {
  for (const result of [
    null,
    { post_type: "text", post_id: "post", post_slug: "../private", document },
    { post_type: "text", post_id: "post", post_slug: "", document },
  ])
    await expect(
      Effect.runPromise(
        store(result).repository.resolve({ viewerUserId: "viewer", commentId: "comment" }),
      ),
    ).rejects.toBeInstanceOf(NotFound);
  expect(
    await Effect.runPromise(
      store({
        post_type: "text",
        post_id: "post",
        post_slug: "post",
        document: locked,
      }).repository.resolve({
        viewerUserId: "viewer",
        commentId: "comment",
      }),
    ),
  ).toEqual(locked);
});
test("storage failure preserves its cause for the HTTP error boundary", async () => {
  const cause = new ControlPlaneStatementFailed({
    label: "comments.navigation.resolve",
    sqlState: "23514",
    constraint: "private",
    outcomeCertainty: "aborted",
  });
  const execute: ControlPlaneDb["Service"]["execute"] = () => Effect.fail(cause);
  const repository = makeControlPlaneCommentNavigationStore(
    Layer.succeed(ControlPlaneDb, { execute, withTransaction: (use) => use({ execute }) }),
  );
  const error = await Effect.runPromise(
    Effect.flip(repository.resolve({ viewerUserId: "viewer", commentId: "comment" })),
  );
  expect(error).toBeInstanceOf(InternalError);
  expect(error).toMatchObject({ cause });
});

test("video target uses the owned primary ID codec without requiring an alias; unsafe or rebound IDs refuse", async () => {
  const result = await Effect.runPromise(
    store({ post_type: "video", post_id: "post", post_slug: null, document }).repository.resolve({
      viewerUserId: "viewer",
      commentId: "comment",
    }),
  );
  expect(result).toMatchObject({ kind: "available", post_path: "/post/post", post_id: "post" });
  for (const post_id of ["..", "a/b", "a%2f"])
    await expect(
      Effect.runPromise(
        store({ post_type: "video", post_id, post_slug: null, document }).repository.resolve({
          viewerUserId: "viewer",
          commentId: "comment",
        }),
      ),
    ).rejects.toBeInstanceOf(NotFound);
  await expect(
    Effect.runPromise(
      store({
        post_type: "video",
        post_id: "another",
        post_slug: null,
        document,
      }).repository.resolve({ viewerUserId: "viewer", commentId: "comment" }),
    ),
  ).rejects.toThrow();
});
