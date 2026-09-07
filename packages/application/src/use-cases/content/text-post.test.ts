import { describe, expect, test } from "bun:test";
import { MODERATION_POLICY_CATEGORIES_V1, type ModerationPolicyTableV1 } from "@pirate/contracts";
import { canonicalTextModerationInput, normalizeTextModerationInput } from "@pirate/domain";
import { Cause, Effect, Exit, Result } from "effect";
import {
  TextModerationProviderError,
  type TextPostModerationEvaluation,
  TextPostRepositoryError,
  type TextPostStore,
} from "../../ports.ts";
import { createTextPost, getTextContentSubmission } from "./text-post.ts";

const policy = {
  policy_revision: "text-policy-1",
  policy_hash: "a".repeat(64),
  platform_policy_revision: "platform-1",
  platform_policy_hash: "b".repeat(64),
  community_policy_revision: "community-1",
  community_policy_hash: "c".repeat(64),
  platform_policy: Object.fromEntries(
    MODERATION_POLICY_CATEGORIES_V1.map((category) => [category, "permit"]),
  ) as ModerationPolicyTableV1,
  community_policy: Object.fromEntries(
    MODERATION_POLICY_CATEGORIES_V1.map((category) => [category, "permit"]),
  ) as ModerationPolicyTableV1,
};

const actor = { userId: "usr_author", kind: "user" as const };
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

const evaluation = () => ({
  provider_id: "openai" as const,
  requested_model: "test-model",
  returned_model: "test-model",
  input_sha256: inputSha(),
  matched_categories: [],
  inputs: [],
});

const store = (overrides: Partial<TextPostStore["Service"]> = {}): TextPostStore["Service"] => ({
  readModerationPolicy: () => Effect.succeed(policy),
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
            checkAuthority: () => Effect.die("replay must precede authority"),
            readModerationPolicy: () => Effect.die("replay must precede policy"),
          }),
          textModerationProvider: {
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

  test("provider absence commits V2 manual review with current policy and author rating", async () => {
    let committed: Parameters<TextPostStore["Service"]["commitTerminal"]>[0] | undefined;
    const result = await run(
      createTextPost(
        {
          communityId: "community_1",
          actor,
          body: { ...body, author_declared_rating: "adult_18" },
        },
        {
          personaStore,
          textPostStore: store({
            commitTerminal: (input) => {
              committed = input;
              return Effect.succeed({ kind: "created", snapshot: published });
            },
          }),
        },
      ),
    );
    expect(Exit.isSuccess(result)).toBe(true);
    expect(committed?.evaluation).toEqual({
      version: "text-moderation-v2",
      surface: "text_post",
      decision: "manual_review",
      reason_codes: ["provider_unavailable"],
      policy_revision: policy.policy_revision,
      policy_hash: policy.policy_hash,
      platform_policy_revision: policy.platform_policy_revision,
      platform_policy_hash: policy.platform_policy_hash,
      community_policy_revision: policy.community_policy_revision,
      community_policy_hash: policy.community_policy_hash,
      matched_categories: [],
      category_decisions: {},
      effective_policy_decision: "review",
      author_declared_rating: "adult_18",
      resulting_content_rating: "adult_18",
      input_sha256: inputSha(),
      evidence_ref: null,
    });
    expect(committed?.restrictedEvidence).toBeUndefined();
  });

  test("policy read failure stops before provider and terminal commit", async () => {
    let commits = 0;
    let providers = 0;
    const result = await run(
      createTextPost(
        { communityId: "community_1", actor, body },
        {
          personaStore,
          textPostStore: store({
            readModerationPolicy: () =>
              Effect.fail(
                new TextPostRepositoryError({ operation: "authority", reason: "invalid-row" }),
              ),
            commitTerminal: () => {
              commits++;
              return Effect.succeed({ kind: "created", snapshot: published });
            },
          }),
          textModerationProvider: {
            evaluate: () => {
              providers++;
              return Effect.succeed(evaluation());
            },
          },
        },
      ),
    );
    expect(Exit.isFailure(result)).toBe(true);
    expect({ commits, providers }).toEqual({ commits: 0, providers: 0 });
  });

  test.each(["timeout", "invalid", "defect", "hash-mismatch"] as const)(
    "provider %s degrades without fabricated evidence",
    async (mode) => {
      let committed: Parameters<TextPostStore["Service"]["commitTerminal"]>[0] | undefined;
      const result = await run(
        createTextPost(
          { communityId: "community_1", actor, body },
          {
            personaStore,
            textPostStore: store({
              commitTerminal: (input) => {
                committed = input;
                return Effect.succeed({ kind: "created", snapshot: published });
              },
            }),
            textModerationProvider: {
              evaluate: () =>
                mode === "defect"
                  ? Effect.die("invalid provider payload")
                  : mode === "hash-mismatch"
                    ? Effect.succeed({ ...evaluation(), input_sha256: "0".repeat(64) })
                    : Effect.fail(new TextModerationProviderError({ reason: mode })),
            },
          },
        ),
      );
      expect(Exit.isSuccess(result)).toBe(true);
      expect(committed?.evaluation).toMatchObject({
        version: "text-moderation-v2",
        decision: "manual_review",
        reason_codes: [mode === "timeout" ? "provider_timeout" : "provider_invalid"],
        evidence_ref: null,
        platform_policy_revision: policy.platform_policy_revision,
      });
      expect(committed?.restrictedEvidence).toBeUndefined();
    },
  );

  test("stale-policy retries reread the policy and stop at three commits", async () => {
    const revisions: string[] = [];
    let reads = 0;
    const result = await run(
      createTextPost(
        { communityId: "community_1", actor, body },
        {
          personaStore,
          textPostStore: store({
            readModerationPolicy: () =>
              Effect.succeed({ ...policy, policy_revision: `policy-${++reads}` }),
            commitTerminal: ({ evaluation }) => {
              revisions.push(evaluation.policy_revision);
              return Effect.succeed({
                kind: "policy-stale",
                policyRevision: "newer",
                policyHash: policy.policy_hash,
              });
            },
          }),
        },
      ),
    );
    expect(Exit.isFailure(result)).toBe(true);
    expect(revisions).toEqual(["policy-1", "policy-2", "policy-3"]);
    expect(reads).toBe(3);
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
      textModerationProvider: moderation,
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
          textModerationProvider: {
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
          textModerationProvider: moderation,
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
          textModerationProvider: moderation,
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
