import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  decodeLanguageTagV1,
  LANGUAGE_MATCH_POLICY_V1,
  LanguageTagV1,
  resolveSupportedLanguageV1,
} from "./language.ts";

describe("canonical language contract", () => {
  test("accepts canonical language, script, region, and variant tags", () => {
    for (const tag of ["en", "en-US", "zh-Hant-TW", "sr-Latn", "de-CH", "sl-rozaj"]) {
      expect(Schema.is(LanguageTagV1)(tag)).toBe(true);
      expect(decodeLanguageTagV1(tag)).toBe(tag);
    }
  });

  test("rejects malformed, noncanonical, extension, and private-use values", () => {
    for (const tag of [
      "",
      "EN",
      "en_us",
      "english",
      "deu-CH",
      "iw",
      "zh-hant",
      "en-u-ca-gregory",
      "en-x-product-alias",
      "x-private",
    ]) {
      expect(Schema.is(LanguageTagV1)(tag)).toBe(false);
    }
  });

  test("matches exact tags and region fallback without discarding scripts", () => {
    const supported = ["en", "zh-Hans", "zh-Hant"] as const;

    expect(resolveSupportedLanguageV1("en-US", supported)).toBe("en");
    expect(resolveSupportedLanguageV1("zh-Hant", supported)).toBe("zh-Hant");
    expect(resolveSupportedLanguageV1("zh-Hant-TW", supported)).toBe("zh-Hant");
    expect(resolveSupportedLanguageV1("zh-Hans-TW", ["zh-Hant"])).toBeNull();
    expect(resolveSupportedLanguageV1("zh-TW", supported)).toBeNull();
    expect(LANGUAGE_MATCH_POLICY_V1).toBe("exact-script-region-fallback-v1");
  });
});
