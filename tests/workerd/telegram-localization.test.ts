import { telegramHelperLanguageName } from "@pirate/application/telegram";
import { expect, test } from "vitest";

test("owned helper-language names render in Russian and Georgian in Workers", () => {
  expect(telegramHelperLanguageName("ru", "zh-Hans").toLowerCase()).toContain("китай");
  expect(telegramHelperLanguageName("ka", "zh-Hans")).toContain("ჩინური");
});

test("Worker helper labels safely handle missing and unknown language tags", () => {
  expect(telegramHelperLanguageName("en", null)).toBe("Not selected");
  expect(telegramHelperLanguageName("ka", "malformed_tag")).toBe("malformed_tag");
});
