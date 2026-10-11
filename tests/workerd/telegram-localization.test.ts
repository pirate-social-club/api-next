import { telegramHelperLanguageName, telegramText } from "@pirate/application/telegram";
import { expect, test } from "vitest";

test("owned helper-language names render in Russian and Georgian in Workers", () => {
  expect(telegramHelperLanguageName("ru", "zh-Hans").toLowerCase()).toContain("китай");
  expect(telegramHelperLanguageName("ka", "zh-Hans")).toContain("ჩინური");
});

test("Worker helper labels safely handle missing and unknown language tags", () => {
  expect(telegramHelperLanguageName("en", null)).toBe("Not selected");
  expect(telegramHelperLanguageName("ka", "malformed_tag")).toBe("malformed_tag");
});

test("the short practice prompt renders in every interface language in Workers", () => {
  expect(telegramText("en", "sayThis", { line: "Hold on" })).toBe("Say this back:\nHold on");
  for (const locale of ["en", "ru", "ka"] as const) {
    expect(telegramText(locale, "sayThis", { line: "Hold on" })).toMatch(/:\nHold on$/u);
    expect(telegramText(locale, "correct").length).toBeLessThan(16);
  }
});
