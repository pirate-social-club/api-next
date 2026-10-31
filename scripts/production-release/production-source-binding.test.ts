import { expect, test } from "bun:test";
import {
  publishedTip,
  TOOLING_RELEASE_REF,
  type ToolingPublicationSnapshot,
  validateToolingPublication,
} from "./production-source-binding.ts";

const source = "a".repeat(40);
const main = "b".repeat(40);
function witness(): ToolingPublicationSnapshot {
  return {
    source, main, source_is_ancestor: false, application_is_ancestor: true,
    release_ref: TOOLING_RELEASE_REF, release_tip: source,
    objects: {
      "scripts/production-release": { source_oid: "c".repeat(40), main_oid: "c".repeat(40), source_type: "tree", main_type: "tree" },
      "scripts/production-compatibility": { source_oid: "d".repeat(40), main_oid: "d".repeat(40), source_type: "tree", main_type: "tree" },
      "tsconfig.scripts.json": { source_oid: "e".repeat(40), main_oid: "e".repeat(40), source_type: "blob", main_type: "blob" },
    },
  };
}

test("ordinary ancestry and exact squash publication content are accepted separately", () => {
  validateToolingPublication({ source, main, source_is_ancestor: true, application_is_ancestor: true });
  validateToolingPublication(witness());
});

test("fallback requires M and the exact fixed published release tip", () => {
  for (const change of [
    { application_is_ancestor: false },
    { release_ref: "refs/heads/main" }, { release_tip: main },
    { source: "not-a-source" }, { main: "not-a-source" },
  ]) expect(() => validateToolingPublication({ ...witness(), ...change })).toThrow();
  for (const field of ["release_ref", "release_tip"] as const) {
    const value = witness(); delete value[field];
    expect(() => validateToolingPublication(value)).toThrow();
  }
});

test("every full subtree and tsconfig object must exist with exact type and identity", () => {
  for (const path of Object.keys(witness().objects!)) {
    for (const side of ["source_oid", "main_oid", "source_type", "main_type"] as const) {
      const value = witness();
      value.objects![path]![side] = side.endsWith("oid") ? "f".repeat(40) : "commit";
      expect(() => validateToolingPublication(value)).toThrow();
    }
    const missing = witness(); delete missing.objects![path];
    expect(() => validateToolingPublication(missing)).toThrow();
  }
  const extra = witness(); extra.objects!["scripts/unreviewed"] = extra.objects!["scripts/production-release"]!;
  expect(() => validateToolingPublication(extra)).toThrow();
  const absent = witness(); delete absent.objects;
  expect(() => validateToolingPublication(absent)).toThrow();
});

test("remote branch parsing refuses absent, duplicate, wrong-ref and malformed advertisements", () => {
  expect(publishedTip(source + "\t" + TOOLING_RELEASE_REF + "\n", TOOLING_RELEASE_REF)).toBe(source);
  for (const output of ["", source, source + "\trefs/heads/main", "invalid\t" + TOOLING_RELEASE_REF,
    source + "\t" + TOOLING_RELEASE_REF + "\n" + source + "\t" + TOOLING_RELEASE_REF]) {
    expect(() => publishedTip(output, TOOLING_RELEASE_REF)).toThrow();
  }
});
