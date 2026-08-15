import { describe, expect, test } from "bun:test";
import { selectBaselineSha } from "./check-openapi-breaking.ts";

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
