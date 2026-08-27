import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import type { TextPostStore } from "../../ports.ts";
import { reportComment } from "./comment-moderation.ts";

const actor = { userId: "usr_moderation_order6", kind: "user" as const, scopes: ["moderator"] };

const store = (overrides: Partial<TextPostStore["Service"]> = {}): TextPostStore["Service"] => ({
  checkAuthority: () => Effect.succeed(undefined),
  replay: () => Effect.succeed({ kind: "none" as const }),
  commitTerminal: () => Effect.die("unused"),
  getForAuthor: () => Effect.succeed(null),
  reportComment: () =>
    Effect.succeed({ reportId: "report-1", caseRef: "case-1", status: "open" as const }),
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
});
