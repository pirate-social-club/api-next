import { describe, expect, test } from "bun:test";
import type { OpenApiDocument } from "@pirate/contracts";
import { filterAllowedBreakingChanges, selectBaselineSha } from "./check-openapi-breaking.ts";

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
  test("admits the ratified CreatePost delta but still reports an unrelated break", () => {
    const oldDocument = document(
      ["gate_unsatisfied", "membership_required"],
      ["old_error", "keep"],
    );
    const newDocument = document(["membership_required"], ["keep"]);

    expect(
      filterAllowedBreakingChanges(oldDocument, newDocument, {
        deprecatedOperations: [],
        cleanBreakOperations: [
          {
            operationId: "post_communitiesCommunityIdPosts",
            reason: "ratified Order 4 text-post amendment",
          },
        ],
      }),
    ).toEqual(["error code removed on GET /unrelated status 400: old_error"]);
  });
});
