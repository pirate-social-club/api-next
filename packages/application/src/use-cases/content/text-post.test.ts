import { describe, expect, test } from "bun:test";
import { canonicalTextModerationInput, normalizeTextModerationInput } from "@pirate/domain";
import { Cause, Effect, Exit, Result } from "effect";
import {
  TextModerationProviderError,
  type TextPostModerationEvaluation,
  TextPostRepositoryError,
  type TextPostStore,
} from "../../ports.ts";
import { createTextPost, getTextContentSubmission } from "./text-post.ts";

const actor = { userId: "usr_alice", kind: "user" as const };
const personaId = "persona-text-author";
const body = {
  post_type: "text" as const,
  persona_id: personaId,
  idempotency_key: "key_1",
  body: "hello",
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
      created_at: "2026-08-21T12:00:00.000Z",
      retired_at: null,
    }),
};
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

const inputSha = () => {
  const normalized = normalizeTextModerationInput({ surface: "text_post", body: "hello" });
  if (normalized.kind === "rejected") throw new Error(normalized.reason);
  const canonical = canonicalTextModerationInput(normalized.input);
  if (canonical.kind === "rejected") throw new Error(canonical.reason);
  return canonical.sha256;
};

const evaluation = (
  policyRevision = "text-policy-1",
  decision: "allow" | "manual_review" = "allow",
): TextPostModerationEvaluation => ({
  version: "text-moderation-v1",
  surface: "text_post",
  decision,
  reason_codes: decision === "allow" ? [] : ["provider_timeout"],
  policy_revision: policyRevision,
  policy_hash: "a".repeat(64),
  input_sha256: inputSha(),
  evidence_ref: null,
});

const store = (overrides: Partial<TextPostStore["Service"]> = {}): TextPostStore["Service"] => ({
  checkAuthority: () => Effect.succeed(undefined),
  replay: () => Effect.succeed({ kind: "none" as const }),
  commitTerminal: () => Effect.succeed({ kind: "created" as const, snapshot: published }),
  getForAuthor: () => Effect.succeed(published),
  ...overrides,
});

const moderation = {
  evaluate: () => Effect.succeed(evaluation()),
};

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseExit(effect);

describe("moderated text post application", () => {
  test("replays before moderation", async () => {
    let calls = 0;
    const result = await run(
      createTextPost(
        { communityId: "community_1", actor, body },
        {
          personaStore,
          textPostStore: store({
            replay: () => Effect.succeed({ kind: "replay", snapshot: published }),
          }),
          textModeration: {
            evaluate: () => {
              calls += 1;
              return Effect.succeed(evaluation());
            },
          },
        },
      ),
    );
    expect(Exit.isSuccess(result) ? result.value : undefined).toEqual(published);
    expect(calls).toBe(0);
  });

  test("includes the target community in the canonical request hash", async () => {
    const requestHashes: string[] = [];
    const services = {
      personaStore,
      textPostStore: store({
        commitTerminal: ({ requestHash }) => {
          requestHashes.push(requestHash);
          return Effect.succeed({ kind: "created" as const, snapshot: published });
        },
      }),
      textModeration: moderation,
    };
    await run(createTextPost({ communityId: "community_1", actor, body }, services));
    await run(createTextPost({ communityId: "community_2", actor, body }, services));
    expect(requestHashes).toEqual([
      "a1d085158ec7b78f48ead88f3f02a1cc597f4e4ed91a0fa06b6850d4b367db8e",
      "97bc1607c7044b4929f55f62cf4e519417c17a39c9955f3ecd6cf1bd9e2ee880",
    ]);
  });

  test("maps provider unavailability to a terminal manual-review commit", async () => {
    let committed: TextPostModerationEvaluation | undefined;
    const result = await run(
      createTextPost(
        { communityId: "community_1", actor, body },
        {
          personaStore,
          textPostStore: store({
            commitTerminal: ({ evaluation: value }) => {
              committed = value;
              return Effect.succeed({ kind: "created" as const, snapshot: published });
            },
          }),
          textModeration: {
            evaluate: () => Effect.fail(new TextModerationProviderError({ reason: "unavailable" })),
          },
        },
      ),
    );
    expect(Exit.isSuccess(result)).toBe(true);
    expect(committed).toMatchObject({
      decision: "manual_review",
      reason_codes: ["provider_unavailable"],
      input_sha256: inputSha(),
    });
  });

  test("retries when the commit-time policy fence is stale", async () => {
    let commits = 0;
    const result = await run(
      createTextPost(
        { communityId: "community_1", actor, body },
        {
          personaStore,
          textPostStore: store({
            commitTerminal: () => {
              commits += 1;
              return commits === 1
                ? Effect.succeed({
                    kind: "policy-stale" as const,
                    policyRevision: "text-policy-2",
                    policyHash: "b".repeat(64),
                  })
                : Effect.succeed({ kind: "created" as const, snapshot: published });
            },
          }),
          textModeration: moderation,
        },
      ),
    );
    expect(Exit.isSuccess(result)).toBe(true);
    expect(commits).toBe(2);
  });

  test("maps same-key hash conflict", async () => {
    const result = await run(
      createTextPost(
        { communityId: "community_1", actor, body },
        {
          personaStore,
          textPostStore: store({
            replay: () => Effect.succeed({ kind: "conflict", submissionId: "submission_9" }),
          }),
          textModeration: moderation,
        },
      ),
    );
    if (Exit.isSuccess(result)) throw new Error("expected conflict");
    const failure = Cause.findError(result.cause);
    expect(Result.isSuccess(failure) ? failure.success : undefined).toMatchObject({
      _tag: "IdempotencyConflict",
      details: { submission_id: "submission_9" },
    });
  });

  test("GET is author-scoped and does not invoke moderation", async () => {
    const result = await run(
      getTextContentSubmission({ submissionId: "submission_1", actor }, { textPostStore: store() }),
    );
    expect(Exit.isSuccess(result) ? result.value : undefined).toEqual(published);
  });

  test("checks community authority before invoking moderation", async () => {
    let moderationCalls = 0;
    const result = await run(
      createTextPost(
        { communityId: "community_1", actor, body },
        {
          personaStore,
          textPostStore: store({
            checkAuthority: () =>
              Effect.fail(
                new TextPostRepositoryError({ operation: "authority", reason: "not-found" }),
              ),
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
    expect(moderationCalls).toBe(0);
    if (Exit.isSuccess(result)) throw new Error("expected authority failure");
    const failure = Cause.findError(result.cause);
    expect(Result.isSuccess(failure) ? failure.success : undefined).toMatchObject({
      _tag: "NotFound",
    });
  });
});
