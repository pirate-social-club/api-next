import { describe, expect, test } from "bun:test";
import type { OpenApiDocument } from "@pirate/contracts";
import {
  type BreakingChangePolicy,
  classifyBreakingViolationOperationKey,
  filterAllowedBreakingChanges,
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

describe("OpenAPI clean-break allowance", () => {
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

  test("keeps the repository policy free of historical operation-wide allowances", async () => {
    const repositoryPolicy = JSON.parse(
      await Bun.file(
        new URL("../packages/contracts/breaking-change-waivers.json", import.meta.url),
      ).text(),
    ) as BreakingChangePolicy;
    const unchanged = document([], []);

    expect(repositoryPolicy.breakingChangeWaivers).toEqual([]);
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
