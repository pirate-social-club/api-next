import { describe, expect, test } from "bun:test";
import { canonicalTextModerationInput, normalizeTextModerationInput } from "@pirate/domain";
import { Cause, Effect, Exit, Result } from "effect";
import { TextModerationProviderError, TextPostRepositoryError } from "../../ports.ts";
import type { TextPublicationStoreService } from "../../text-publication-store.ts";
import { createCommentReply } from "./comments-replies.ts";

const actor = { userId: "usr_comments_order6", kind: "user" as const };
const personaId = "persona-comments-author";
const body = {
  persona_id: personaId,
  idempotency_key: "comment-key-1",
  body: "hello from a comment",
};
const personaStore = {
  findOwned: () =>
    Effect.succeed({
      persona_id: personaId,
      object: "persona" as const,
      status: "active" as const,
      profile: {
        persona_id: personaId,
        object: "persona_profile" as const,
        revision: 1,
        display_name: null,
        avatar_ref: null,
        cover_ref: null,
        bio: null,
        preferred_locale: null,
        primary_public_handle: null,
      },
      wallet_set: { evm: null },
      community_binding: null,
      created_at: "2026-08-22T12:00:00.000Z",
      retired_at: null,
    }),
};
const target = {
  kind: "ready" as const,
  communityId: "community-comments",
  postId: "post-comments",
  parentCommentId: null,
  parentDepth: -1,
};
const published = {
  submission_id: "submission-comment-1",
  href: "/text-content-submissions/submission-comment-1",
  surface: "comment" as const,
  status: "published" as const,
  result: { decision: "allow" as const, reason_code: null },
  published_resource: {
    kind: "comment" as const,
    comment_id: "comment-1",
    href: "/comments/comment-1",
  },
  review_ref: null,
  created_at: "2026-08-22T12:00:00.000Z",
  updated_at: "2026-08-22T12:00:00.000Z",
};

const inputSha = (surface: "comment" | "reply" = "comment", text = body.body): string => {
  const normalized = normalizeTextModerationInput({ surface, title: null, body: text });
  if (normalized.kind === "rejected") throw new Error(normalized.reason);
  const canonical = canonicalTextModerationInput(normalized.input);
  if (canonical.kind === "rejected") throw new Error(canonical.reason);
  return canonical.sha256;
};

const evaluation = (surface: "comment" | "reply" = "comment") => ({
  provider_id: "openai" as const,
  requested_model: "test-model",
  returned_model: "test-model",
  input_sha256: inputSha(surface),
  matched_categories: [],
  inputs: [],
});

const commentStore = (
  overrides: Partial<TextPublicationStoreService> = {},
): TextPublicationStoreService => ({
  checkAuthority: () => Effect.succeed(undefined),
  replay: () => Effect.succeed({ kind: "none" as const }),
  commitPublished: () => Effect.succeed({ kind: "created" as const, snapshot: published }),
  getForAuthor: () => Effect.succeed(published),
  resolveCommentTarget: () => Effect.succeed(target),
  ...overrides,
});

const commentModeration = {
  evaluate: () => Effect.succeed(evaluation()),
};

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseExit(effect);

describe("comments and replies application", () => {
  test.each(["comment", "reply"] as const)(
    "publishes %s from its declared rating without provider calls",
    async (surface) => {
      for (const rating of ["general", "adult_18"] as const) {
        let committed: Parameters<TextPublicationStoreService["commitPublished"]>[0] | undefined;
        let calls = 0;
        const result = await run(
          createCommentReply(
            {
              surface,
              targetId: "target",
              actor,
              body: { ...body, author_declared_rating: rating },
            },
            {
              personaStore,
              textPostStore: commentStore({
                resolveCommentTarget: () =>
                  Effect.succeed({
                    ...target,
                    parentCommentId: surface === "reply" ? "parent" : null,
                  }),
                commitPublished: (input) => {
                  committed = input;
                  return Effect.succeed({ kind: "created", snapshot: published });
                },
              }),
              textModerationProvider: {
                evaluate: () => {
                  calls++;
                  return Effect.fail(new TextModerationProviderError({ reason: "unavailable" }));
                },
              },
            },
          ),
        );
        expect(Exit.isSuccess(result)).toBe(true);
        expect(calls).toBe(0);
        expect(committed?.authorDeclaredRating).toBe(rating);
        expect(committed?.target?.surface).toBe(surface);
        expect(committed).not.toHaveProperty("evaluation");
        expect(committed).not.toHaveProperty("restrictedEvidence");
      }
    },
  );

  test("same-key/different-hash returns a typed 409 with submission_id", async () => {
    const result = await run(
      createCommentReply(
        { surface: "comment", targetId: "post-comments", actor, body },
        {
          personaStore,
          textPostStore: commentStore({
            replay: () => Effect.succeed({ kind: "conflict", submissionId: "submission-winner" }),
          }),
          textModerationProvider: commentModeration,
        },
      ),
    );
    if (Exit.isSuccess(result)) throw new Error("expected idempotency conflict");
    const failure = Cause.findError(result.cause);
    expect(Result.isSuccess(failure) ? failure.success : undefined).toMatchObject({
      _tag: "IdempotencyConflict",
      details: { reason_code: "idempotency_conflict", submission_id: "submission-winner" },
    });
  });

  test("committed replay makes zero moderation calls", async () => {
    let moderationCalls = 0;
    const result = await run(
      createCommentReply(
        { surface: "comment", targetId: "post-comments", actor, body },
        {
          personaStore,
          textPostStore: commentStore({
            replay: () => Effect.succeed({ kind: "replay", snapshot: published }),
            checkAuthority: () => Effect.die("replay must precede authority"),
            commitPublished: () => Effect.die("replay must not publish again"),
          }),
          textModerationProvider: {
            evaluate: () => {
              moderationCalls += 1;
              return Effect.succeed(evaluation());
            },
          },
        },
      ),
    );
    expect(Exit.isSuccess(result) ? result.value : undefined).toEqual(published);
    expect(moderationCalls).toBe(0);
  });

  test("reply_depth_exceeded is rejected before moderation", async () => {
    let moderationCalls = 0;
    const result = await run(
      createCommentReply(
        { surface: "reply", targetId: "parent-too-deep", actor, body },
        {
          personaStore,
          textPostStore: commentStore({
            resolveCommentTarget: () => Effect.succeed({ kind: "depth-exceeded", depth: 9 }),
          }),
          textModerationProvider: {
            evaluate: () => {
              moderationCalls += 1;
              return Effect.succeed(evaluation("reply"));
            },
          },
        },
      ),
    );
    if (Exit.isSuccess(result)) throw new Error("expected depth rejection");
    const failure = Cause.findError(result.cause);
    expect(Result.isSuccess(failure) ? failure.success : undefined).toMatchObject({
      _tag: "ReplyDepthExceeded",
    });
    expect(moderationCalls).toBe(0);
  });

  test("checks route and membership authority before publication", async () => {
    let moderationCalls = 0;
    const result = await run(
      createCommentReply(
        { surface: "comment", targetId: "post-comments", actor, body },
        {
          personaStore,
          textPostStore: commentStore({
            checkAuthority: () =>
              Effect.fail(
                new TextPostRepositoryError({ operation: "authority", reason: "not-found" }),
              ),
          }),
          textModerationProvider: {
            evaluate: () => {
              moderationCalls += 1;
              return Effect.succeed(evaluation());
            },
          },
        },
      ),
    );

    expect(moderationCalls).toBe(0);
    if (Exit.isSuccess(result)) throw new Error("expected authority failure");
    const failure = Cause.findError(result.cause);
    expect(Result.isSuccess(failure) ? failure.success : undefined).toMatchObject({
      _tag: "NotFound",
    });
  });
});
