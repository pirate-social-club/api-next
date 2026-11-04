import { describe, expect, test } from "bun:test";
import { spokenV4ContentRevision } from "./study-spoken-v4-materialization.ts";

describe("immutable spoken v4 source", () => {
  test("uses the v4 content revision", () => {
    expect(spokenV4ContentRevision(1, 3)).toBe(100000304);
  });
});
