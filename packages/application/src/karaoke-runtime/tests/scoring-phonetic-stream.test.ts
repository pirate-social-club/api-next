import { describe, expect, test } from "bun:test";
import { phoneticStreamSimilarity, scoreKaraokeLineText } from "../scoring";

describe("phoneticStreamSimilarity", () => {
  test("scores fragmented tokens identically to merged tokens", () => {
    const result = phoneticStreamSimilarity(["shoo", "be", "doo"], ["shooby", "doo"]);
    expect(result.available).toBe(true);
    expect(result.distance).toBe(0);
    expect(result.similarity).toBe(1);
  });

  test("charges a small distance for a near-vowel substitution plus trailing consonant", () => {
    const result = phoneticStreamSimilarity(["said"], ["say"]);
    expect(result.available).toBe(true);
    expect(result.distance).toBeGreaterThan(0);
    expect(result.distance).toBeLessThanOrEqual(2);
    expect(result.similarity).toBeLessThan(1);
    expect(result.similarity).toBeGreaterThan(0);
  });

  test("derives -ied past-tense phones from the corresponding -y form", () => {
    for (const [base, past] of [
      ["try", "tried"],
      ["cry", "cried"],
      ["dry", "dried"],
      ["fry", "fried"],
      ["spy", "spied"],
      ["pry", "pried"],
      ["apply", "applied"],
      ["deny", "denied"],
      ["study", "studied"],
      ["carry", "carried"],
    ]) {
      const result = phoneticStreamSimilarity([base], [past]);
      expect(result.available).toBe(true);
      expect(result.distance).toBe(1);
    }
  });

  test("accepts the production compound tense near-miss within the study budget", () => {
    const result = phoneticStreamSimilarity(
      "they try to kiss me while they chase me around".split(" "),
      "they tried to kiss me while they chased me around".split(" "),
    );
    const budget = Math.max(2, Math.min(Math.floor(0.15 * result.length), 4));

    expect(result.available).toBe(true);
    expect(result.distance).toBe(3);
    expect(result.length).toBe(30);
    expect(result.distance).toBeLessThanOrEqual(budget);
  });

  test("pins the v5 karaoke score for the production compound tense near-miss", () => {
    const result = scoreKaraokeLineText({
      expected: "They try to kiss me while they chase me around",
      transcript: "They tried to kiss me while they chased me around",
    });

    expect(result.phoneticQuality).toBeCloseTo(0.8944416666666667, 12);
    expect(result.score).toBeCloseTo(0.8064675595238096, 12);
  });

  test("reports unavailable for non-Latin tokens", () => {
    expect(phoneticStreamSimilarity(["日本語"], ["日本語"]).available).toBe(false);
  });

  test("reports unavailable for empty token arrays without crashing", () => {
    const bothEmpty = phoneticStreamSimilarity([], []);
    expect(bothEmpty.available).toBe(false);
    expect(phoneticStreamSimilarity([], ["love"]).available).toBe(false);
    expect(phoneticStreamSimilarity(["love"], []).available).toBe(false);
  });

  test("scores a clearly different pair well below 1", () => {
    const result = phoneticStreamSimilarity(["love"], ["hate"]);
    expect(result.available).toBe(true);
    expect(result.similarity).toBeLessThan(0.5);
  });
});
