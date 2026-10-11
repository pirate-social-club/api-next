import { describe, expect, test } from "bun:test";
import { canonicalTextModerationInput, normalizeTextModerationInput } from "@pirate/domain";
import { Cause, Effect, Exit, Result } from "effect";
import { TextModerationProviderError, TextPostRepositoryError } from "../../ports.ts";
import type { TextPublicationStoreService } from "../../text-publication-store.ts";
import { createTextPost, getTextContentSubmission } from "./text-post.ts";

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

const store = (
  overrides: Partial<TextPublicationStoreService> = {},
): TextPublicationStoreService => ({
  checkAuthority: () => Effect.succeed(undefined),
  replay: () => Effect.succeed({ kind: "none" as const }),
  commitPublished: () => Effect.succeed({ kind: "created" as const, snapshot: published }),
  getForAuthor: () => Effect.succeed(published),
  ...overrides,
});

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseExit(effect);

describe("unmoderated text post application", () => {
  test.each(["general", "adult_18"] as const)(
    "publishes provider-absent text with declared %s rating",
    async (rating) => {
      let committed: Parameters<TextPublicationStoreService["commitPublished"]>[0] | undefined;
      const result = await run(
        createTextPost(
          { communityId: "community_1", actor, body: { ...body, author_declared_rating: rating } },
          {
            personaStore,
            textPostStore: store({
              commitPublished: (input) => {
                committed = input;
                return Effect.succeed({ kind: "created", snapshot: published });
              },
            }),
          },
        ),
      );
      expect(Exit.isSuccess(result) ? result.value : undefined).toEqual(published);
      expect(committed?.authorDeclaredRating).toBe(rating);
      expect(committed?.moderationInput.body).toBe("hello");
      expect(committed).not.toHaveProperty("evaluation");
      expect(committed).not.toHaveProperty("restrictedEvidence");
    },
  );

  test.each(["unavailable", "timeout", "invalid", "defect", "flagged"] as const)(
    "does not call the %s provider",
    async (mode) => {
      let calls = 0;
      const result = await run(
        createTextPost(
          { communityId: "community_1", actor, body },
          {
            personaStore,
            textPostStore: store(),
            textModerationProvider: {
              evaluate: () => {
                calls++;
                return mode === "defect"
                  ? Effect.die("provider must not run")
                  : mode === "flagged"
                    ? Effect.succeed({ ...evaluation(), matched_categories: ["sexual/minors"] })
                    : Effect.fail(new TextModerationProviderError({ reason: mode }));
              },
            },
          },
        ),
      );
      expect(Exit.isSuccess(result) ? result.value : undefined).toEqual(published);
      expect(calls).toBe(0);
    },
  );

  test("replays the stored response before authority or publication", async () => {
    const result = await run(
      createTextPost(
        { communityId: "community_1", actor, body },
        {
          personaStore,
          textPostStore: store({
            replay: () => Effect.succeed({ kind: "replay", snapshot: published }),
            checkAuthority: () => Effect.die("replay must precede authority"),
            commitPublished: () => Effect.die("replay must not publish twice"),
          }),
        },
      ),
    );
    expect(Exit.isSuccess(result) ? result.value : undefined).toEqual(published);
  });

  test("preserves a historical held response on same-key replay", async () => {
    const held = {
      ...published,
      status: "manual_review" as const,
      result: {
        decision: "manual_review" as const,
        reason_code: "moderation_unavailable" as const,
      },
      published_resource: null,
      review_ref: "review-historical",
    };
    const result = await run(
      createTextPost(
        { communityId: "community_1", actor, body },
        {
          personaStore,
          textPostStore: store({
            replay: () => Effect.succeed({ kind: "replay", snapshot: held }),
            commitPublished: () => Effect.die("historical replay must remain exact"),
          }),
        },
      ),
    );
    expect(Exit.isSuccess(result) ? result.value : undefined).toEqual(held);
  });

  test("includes the target community in the canonical request hash", async () => {
    const hashes: string[] = [];
    const services = {
      personaStore,
      textPostStore: store({
        commitPublished: (input) => {
          hashes.push(input.requestHash);
          return Effect.succeed({ kind: "created", snapshot: published });
        },
      }),
    };
    await run(createTextPost({ communityId: "community_1", actor, body }, services));
    await run(createTextPost({ communityId: "community_2", actor, body }, services));
    expect(hashes).toEqual([
      "a1d085158ec7b78f48ead88f3f02a1cc597f4e4ed91a0fa06b6850d4b367db8e",
      "97bc1607c7044b4929f55f62cf4e519417c17a39c9955f3ecd6cf1bd9e2ee880",
    ]);
  });

  test.each(["replay", "commit"] as const)(
    "maps a same-key hash conflict at %s",
    async (boundary) => {
      const conflict = { kind: "conflict" as const, submissionId: "submission_9" };
      const result = await run(
        createTextPost(
          { communityId: "community_1", actor, body },
          {
            personaStore,
            textPostStore: store(
              boundary === "replay"
                ? { replay: () => Effect.succeed(conflict) }
                : { commitPublished: () => Effect.succeed(conflict) },
            ),
          },
        ),
      );
      if (Exit.isSuccess(result)) throw new Error("expected conflict");
      const failure = Cause.findError(result.cause);
      expect(Result.isSuccess(failure) ? failure.success : undefined).toMatchObject({
        _tag: "IdempotencyConflict",
        details: { submission_id: "submission_9" },
      });
    },
  );

  test("GET remains author scoped", async () => {
    const result = await run(
      getTextContentSubmission({ submissionId: "submission_1", actor }, { textPostStore: store() }),
    );
    expect(Exit.isSuccess(result) ? result.value : undefined).toEqual(published);
  });

  test("checks community authority before publication", async () => {
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
            commitPublished: () => Effect.die("unauthorized text must not publish"),
          }),
        },
      ),
    );
    if (Exit.isSuccess(result)) throw new Error("expected authority failure");
    const failure = Cause.findError(result.cause);
    expect(Result.isSuccess(failure) ? failure.success : undefined).toMatchObject({
      _tag: "NotFound",
    });
  });
});
