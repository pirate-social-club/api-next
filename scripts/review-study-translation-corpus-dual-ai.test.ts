import { describe, expect, test } from "bun:test";
import {
  blindedChoices,
  parseReviewJsonContent,
} from "./review-study-translation-corpus-dual-ai.ts";

describe("dual-AI Study translation review", () => {
  test("deterministically blinds and shuffles the intended answer", () => {
    const choices = blindedChoices("a".repeat(64), ["正确", "错误一", "错误二", "错误三"]);
    expect(choices).toEqual(blindedChoices("a".repeat(64), ["正确", "错误一", "错误二", "错误三"]));
    expect(choices.map(({ option_id }) => option_id).sort()).toEqual([
      "option_1",
      "option_2",
      "option_3",
      "option_4",
    ]);
    expect(choices.filter(({ is_intended }) => is_intended)).toHaveLength(1);
    expect(choices.find(({ is_intended }) => is_intended)?.text).toBe("正确");
  });

  test("rejects duplicate choices because they cannot support one defensible answer", () => {
    expect(() => blindedChoices("b".repeat(64), ["相同", "相同", "不同", "另一个"])).toThrow(
      "four distinct choices",
    );
  });

  test("accepts plain or provider-fenced JSON without accepting surrounding prose", () => {
    expect(parseReviewJsonContent('{"items":[]}')).toEqual({ items: [] });
    expect(parseReviewJsonContent('```json\n{"items":[]}\n```')).toEqual({ items: [] });
    expect(() => parseReviewJsonContent('result: {"items":[]}')).toThrow();
  });
});
