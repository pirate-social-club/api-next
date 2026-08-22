import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Result } from "effect";
import { TextPostRepositoryError, type TextPostStore } from "../../ports.ts";
import { moderateCaseAction, reportComment } from "./comment-moderation.ts";

const actor = { userId: "usr_moderation_order6", kind: "user" as const, scopes: ["moderator"] };

const store = (overrides: Partial<TextPostStore["Service"]> = {}): TextPostStore["Service"] => ({
  checkAuthority: () => Effect.succeed(undefined),
  replay: () => Effect.succeed({ kind: "none" as const }),
  commitTerminal: () => Effect.die("unused"),
  getForAuthor: () => Effect.succeed(null),
  reportComment: () =>
    Effect.succeed({ reportId: "report-1", caseRef: "case-1", status: "open" as const }),
  moderateCaseAction: ({ action }) =>
    Effect.succeed({
      actionId: "action-1",
      caseRef: "case-1",
      action,
      targetStatus: action === "dismiss" ? ("published" as const) : ("published" as const),
    }),
  ...overrides,
});

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseExit(effect);

describe("comment moderation application", () => {
  test("maps report outcome to the public snake_case response", async () => {
    const result = await run(
      reportComment(
        {
          commentId: "comment-1",
          actor,
          body: { idempotency_key: "report-key", reason_code: "spam" },
        },
        { textPostStore: store() },
      ),
    );

    expect(Exit.isSuccess(result) ? result.value : undefined).toEqual({
      report_id: "report-1",
      case_ref: "case-1",
      status: "open",
    });
  });

  test("maps moderation action outcome to the public snake_case response", async () => {
    const result = await run(
      moderateCaseAction(
        {
          caseRef: "case-1",
          actor,
          body: { idempotency_key: "action-key", action: "dismiss" },
        },
        { textPostStore: store() },
      ),
    );

    expect(Exit.isSuccess(result) ? result.value : undefined).toEqual({
      action_id: "action-1",
      case_ref: "case-1",
      action: "dismiss",
      target_status: "published",
    });
  });

  test("maps approve-path repository failures to declared contract errors", async () => {
    const result = await run(
      moderateCaseAction(
        {
          caseRef: "case-1",
          actor,
          body: { idempotency_key: "action-key", action: "approve" },
        },
        {
          textPostStore: store({
            moderateCaseAction: () =>
              Effect.fail(
                new TextPostRepositoryError({ operation: "action", reason: "comments-locked" }),
              ),
          }),
        },
      ),
    );

    if (Exit.isSuccess(result)) throw new Error("expected comments_locked failure");
    const failure = Cause.findError(result.cause);
    expect(Result.isSuccess(failure) ? failure.success : undefined).toMatchObject({
      _tag: "CommentsLocked",
    });
  });

  test("does not let a non-moderator action reach the repository", async () => {
    let calls = 0;
    const result = await run(
      moderateCaseAction(
        {
          caseRef: "case-1",
          actor: { userId: "usr_member", kind: "user" },
          body: { idempotency_key: "action-key", action: "approve" },
        },
        {
          textPostStore: store({
            moderateCaseAction: () => {
              calls += 1;
              return Effect.fail(
                new TextPostRepositoryError({ operation: "action", reason: "not-found" }),
              );
            },
          }),
        },
      ),
    );

    expect(calls).toBe(1);
    if (Exit.isSuccess(result)) throw new Error("expected non-moderator not_found");
    const failure = Cause.findError(result.cause);
    expect(Result.isSuccess(failure) ? failure.success : undefined).toMatchObject({
      _tag: "NotFound",
    });
  });
});
