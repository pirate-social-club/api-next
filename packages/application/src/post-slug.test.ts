import { describe, expect, test } from "bun:test";
import { isSlug, slugify } from "cizgile";
import { allScripts } from "cizgile/transliterate";
import { postSlugV1GoldenFixtures } from "../../../tests/fixtures/post-slug-v1.ts";
import { createPostSlugCandidate } from "./post-slug.ts";

describe("post-slug-v1 golden corpus", () => {
  for (const fixture of postSlugV1GoldenFixtures) {
    test(fixture.name, () => {
      const result = createPostSlugCandidate({
        source: fixture.source,
        postType: fixture.postType,
        ...("locale" in fixture ? { locale: fixture.locale } : {}),
      });

      expect(result).toEqual(fixture.expected);
      if (result.kind === "descriptive") {
        expect(result.slug.length).toBeLessThanOrEqual(80);
      }
    });
  }
});

describe("cizgile 0.1.1 regression boundaries", () => {
  test("allScripts is passed directly rather than nested", () => {
    const wronglyNested = [allScripts] as unknown as typeof allScripts;

    expect(slugify("1234", { transliterate: wronglyNested })).toBe(
      "object-object-object-object-object-object-object-object",
    );
    expect(slugify("Ünïcödé ﬁnal ①", { transliterate: wronglyNested })).toBe(
      "unicode-final-object-object",
    );

    expect(slugify("1234", { transliterate: allScripts })).toBe("1234");
    expect(slugify("Ünïcödé ﬁnal ①", { transliterate: allScripts })).toBe("unicode-final-1");
  });

  test("bidi encode is not a logical-slug operation", () => {
    const encoded = slugify("مرحبا 123", {
      unicode: true,
      bidi: "encode",
      maxLength: 10,
    });

    expect(encoded).toBe("%D9%85%D8%B1%D8%AD%D8%A8%D8%A7-123");
    expect(encoded.length).toBeGreaterThan(10);
    expect(isSlug(encoded, { unicode: true, bidi: "encode" })).toBe(false);
    expect(slugify(encoded, { unicode: true, bidi: "encode" })).toBe(
      "d9-85-d8-b1-d8-ad-d8-a8-d8-a7-123",
    );
  });

  test("the wrapper keeps bidi-safe Unicode logical and unencoded", () => {
    const result = createPostSlugCandidate({
      source: "שלום 123",
      postType: "text",
    });

    expect(result).toEqual({
      kind: "descriptive",
      branch: "unicode",
      slug: "שלום-123",
    });
    if (result.kind === "descriptive") {
      expect(result.slug).not.toContain("%");
    }
  });
});
