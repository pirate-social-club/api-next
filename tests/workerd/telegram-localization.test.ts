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

test("the study-first age question renders in every interface language in Workers", () => {
  expect(telegramText("en", "ageYes")).toBe("I'm 16 or older");
  expect(telegramText("ru", "ageQuestion")).toContain("16");
  expect(telegramText("ka", "ageQuestion")).toContain("16");
  for (const locale of ["en", "ru", "ka"] as const)
    expect(
      telegramText(locale, "card", {
        prefix: telegramText(locale, "practiceOnly"),
        identity: "",
        total: 10,
        required: 7,
        resolved: 0,
        correct: 0,
        line: "Hold on",
      }),
    ).toContain("Hold on");
});
