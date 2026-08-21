import { describe, expect, test } from "bun:test";
import { canonicalTextModerationInput, normalizeTextModerationInput } from "@pirate/domain";
import { Cause, Effect, Exit, Result } from "effect";
import {
  TextModerationProviderError,
  type TextPostModerationEvaluation,
  TextPostRepositoryError,
  type TextPostReservation,
  type TextPostStore,
} from "../../ports.ts";
import { createTextPost, getTextContentSubmission } from "./text-post.ts";

const actor = { userId: "usr_alice", kind: "user" as const };
const policyHash = "a".repeat(64);
const published = {
  submission_id: "submission_1",
  href: "/text-content-submissions/submission_1",
  surface: "text_post" as const,
  status: "published" as const,
  result: { decision: "allow" as const, reason_code: null },
  published_resource: { kind: "post" as const, post_id: "post_1", href: "/posts/post_1" },
  review_ref: null,
  created_at: "2026-08-21T12:00:00.000Z",
  updated_at: "2026-08-21T12:00:00.000Z",
};

const body = { post_type: "text" as const, idempotency_key: "key_1", body: "hello" };

function inputHash(): string {
  const normalized = normalizeTextModerationInput({ surface: "text_post", body: "hello" });
  if (normalized.kind === "rejected") throw new Error(normalized.reason);
  const canonical = canonicalTextModerationInput(normalized.input);
  if (canonical.kind === "rejected") throw new Error(canonical.reason);
  return canonical.sha256;
}

function reservation(policyRevision = "text-policy-1"): TextPostReservation {
  return {
    submissionId: "submission_1",
    communityId: "community_1",
    actorId: actor.userId,
    idempotencyKey: body.idempotency_key,
    requestHash: "request-hash",
    inputSha256: inputHash(),
    policyRevision,
    policyHash,
  };
}

function evaluation(
  policyRevision = "text-policy-1",
  decision: "allow" | "manual_review" = "allow",
) {
  return {
    version: "text-moderation-v1" as const,
    surface: "text_post" as const,
    decision,
    reason_codes: decision === "allow" ? [] : (["provider_timeout"] as const),
    policy_revision: policyRevision,
    policy_hash: policyHash,
    input_sha256: inputHash(),
    evidence_ref: null,
  };
}

function store(overrides: Partial<TextPostStore["Service"]> = {}): TextPostStore["Service"] {
  return {
    replay: () => Effect.succeed({ kind: "none" as const }),
    reserve: () => Effect.succeed({ kind: "reserved" as const, reservation: reservation() }),
    finalize: () => Effect.succeed({ kind: "created" as const, snapshot: published }),
    getForAuthor: () => Effect.succeed(published),
    ...overrides,
  };
}

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseExit(effect);

describe("moderated text post application", () => {
  test("replays before moderation and returns the immutable snapshot", async () => {
    let providerCalls = 0;
    const replay = await run(
      createTextPost(
        { communityId: "community_1", actor, body },
        {
          store: store({ replay: () => Effect.succeed({ kind: "replay", snapshot: published }) }),
          moderation: {
            evaluate: () => {
              providerCalls += 1;
              return Effect.succeed(evaluation());
            },
          },
        },
      ),
    );
    expect(Exit.isSuccess(replay) ? replay.value : undefined).toEqual({
      snapshot: published,
      replayed: true,
    });
    expect(providerCalls).toBe(0);
  });

  test("keeps moderation outside the store calls and retries a stale policy", async () => {
    const calls: string[] = [];
    let reserveCount = 0;
    const result = await run(
      createTextPost(
        { communityId: "community_1", actor, body },
        {
          store: store({
            replay: () => {
              calls.push("replay");
              return Effect.succeed({ kind: "none" as const });
            },
            reserve: () => {
              calls.push("reserve");
              reserveCount += 1;
              return Effect.succeed({
                kind: "reserved" as const,
                reservation: reservation(reserveCount === 1 ? "text-policy-1" : "text-policy-2"),
              });
            },
            finalize: () => {
              calls.push("finalize");
              return Effect.succeed(
                reserveCount === 1
                  ? ({ kind: "policy-stale", policyRevision: "text-policy-2", policyHash } as const)
                  : ({ kind: "created", snapshot: published } as const),
              );
            },
          }),
          moderation: {
            evaluate: (input) => {
              calls.push(`provider:${input.surface}`);
              return Effect.succeed(
                evaluation(reserveCount === 1 ? "text-policy-1" : "text-policy-2"),
              );
            },
          },
        },
      ),
    );
    expect(Exit.isSuccess(result) ? result.value.replayed : undefined).toBe(false);
    expect(calls).toEqual([
      "replay",
      "reserve",
      "provider:text_post",
      "finalize",
      "replay",
      "reserve",
      "provider:text_post",
      "finalize",
    ]);
  });

  test("maps same-key/different-hash to the typed conflict with submission identity", async () => {
    const result = await run(
      createTextPost(
        { communityId: "community_1", actor, body },
        {
          store: store({
            replay: () => Effect.succeed({ kind: "conflict", submissionId: "submission_9" }),
          }),
          moderation: { evaluate: () => Effect.succeed(evaluation()) },
        },
      ),
    );
    if (Exit.isSuccess(result)) throw new Error("expected idempotency conflict");
    const failure = Cause.findError(result.cause);
    expect(Result.isSuccess(failure) ? failure.success : undefined).toMatchObject({
      _tag: "IdempotencyConflict",
      details: { reason_code: "idempotency_conflict", submission_id: "submission_9" },
    });
  });

  test("holds provider failures instead of publishing", async () => {
    let committed: TextPostModerationEvaluation | undefined;
    const result = await run(
      createTextPost(
        { communityId: "community_1", actor, body },
        {
          store: store({
            finalize: ({ evaluation: committedEvaluation }) => {
              committed = committedEvaluation;
              return Effect.succeed({ kind: "created" as const, snapshot: published });
            },
          }),
          moderation: {
            evaluate: () => Effect.fail(new TextModerationProviderError({ reason: "timeout" })),
          },
        },
      ),
    );
    expect(Exit.isSuccess(result)).toBe(true);
    expect(committed).toMatchObject({
      decision: "manual_review",
      reason_codes: ["provider_timeout"],
    });
  });

  test("returns the current author-scoped state", async () => {
    const result = await run(
      getTextContentSubmission({ submissionId: "submission_1", actor }, { store: store() }),
    );
    expect(Exit.isSuccess(result) ? result.value : undefined).toEqual(published);
  });

  test("maps repository failures without leaking storage details", async () => {
    const result = await run(
      getTextContentSubmission(
        { submissionId: "submission_1", actor },
        {
          store: store({
            getForAuthor: () =>
              Effect.fail(new TextPostRepositoryError({ operation: "get", reason: "invalid-row" })),
          }),
        },
      ),
    );
    expect(Exit.isFailure(result)).toBe(true);
    expect(Exit.isFailure(result) ? result.cause : undefined).toBeDefined();
  });
});
