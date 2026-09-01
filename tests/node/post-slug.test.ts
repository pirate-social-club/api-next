import { isSlug, slugify } from "cizgile";
import { allScripts } from "cizgile/transliterate";
import { describe, expect, test } from "vitest";
import { createPostSlugCandidate } from "../../packages/application/src/post-slug.ts";
import { postSlugV1GoldenFixtures } from "../fixtures/post-slug-v1.ts";

describe("post-slug-v1 under Node", () => {
  for (const fixture of postSlugV1GoldenFixtures) {
    test(fixture.name, () => {
      expect(
        createPostSlugCandidate({
          source: fixture.source,
          postType: fixture.postType,
          ...("locale" in fixture ? { locale: fixture.locale } : {}),
        }),
      ).toEqual(fixture.expected);
    });
  }

  test("pins the nested allScripts corruption", () => {
    const wronglyNested = [allScripts] as unknown as typeof allScripts;
    expect(slugify("1234", { transliterate: wronglyNested })).toBe(
      "object-object-object-object-object-object-object-object",
    );
    expect(slugify("Ünïcödé ﬁnal ①", { transliterate: wronglyNested })).toBe(
      "unicode-final-object-object",
    );
  });

  test("pins the bidi encode defect", () => {
    const encoded = slugify("مرحبا 123", {
      unicode: true,
      bidi: "encode",
      maxLength: 10,
    });
    expect(encoded.length).toBeGreaterThan(10);
    expect(isSlug(encoded, { unicode: true, bidi: "encode" })).toBe(false);
    expect(slugify(encoded, { unicode: true, bidi: "encode" })).not.toBe(encoded);
  });
});
