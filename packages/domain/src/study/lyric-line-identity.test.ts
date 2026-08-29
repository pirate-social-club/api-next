import { describe, expect, test } from "bun:test";
import { normalizeLyricLineIdentityV1 } from "./lyric-line-identity.ts";

describe("lyric line identity normalization v1", () => {
  test("freezes Unicode, apostrophe, case, punctuation, symbol, and whitespace behavior", () => {
    expect(normalizeLyricLineIdentityV1("  ＨＥＬＬＯ—Don’t  Go! 🎵 ")).toBe("hello don t go");
  });

  test("makes repeated equivalent chorus text share a normalization", () => {
    expect(normalizeLyricLineIdentityV1("Hold on…")).toBe(normalizeLyricLineIdentityV1("HOLD ON"));
  });
});
