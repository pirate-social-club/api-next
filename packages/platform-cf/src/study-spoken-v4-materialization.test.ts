import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  acceptedSpokenV4Insert,
  spokenV4ContentRevision,
} from "./study-spoken-v4-materialization.ts";

const canonicalText = "A source line for study";
const sourceHash = createHash("sha256").update(canonicalText).digest("hex");

describe("immutable spoken v4 source", () => {
  test("uses a later content revision and exact v4 policy", () => {
    const insert = acceptedSpokenV4Insert({
      communityId: "community-test",
      postId: "post-test",
      audioRevision: 1,
      lyricsRevision: 3,
      lineId: "line-test",
      lineVersion: 1,
      canonicalText,
      sourceHash,
      studyUnitId: "unit-test",
    });
    expect(insert.values.at(-1)).toBe(100000304);
    expect(spokenV4ContentRevision(1, 3)).toBeGreaterThan(100000303);
    expect(insert.text).toContain("script_aware_token_phonetic_v4");
    expect(insert.text).toContain("ON CONFLICT (exercise_review_key, content_revision) DO NOTHING");
  });

  test("rejects a source text/hash mismatch", () => {
    expect(() =>
      acceptedSpokenV4Insert({
        communityId: "community-test",
        postId: "post-test",
        audioRevision: 1,
        lyricsRevision: 3,
        lineId: "line-test",
        lineVersion: 1,
        canonicalText: "tampered",
        sourceHash,
        studyUnitId: "unit-test",
      }),
    ).toThrow("spoken source hash mismatch");
  });
});
