import { describe, expect, test } from "bun:test";
import { isSlug, slugify } from "cizgile";
import { allScripts } from "cizgile/transliterate";
import { postSlugV1GoldenFixtures } from "../../../tests/fixtures/post-slug-v1.ts";
import {
  createOpaquePostSlugCandidate,
  createPostSlugCandidate,
  postSlugCanonicalPath,
  postSlugCollisionCandidate,
  postSlugOpaqueToken,
  selectPostSlugSource,
} from "./post-slug.ts";

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

describe("post-slug-v1 allocation inputs", () => {
  test("selects opaque allocation without title input", () => {
    expect(createOpaquePostSlugCandidate("text")).toEqual({ kind: "opaque", prefix: "post" });
    expect(createOpaquePostSlugCandidate("song")).toEqual({ kind: "opaque", prefix: "song" });
  });

  test("selects the persisted title or first nonblank body line", () => {
    expect(selectPostSlugSource({ title: "  A title  ", body: "ignored" })).toBe("  A title  ");
    expect(selectPostSlugSource({ title: "  ", body: "\n  \r\nFirst body line\nSecond" })).toBe(
      "First body line",
    );
    expect(selectPostSlugSource({ title: null, body: null })).toBe("");
  });

  test("fits collision suffixes inside the logical maximum", () => {
    const base = "東".repeat(80);
    expect(postSlugCollisionCandidate(base, 1)).toBe(base);
    expect(postSlugCollisionCandidate(base, 2)).toBe(`${"東".repeat(78)}-2`);
    expect(postSlugCollisionCandidate(base, 100)).toBe(`${"東".repeat(76)}-100`);
  });

  test("maps ten bytes to the frozen Crockford alphabet", () => {
    expect(postSlugOpaqueToken(Uint8Array.from([0, 1, 8, 9, 10, 11, 16, 22, 30, 31]))).toBe(
      "0189abgpyz",
    );
    expect(() => postSlugOpaqueToken(new Uint8Array(9))).toThrow(RangeError);
  });

  test("serializes the logical slug with iriToUri only at the HTTP boundary", () => {
    expect(postSlugCanonicalPath("deja-vu")).toBe("/posts/deja-vu");
    expect(postSlugCanonicalPath("你好-world")).toBe("/posts/%E4%BD%A0%E5%A5%BD-world");
    expect(postSlugCanonicalPath("bad%2Fslug")).toBeNull();
  });
});
