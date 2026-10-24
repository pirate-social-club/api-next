import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { OpenApiDocument } from "@pirate/contracts";
import {
  assertNoObsoleteBreakingChangeWaivers,
  type BreakingChangePolicy,
  classifyBreakingViolationOperationKey,
  filterAllowedBreakingChanges,
  parseBaselineDocument,
  runBreakingCheck,
  selectBaselineSha,
} from "./check-openapi-breaking.ts";

const BASELINE_SHA = "a".repeat(40);
const OTHER_BASELINE_SHA = "b".repeat(40);
const POST_OPERATION = "post_communitiesCommunityIdPosts";
const POST_GATE_VIOLATION =
  "error code removed on POST /communities/{communityId}/posts status 403: gate_unsatisfied";

function policy(
  expectedViolations: readonly string[],
  operationId = POST_OPERATION,
): BreakingChangePolicy {
  return {
    breakingChangeWaivers: [
      {
        baselineSha: BASELINE_SHA,
        expectedViolations,
        kind: "clean-break",
        operationId,
        reason: "ratified test transition",
      },
    ],
  };
}

function document(
  gateCodes: readonly string[],
  unrelatedCodes: readonly string[],
): OpenApiDocument {
  return {
    openapi: "3.1.0",
    info: { title: "test", version: "1" },
    paths: {
      "/communities/{communityId}/posts": {
        post: {
          operationId: "post_communitiesCommunityIdPosts",
          responses: {
            "201": { description: "created" },
            "403": { description: "forbidden", "x-error-codes": gateCodes },
          },
        },
      },
      "/unrelated": {
        get: {
          operationId: "get_unrelated",
          responses: {
            "200": { description: "ok" },
            "400": { description: "bad request", "x-error-codes": unrelatedCodes },
          },
        },
      },
    },
  };
}

describe("OpenAPI baseline selection", () => {
  test("uses the pull request base SHA", () => {
    expect(
      selectBaselineSha({
        eventName: "pull_request",
        pullRequestBaseSha: "base-for-pr",
        pushBaseSha: "first-parent",
      }),
    ).toBe("base-for-pr");
  });

  test("uses the pushed commit's first-parent SHA", () => {
    expect(
      selectBaselineSha({
        eventName: "push",
        pullRequestBaseSha: "base-for-pr",
        pushBaseSha: "first-parent",
      }),
    ).toBe("first-parent");
  });

  test("fails when the event's baseline is missing", () => {
    expect(() => selectBaselineSha({ eventName: "pull_request" })).toThrow(
      "Missing baseline SHA for pull_request event",
    );
  });
});

describe("2026-10-17 historical video-author deprecation", () => {
  const baseline = "6cf3018177d05c05b8e8aeaa25e81ec11e5c8799";
  // Independent declaration inventory, not copied from the policy at runtime.
  const targets = [
    [
      "get_publicPersonasPersonaIdActivity",
      "/public/personas/{personaId}/activity",
      "items.items.content.video.soundtrack",
      "activity",
    ],
    ["get_postsPostId", "/posts/{postId}", "video.soundtrack", "detail"],
    ["get_feedHomePublic", "/feed/home/public", "items.items.post.video.soundtrack", "home"],
    [
      "get_publicCommunitiesCommunityRefFeed",
      "/public-communities/{communityRef}/feed",
      "items.items.video.soundtrack",
      "community",
    ],
    ["get_feedHome", "/feed/home", "items.items.post.video.soundtrack", "home"],
    ["get_publicPostsBySlug", "/public/posts/by-slug", "content.video.soundtrack", "public"],
    [
      "get_publicPostsByIdPostIdCanonicalRoute",
      "/public/posts/by-id/{postId}/canonical-route",
      "content.video.soundtrack",
      "public",
    ],
  ] as const;
  const readPolicy = (): BreakingChangePolicy =>
    JSON.parse(
      readFileSync(
        new URL("./fixtures/openapi-video-author-waivers-20261017.json", import.meta.url),
        "utf8",
      ),
    );
  const messages = (path: string, prefix: string) => [
    `response GET ${path}: type changed from string to null at ${prefix}.origin_author_persona_id`,
    `response GET ${path}: type changed from string to null at ${prefix}.song_reference.song_author_persona_id`,
  ];
  type WireSchema = Record<string, unknown>;
  const object = (properties: Record<string, WireSchema>): WireSchema => ({
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  });
  const page = (items: WireSchema) => object({ items: { type: "array", items } });
  // Explicit small response fixtures exercise policy matching. The ignored
  // exact-raw proof separately compares retained6cf with actual tracked OpenAPI.
  const fixture = (nullable: boolean, extra = false): OpenApiDocument => {
    const string = { type: "string" };
    const author = nullable ? { anyOf: [string, { type: "null" }] } : string;
    const localized = object({
      video: object({
        soundtrack: object({
          origin_author_persona_id: author,
          song_reference: object({ song_author_persona_id: author }),
          extra_field: extra ? { anyOf: [string, { type: "null" }] } : string,
        }),
      }),
    });
    const paths: OpenApiDocument["paths"] = {};
    for (const [operationId, path, , view] of targets) {
      const schema =
        view === "home"
          ? page(object({ post: localized }))
          : view === "community"
            ? page(localized)
            : view === "activity"
              ? page(object({ content: localized }))
              : view === "public"
                ? object({ content: localized })
                : localized;
      paths[path] = {
        get: {
          operationId,
          responses: {
            "200": { content: { "application/json": { schema } } },
          },
        },
      };
    }
    return { openapi: "3.1.0", info: { title: "explicit policy fixtures", version: "1" }, paths };
  };
  // Test-only commit avoids pretending synthetic fixtures have the retained raw
  // hash. The historical entries remain bound exclusively to6cf.
  const fixturePolicy = (): BreakingChangePolicy => ({
    breakingChangeWaivers: readPolicy().breakingChangeWaivers.map((entry) => ({
      ...entry,
      baselineSha: BASELINE_SHA,
    })),
  });

  test("historical declaration is exactly seven operations and fourteen named fields", () => {
    const policy = readPolicy();
    expect(policy.breakingChangeWaivers.map(({ reason, ...entry }) => entry)).toEqual(
      targets.map(([operationId, path, prefix]) => ({
        baselineSha: baseline,
        expectedViolations: messages(path, prefix),
        kind: "deprecation",
        operationId,
      })),
    );
    const candidate: OpenApiDocument = JSON.parse(
      readFileSync(
        new URL("../apps/http-worker/src/generated/openapi.json", import.meta.url),
        "utf8",
      ),
    );
    for (const [id, path] of targets) expect(candidate.paths[path]?.get?.operationId).toBe(id);
    for (const entry of policy.breakingChangeWaivers) {
      expect(entry.reason).toContain(
        "docs/api-next/openapi-breaking-change-waivers.md#2026-10-17-video-author-redaction-deprecation",
      );
      expect(entry.reason).toContain(
        "0cfc6b10f84ff0445fc7952e49672d5f381a737d8c5ef608ccbca8a74b7563c3",
      );
      expect(entry.reason).toContain(
        "f8e20a02368394ca0c41d29b0e4723ee3519057659c54c2e318002ea2e7f6c34",
      );
    }
  });

  test("exact sets admit only the explicit fourteen fixture changes", () => {
    const observed = filterAllowedBreakingChanges(
      fixture(false),
      fixture(true),
      { breakingChangeWaivers: [] },
      BASELINE_SHA,
    );
    expect(observed).toEqual(
      targets.flatMap(([, path, prefix]) => messages(path, prefix)).toSorted(),
    );
    expect(
      filterAllowedBreakingChanges(fixture(false), fixture(true), fixturePolicy(), BASELINE_SHA),
    ).toEqual([]);
  });

  test("unexpected second, extra or differently named fields still fail closed", () => {
    const policy = fixturePolicy();
    for (const expected of [
      (values: readonly string[]) => values.slice(0, 1),
      (values: readonly string[]) =>
        values.map((value) =>
          value.replace("origin_author_persona_id", "different_author_persona_id"),
        ),
    ]) {
      const changed = {
        breakingChangeWaivers: policy.breakingChangeWaivers.map((entry) => ({
          ...entry,
          expectedViolations: expected(entry.expectedViolations),
        })),
      };
      expect(() =>
        filterAllowedBreakingChanges(fixture(false), fixture(true), changed, BASELINE_SHA),
      ).toThrow("Unexpected violations");
    }
    expect(() =>
      filterAllowedBreakingChanges(fixture(false), fixture(true, true), policy, BASELINE_SHA),
    ).toThrow("Unexpected violations");
  });

  test("method and response-status changes cannot fit an author-field declaration", () => {
    const [operationId, path] = targets[0];
    for (const method of ["get", "post"]) {
      const changed = fixture(true);
      changed.paths[path] = { [method]: { operationId, responses: {} } };
      expect(() =>
        filterAllowedBreakingChanges(fixture(false), changed, fixturePolicy(), BASELINE_SHA),
      ).toThrow("Unexpected violations");
    }
  });

  test("an unrelated operation's future widening remains unallowed", () => {
    const old = fixture(false);
    const next = fixture(true);
    const operation = (nullable: boolean) => ({
      operationId: "get_unrelated",
      responses: {
        "200": {
          content: {
            "application/json": {
              schema: object({
                title: nullable
                  ? { anyOf: [{ type: "string" }, { type: "null" }] }
                  : { type: "string" },
              }),
            },
          },
        },
      },
    });
    old.paths["/unrelated"] = { get: operation(false) };
    next.paths["/unrelated"] = { get: operation(true) };
    expect(filterAllowedBreakingChanges(old, next, fixturePolicy(), BASELINE_SHA)).toEqual([
      "response GET /unrelated: type changed from string to null at title",
    ]);
  });

  test("the real declaration stays inert at any other baseline", () => {
    expect(
      filterAllowedBreakingChanges(fixture(false), fixture(true), readPolicy(), BASELINE_SHA),
    ).toHaveLength(14);
  });

  test("duplicate and obsolete real entries remain errors", () => {
    const policy = readPolicy();
    const first = policy.breakingChangeWaivers[0];
    if (first === undefined) throw new Error("Required deprecation entry is missing");
    expect(() =>
      filterAllowedBreakingChanges(
        fixture(false),
        fixture(true),
        {
          breakingChangeWaivers: [...policy.breakingChangeWaivers, first],
        },
        BASELINE_SHA,
      ),
    ).toThrow("Duplicate breaking-change waiver");
    expect(() =>
      assertNoObsoleteBreakingChangeWaivers(policy, BASELINE_SHA, (sha) => {
        expect(sha).toBe(baseline);
        return true;
      }),
    ).toThrow("obsolete baseline reachable from HEAD");
  });
});

describe("retained baseline reference authority", () => {
  const retainedSha = "6cf3018177d05c05b8e8aeaa25e81ec11e5c8799";
  const emptyPolicy: BreakingChangePolicy = { breakingChangeWaivers: [] };
  const response = (schema: Record<string, unknown>): OpenApiDocument => ({
    openapi: "3.1.0",
    info: { title: "strict reference ownership", version: "1" },
    paths: {
      "/fixture": {
        get: {
          operationId: "get_fixture",
          responses: {
            "200": { content: { "application/json": { schema } } },
          },
        },
      },
    },
  });
  const malformed = () =>
    response({
      $ref: "#/$defs/Shared",
      $defs: { Shared: { type: "string" } },
    });

  test("known commit with different valid or invalid raw bytes fails before JSON parsing", () => {
    for (const raw of [
      JSON.stringify(response({ type: "string" })),
      "{invalid JSON",
      "\uFEFF{}",
      "{}\n",
    ]) {
      expect(() => parseBaselineDocument(retainedSha, raw)).toThrow(
        `Retained OpenAPI baseline artifact identity mismatch at ${retainedSha}`,
      );
    }
  });

  test("parsed objects cannot claim the known baseline without verified raw ownership", () => {
    expect(() =>
      filterAllowedBreakingChanges(
        malformed(),
        response({ type: "string" }),
        emptyPolicy,
        retainedSha,
      ),
    ).toThrow("Retained OpenAPI baseline requires verified raw artifact ownership");
    expect(() => parseBaselineDocument("not-a-resolved-commit", "{}")).toThrow(
      "Resolved baseline SHA",
    );
  });

  test("other baseline commits keep strict valid document-root references", () => {
    const valid: OpenApiDocument = {
      ...response({ $ref: "#/components/schemas/Shared" }),
      components: { schemas: { Shared: { type: "string" } } },
    };
    const baseline = parseBaselineDocument(BASELINE_SHA, JSON.stringify(valid));
    expect(filterAllowedBreakingChanges(baseline, valid, emptyPolicy, BASELINE_SHA)).toEqual([]);
  });

  test("unknown malformed baseline cannot receive embedded-definition ownership", () => {
    const baseline = parseBaselineDocument(BASELINE_SHA, JSON.stringify(malformed()));
    expect(() =>
      filterAllowedBreakingChanges(
        baseline,
        response({ type: "string" }),
        emptyPolicy,
        BASELINE_SHA,
      ),
    ).toThrow("Unresolved OpenAPI schema reference: #/$defs/Shared");
  });

  test("candidate dangling or embedded references are always strict", () => {
    const valid = response({ type: "string" });
    for (const candidate of [malformed(), response({ $ref: "#/components/schemas/Missing" })]) {
      expect(() =>
        filterAllowedBreakingChanges(valid, candidate, emptyPolicy, BASELINE_SHA),
      ).toThrow("Unresolved OpenAPI schema reference");
    }
  });

  test("exact field diagnostics prevent an allowance for one author from hiding the other", () => {
    const authorResponse = (nullable: boolean) =>
      response({
        type: "object",
        properties: {
          video: {
            type: "object",
            properties: {
              soundtrack: {
                type: "object",
                properties: {
                  origin_author_persona_id: nullable
                    ? { anyOf: [{ type: "string" }, { type: "null" }] }
                    : { type: "string" },
                  song_reference: {
                    type: "object",
                    properties: {
                      song_author_persona_id: nullable
                        ? { anyOf: [{ type: "string" }, { type: "null" }] }
                        : { type: "string" },
                    },
                    required: ["song_author_persona_id"],
                  },
                },
                required: ["origin_author_persona_id", "song_reference"],
              },
            },
            required: ["soundtrack"],
          },
        },
        required: ["video"],
      });
    const expected = [
      "response GET /fixture: type changed from string to null at video.soundtrack.origin_author_persona_id",
      "response GET /fixture: type changed from string to null at video.soundtrack.song_reference.song_author_persona_id",
    ] as const;
    const before = authorResponse(false);
    const after = authorResponse(true);
    expect(filterAllowedBreakingChanges(before, after, emptyPolicy, BASELINE_SHA)).toEqual(
      expected,
    );
    expect(() =>
      filterAllowedBreakingChanges(
        before,
        after,
        policy([expected[0]], "get_fixture"),
        BASELINE_SHA,
      ),
    ).toThrow(`Unexpected violations:\n  - ${expected[1]}`);
    expect(
      filterAllowedBreakingChanges(
        before,
        after,
        policy(expected, "get_fixture"),
        OTHER_BASELINE_SHA,
      ),
    ).toEqual(expected);
    expect(() =>
      filterAllowedBreakingChanges(before, after, policy(expected, "post_other"), BASELINE_SHA),
    ).toThrow("resolves to 0 baseline operations");
  });

  test("maintained entry rejects invalid arguments before any baseline lookup", async () => {
    let reads = 0;
    await expect(
      runBreakingCheck([], () => {
        reads++;
        throw new Error("unexpected baseline lookup");
      }),
    ).rejects.toThrow("Usage:");
    expect(reads).toBe(0);
  });

  test("known retained baseline cannot use the missing-document bootstrap exception", async () => {
    await expect(
      runBreakingCheck(["--base-sha", retainedSha], () => ({ resolvedSha: retainedSha })),
    ).rejects.toThrow("Retained OpenAPI baseline is missing its required artifact");
  });

  test("another resolved commit without a document retains the genuine bootstrap case", async () => {
    await expect(
      runBreakingCheck(["--base-sha", OTHER_BASELINE_SHA], () => ({
        resolvedSha: OTHER_BASELINE_SHA,
      })),
    ).resolves.toBeUndefined();
  });

  test("maintained entry checks resolved raw identity before candidate or policy dispatch", async () => {
    let reads = 0;
    await expect(
      runBreakingCheck(
        ["--base-sha", "retained-alias"],
        (requested, path) => {
          expect(requested).toBe("retained-alias");
          expect(path).toBe("apps/http-worker/src/generated/openapi.json");
          reads++;
          return { resolvedSha: retainedSha, text: "{invalid JSON" };
        },
        () => {
          throw new Error("unexpected ancestry lookup");
        },
      ),
    ).rejects.toThrow("Retained OpenAPI baseline artifact identity mismatch");
    expect(reads).toBe(1);
  });
});

describe("OpenAPI clean-break allowance", () => {
  test("keeps a waiver for the current baseline without consulting ancestry", () => {
    let consulted = false;

    expect(() =>
      assertNoObsoleteBreakingChangeWaivers(policy([POST_GATE_VIOLATION]), BASELINE_SHA, () => {
        consulted = true;
        return true;
      }),
    ).not.toThrow();
    expect(consulted).toBe(false);
  });

  test("rejects a non-current waiver whose baseline is reachable from HEAD", () => {
    const consulted: string[] = [];
    expect(() =>
      assertNoObsoleteBreakingChangeWaivers(
        policy([POST_GATE_VIOLATION]),
        OTHER_BASELINE_SHA,
        (commitSha) => {
          consulted.push(commitSha);
          return true;
        },
      ),
    ).toThrow(
      `Breaking-change waivers reference an obsolete baseline reachable from HEAD:\n  - ${POST_OPERATION} (${BASELINE_SHA})`,
    );
    expect(consulted).toEqual([BASELINE_SHA]);
  });

  test("keeps a non-ancestor waiver inert for an unrebased transition", () => {
    expect(() =>
      assertNoObsoleteBreakingChangeWaivers(
        policy([POST_GATE_VIOLATION]),
        OTHER_BASELINE_SHA,
        () => false,
      ),
    ).not.toThrow();
  });

  test("fails closed when Git ancestry cannot be determined", () => {
    expect(() =>
      assertNoObsoleteBreakingChangeWaivers(
        policy([POST_GATE_VIOLATION]),
        OTHER_BASELINE_SHA,
        () => {
          throw new Error("ancestry unavailable");
        },
      ),
    ).toThrow("ancestry unavailable");
  });

  test("classifies only anchored operation-scoped detector output", () => {
    const key = "POST /audio:align";

    expect(
      classifyBreakingViolationOperationKey(
        "request POST /audio:align: property became required: language",
        [key],
      ),
    ).toBe(key);
    expect(
      classifyBreakingViolationOperationKey(
        "global detector diagnostic mentions POST /audio:align: for context",
        [key],
      ),
    ).toBeUndefined();
  });

  test("retires landed compatibility waivers from the active repository policy", async () => {
    const active = JSON.parse(
      await Bun.file(
        new URL("../packages/contracts/breaking-change-waivers.json", import.meta.url),
      ).text(),
    );
    expect(active).toEqual({ breakingChangeWaivers: [] });
  });

  test("preserves the historical Megapot pool Base chain declarations", async () => {
    const repositoryPolicy = JSON.parse(
      await Bun.file(
        new URL("./fixtures/openapi-safe-base-chain-waivers-20261023.json", import.meta.url),
      ).text(),
    ) as BreakingChangePolicy;
    const unchanged = document([], []);
    const baselineSha = "d85f3210427109c2a38a7fea81b0ed4be72450ac";

    expect(
      repositoryPolicy.breakingChangeWaivers.map(({ operationId, baselineSha, kind }) => ({
        operationId,
        baselineSha,
        kind,
      })),
    ).toEqual(
      [
        "get_communitiesCommunityIdPostsPostIdRewardsMegapotPool",
        "get_rewardOfferLegsLegIdFundingFundingEffectId",
        "post_rewardOfferLegsLegIdFundingFundingEffectIdObservations",
        "post_rewardOffersOfferIdMegapotPoolLegs",
      ].map((operationId) => ({ operationId, baselineSha, kind: "deprecation" })),
    );
    for (const waiver of repositoryPolicy.breakingChangeWaivers) {
      for (const violation of waiver.expectedViolations) {
        expect(violation).toEndWith(".chain_id");
        expect(violation).toContain("enum value added: 8453 at ");
      }
    }
    expect(() =>
      assertNoObsoleteBreakingChangeWaivers(repositoryPolicy, baselineSha, () => true),
    ).not.toThrow();
    expect(() =>
      assertNoObsoleteBreakingChangeWaivers(repositoryPolicy, OTHER_BASELINE_SHA, () => true),
    ).toThrow("obsolete baseline");
    expect(
      filterAllowedBreakingChanges(unchanged, unchanged, repositoryPolicy, BASELINE_SHA),
    ).toEqual([]);
  });

  test("admits only the exact reviewed diff and still reports an unrelated break", () => {
    const oldDocument = document(
      ["gate_unsatisfied", "membership_required"],
      ["old_error", "keep"],
    );
    const newDocument = document(["membership_required"], ["keep"]);

    expect(
      filterAllowedBreakingChanges(
        oldDocument,
        newDocument,
        policy([POST_GATE_VIOLATION]),
        BASELINE_SHA,
      ),
    ).toEqual(["error code removed on GET /unrelated status 400: old_error"]);
  });

  test("does not apply a waiver to another baseline", () => {
    const oldDocument = document(["gate_unsatisfied"], []);
    const newDocument = document([], []);

    expect(
      filterAllowedBreakingChanges(
        oldDocument,
        newDocument,
        policy([POST_GATE_VIOLATION]),
        OTHER_BASELINE_SHA,
      ),
    ).toEqual([POST_GATE_VIOLATION]);
  });

  test("fails when an expected violation is missing", () => {
    const unchanged = document(["gate_unsatisfied"], []);

    expect(() =>
      filterAllowedBreakingChanges(
        unchanged,
        unchanged,
        policy([POST_GATE_VIOLATION]),
        BASELINE_SHA,
      ),
    ).toThrow("Missing expected violations");
  });

  test("fails when an additional violation appears", () => {
    const oldDocument = document(["gate_unsatisfied", "membership_required"], []);
    const newDocument = document([], []);

    expect(() =>
      filterAllowedBreakingChanges(
        oldDocument,
        newDocument,
        policy([POST_GATE_VIOLATION]),
        BASELINE_SHA,
      ),
    ).toThrow(
      "Unexpected violations:\n  - error code removed on POST /communities/{communityId}/posts status 403: membership_required",
    );
  });

  test("compares the expected violation set independently of order", () => {
    const oldDocument = document(["gate_unsatisfied", "membership_required"], []);
    const newDocument = document([], []);

    expect(
      filterAllowedBreakingChanges(
        oldDocument,
        newDocument,
        policy([
          "error code removed on POST /communities/{communityId}/posts status 403: membership_required",
          POST_GATE_VIOLATION,
        ]),
        BASELINE_SHA,
      ),
    ).toEqual([]);
  });

  test("fails when the expected violation changes", () => {
    const oldDocument = document(["gate_unsatisfied"], []);
    const newDocument = document([], []);
    const run = () =>
      filterAllowedBreakingChanges(
        oldDocument,
        newDocument,
        policy([
          "error code removed on POST /communities/{communityId}/posts status 403: membership_required",
        ]),
        BASELINE_SHA,
      );

    expect(run).toThrow("Missing expected violations");
    expect(run).toThrow(`Unexpected violations:\n  - ${POST_GATE_VIOLATION}`);
  });

  test("admits a required request body only for its named clean-break operation", () => {
    const oldDocument: OpenApiDocument = {
      openapi: "3.1.0",
      info: { title: "test", version: "1" },
      paths: {
        "/posts/{postId}/clear_vote": {
          post: {
            operationId: "post_postsPostIdClearVote",
            requestBody: { required: false, content: { "application/json": { schema: {} } } },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const newDocument: OpenApiDocument = {
      ...oldDocument,
      paths: {
        "/posts/{postId}/clear_vote": {
          post: {
            ...oldDocument.paths["/posts/{postId}/clear_vote"]?.post,
            requestBody: { required: true, content: { "application/json": { schema: {} } } },
          },
        },
      },
    };

    expect(
      filterAllowedBreakingChanges(
        oldDocument,
        newDocument,
        policy(
          ["request body became required on POST /posts/{postId}/clear_vote"],
          "post_postsPostIdClearVote",
        ),
        BASELINE_SHA,
      ),
    ).toEqual([]);
    expect(
      filterAllowedBreakingChanges(
        oldDocument,
        newDocument,
        { breakingChangeWaivers: [] },
        BASELINE_SHA,
      ),
    ).toEqual(["request body became required on POST /posts/{postId}/clear_vote"]);
  });

  test("rejects duplicate operation waivers", () => {
    const waivers = policy([POST_GATE_VIOLATION]).breakingChangeWaivers;
    const oldDocument = document(["gate_unsatisfied"], []);
    const newDocument = document([], []);

    expect(() =>
      filterAllowedBreakingChanges(
        oldDocument,
        newDocument,
        { breakingChangeWaivers: [...waivers, ...waivers] },
        BASELINE_SHA,
      ),
    ).toThrow(`Duplicate breaking-change waiver for operation ${POST_OPERATION}`);
  });

  test("rejects the legacy operation-wide policy", () => {
    const legacyPolicy = {
      breakingChangeWaivers: [],
      cleanBreakOperations: [{ operationId: POST_OPERATION, reason: "legacy" }],
    } as unknown as BreakingChangePolicy;

    expect(() =>
      filterAllowedBreakingChanges(
        document(["gate_unsatisfied"], []),
        document([], []),
        legacyPolicy,
        BASELINE_SHA,
      ),
    ).toThrow("Legacy operation-wide breaking-change allowances are forbidden");
  });
});
