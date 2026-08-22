import { describe, expect, test } from "bun:test";
import { canonicalTextModerationInput, normalizeTextModerationInput } from "@pirate/domain";
import { Cause, Effect, Exit, Result } from "effect";
import {
  TextModerationProviderError,
  type TextPostModerationEvaluation,
  type TextPostStore,
} from "../../ports.ts";
import { createCommentReply } from "./comments-replies.ts";

const actor = { userId: "usr_comments_order6", kind: "user" as const };
const body = { idempotency_key: "comment-key-1", body: "hello from a comment" };
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

const evaluation = (
  surface: "comment" | "reply" = "comment",
  decision: "allow" | "manual_review" = "allow",
): TextPostModerationEvaluation => ({
  version: "text-moderation-v1",
  surface,
  decision,
  reason_codes: decision === "allow" ? [] : ["provider_timeout"],
  policy_revision: "comments-policy-1",
  policy_hash: "b".repeat(64),
  input_sha256: inputSha(surface),
  evidence_ref: null,
});

const commentStore = (
  overrides: Partial<TextPostStore["Service"]> = {},
): TextPostStore["Service"] => ({
  replay: () => Effect.succeed({ kind: "none" as const }),
  commitTerminal: () => Effect.succeed({ kind: "created" as const, snapshot: published }),
  getForAuthor: () => Effect.succeed(published),
  resolveCommentTarget: () => Effect.succeed(target),
  ...overrides,
});

const commentModeration = {
  evaluate: () => Effect.succeed(evaluation()),
};

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseExit(effect);

describe("comments and replies application", () => {
  test("same-key/different-hash returns a typed 409 with submission_id", async () => {
    const result = await run(
      createCommentReply(
        { surface: "comment", targetId: "post-comments", actor, body },
        {
          textPostStore: commentStore({
            replay: () => Effect.succeed({ kind: "conflict", submissionId: "submission-winner" }),
          }),
          textModeration: commentModeration,
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
          textPostStore: commentStore({
            replay: () => Effect.succeed({ kind: "replay", snapshot: published }),
          }),
          textModeration: {
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
          textPostStore: commentStore({
            resolveCommentTarget: () => Effect.succeed({ kind: "depth-exceeded", depth: 9 }),
          }),
          textModeration: {
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

  test("provider unavailable commits as manual_review", async () => {
    let committed: TextPostModerationEvaluation | undefined;
    const held = {
      ...published,
      status: "manual_review" as const,
      result: {
        decision: "manual_review" as const,
        reason_code: "moderation_unavailable" as const,
      },
      published_resource: null,
      review_ref: "review-comment-1",
    };
    const result = await run(
      createCommentReply(
        { surface: "comment", targetId: "post-comments", actor, body },
        {
          textPostStore: commentStore({
            commitTerminal: ({ evaluation: value }) => {
              committed = value;
              return Effect.succeed({ kind: "created" as const, snapshot: held });
            },
          }),
          textModeration: {
            evaluate: () => Effect.fail(new TextModerationProviderError({ reason: "unavailable" })),
          },
        },
      ),
    );
    expect(Exit.isSuccess(result) ? result.value : undefined).toEqual(held);
    expect(committed).toMatchObject({
      decision: "manual_review",
      reason_codes: ["provider_unavailable"],
      input_sha256: inputSha(),
    });
  });
});
