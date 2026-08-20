import { describe, expect, test } from "bun:test";
import { canonicalJson } from "./canonical-json.ts";

describe("canonicalJson", () => {
  test("sorts object keys recursively without reordering arrays", () => {
    expect(canonicalJson({ z: [{ b: 2, a: 1 }], a: null })).toBe('{"a":null,"z":[{"a":1,"b":2}]}');
  });

  test("rejects values outside JSON instead of hashing an absent encoding", () => {
    expect(() => canonicalJson(undefined)).toThrow("canonical JSON input must be a JSON value");
  });
});
