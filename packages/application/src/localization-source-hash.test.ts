import { describe, expect, test } from "bun:test";
import {
  type LocalizationSourceHashInputV1,
  localizationSourceHashV1,
} from "./localization-source-hash";

const source: LocalizationSourceHashInputV1 = {
  sourceUnitKind: "post",
  sourceUnitId: "post_1",
  fieldKey: "body",
  sourceRevision: 1,
  canonicalValue: "Same visible text",
};

describe("localization source hash v1", () => {
  test("freezes the domain-separated canonical digest", async () => {
    expect(await localizationSourceHashV1(source)).toBe(
      "7ea81121e8575417ea2307b98d9a1bc9cc3018e7817a22f3f17646c2c19a568a",
    );
  });

  test.each([
    ["unit kind", { sourceUnitKind: "comment" as const }],
    ["unit id", { sourceUnitId: "post_2" }],
    ["field", { fieldKey: "title" }],
    ["revision", { sourceRevision: 2 }],
    ["canonical value", { canonicalValue: "Same visible text." }],
  ] as const)("changes when %s changes", async (_label, change) => {
    const [original, changed] = await Promise.all([
      localizationSourceHashV1(source),
      localizationSourceHashV1({ ...source, ...change }),
    ]);
    expect(changed).not.toBe(original);
  });

  test("does not loosely normalize display text", async () => {
    const [original, trailingSpace, composed, decomposed] = await Promise.all([
      localizationSourceHashV1(source),
      localizationSourceHashV1({ ...source, canonicalValue: `${source.canonicalValue} ` }),
      localizationSourceHashV1({ ...source, canonicalValue: "Café" }),
      localizationSourceHashV1({ ...source, canonicalValue: "Cafe\u0301" }),
    ]);
    expect(new Set([original, trailingSpace, composed, decomposed]).size).toBe(4);
  });
});
