import { createPostSlugCandidate } from "@pirate/application/post-slug";
import { describe, expect, test } from "vitest";
import { postSlugV1GoldenFixtures } from "../fixtures/post-slug-v1.ts";

describe("post-slug-v1 in Workerd", () => {
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
});
