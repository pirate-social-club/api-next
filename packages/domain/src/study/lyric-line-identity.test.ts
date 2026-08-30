import { describe, expect, test } from "bun:test";
import {
  acceptedLyricLines,
  evaluateStudyUnitSayItBackEligibilityV1,
  isStandaloneLyricMetadataLine,
  normalizeLyricLineIdentityV1,
  type PriorLyricOccurrence,
  reconcileLyricLineIdentities,
} from "./lyric-line-identity.ts";

describe("lyric line identity normalization v1", () => {
  test("freezes Unicode, apostrophe, case, punctuation, symbol, and whitespace behavior", () => {
    expect(normalizeLyricLineIdentityV1("  ＨＥＬＬＯ—Don’t  Go! 🎵 ")).toBe("hello don t go");
  });

  test("makes repeated equivalent chorus text share a normalization", () => {
    expect(normalizeLyricLineIdentityV1("Hold on…")).toBe(normalizeLyricLineIdentityV1("HOLD ON"));
  });

  test("excludes complete structural metadata without rewriting inline annotations", () => {
    expect(
      acceptedLyricLines(
        ' [Verse 1] \r\nVerse one\n[Bridge – Beat Drops]\nSing it [vocal growl]\n[vocal echo: "Echo..."]\nVerse one',
      ),
    ).toEqual(["Verse one", "Sing it [vocal growl]", "Verse one"]);
    expect(isStandaloneLyricMetadataLine(" [Instrumental] ")).toBe(true);
    expect(isStandaloneLyricMetadataLine("Sing it [vocal growl]")).toBe(false);
  });

  test("keeps ordinary lyric units eligible and declines only extreme spoken recall", () => {
    expect(evaluateStudyUnitSayItBackEligibilityV1("what if i lost you")).toMatchObject({
      eligibility: "eligible",
      reason: null,
      tokenCount: 5,
    });
    expect(
      evaluateStudyUnitSayItBackEligibilityV1(
        Array.from({ length: 33 }, (_, index) => `word${index + 1}`).join(" "),
      ),
    ).toMatchObject({
      eligibility: "ineligible",
      reason: "spoken_recall_too_long",
      tokenCount: 33,
    });
    expect(evaluateStudyUnitSayItBackEligibilityV1("字".repeat(513))).toMatchObject({
      characterCount: 513,
      eligibility: "ineligible",
      reason: "spoken_recall_too_long",
      tokenCount: 1,
    });
  });

  test("carries only conservative in-order matches and shares repeated Study units", () => {
    let lineSequence = 0;
    let unitSequence = 0;
    const first = reconcileLyricLineIdentities({
      lyrics: "Verse\nHold on!\nHold on!",
      previous: [],
      nextLineId: () => `line-${++lineSequence}`,
      nextStudyUnitId: () => `unit-${++unitSequence}`,
    });
    expect(first.lines.map(({ lineId, studyUnitId }) => ({ lineId, studyUnitId }))).toEqual([
      { lineId: "line-1", studyUnitId: "unit-1" },
      { lineId: "line-2", studyUnitId: "unit-2" },
      { lineId: "line-3", studyUnitId: "unit-2" },
    ]);

    const prior = first.lines.map(
      (line): PriorLyricOccurrence => ({
        ...line,
        sourceHash: `hash-${line.ordinal}`,
      }),
    );
    const corrected = reconcileLyricLineIdentities({
      lyrics: "Intro\nVerse\nHold on…\nHold on!",
      previous: prior,
      nextLineId: () => `line-${++lineSequence}`,
      nextStudyUnitId: () => `unit-${++unitSequence}`,
    });
    expect(
      corrected.lines.map(({ lineId, lineVersion, studyUnitId }) => ({
        lineId,
        lineVersion,
        studyUnitId,
      })),
    ).toEqual([
      { lineId: "line-4", lineVersion: 1, studyUnitId: "unit-3" },
      { lineId: "line-1", lineVersion: 1, studyUnitId: "unit-1" },
      { lineId: "line-2", lineVersion: 2, studyUnitId: "unit-2" },
      { lineId: "line-3", lineVersion: 1, studyUnitId: "unit-2" },
    ]);
    expect(corrected.retired).toEqual([]);
  });

  test("fails closed for normalized edits and duplicate insertion ambiguity", () => {
    const previous = ["Alpha", "Beta", "Echo", "Echo"].map(
      (canonicalText, index): PriorLyricOccurrence => ({
        canonicalText,
        lineId: `old-${index + 1}`,
        lineVersion: 1,
        normalizedText: normalizeLyricLineIdentityV1(canonicalText),
        ordinal: index + 1,
        sourceHash: `hash-${index + 1}`,
        studyUnitId: `unit-${canonicalText.toLowerCase()}`,
      }),
    );
    let lineSequence = 0;
    let unitSequence = 0;
    const result = reconcileLyricLineIdentities({
      lyrics: "Beta\nAlpha changed\nEcho\nEcho\nEcho",
      previous,
      nextLineId: () => `new-${++lineSequence}`,
      nextStudyUnitId: () => `new-unit-${++unitSequence}`,
    });
    expect(result.lines.filter(({ carried }) => carried).map(({ lineId }) => lineId)).toEqual([
      "old-2",
    ]);
    expect(result.retired.map(({ lineId }) => lineId)).toEqual(["old-1", "old-3", "old-4"]);
    expect(result.retired.filter(({ ambiguous }) => ambiguous).map(({ lineId }) => lineId)).toEqual(
      ["old-3", "old-4"],
    );
  });

  test("mints fresh identities when a pure reorder has two equally valid matches", () => {
    const previous = ["Alpha", "Beta"].map(
      (canonicalText, index): PriorLyricOccurrence => ({
        canonicalText,
        lineId: `old-${index + 1}`,
        lineVersion: 1,
        normalizedText: normalizeLyricLineIdentityV1(canonicalText),
        ordinal: index + 1,
        sourceHash: `hash-${index + 1}`,
        studyUnitId: `unit-${index + 1}`,
      }),
    );
    let sequence = 0;
    const result = reconcileLyricLineIdentities({
      lyrics: "Beta\nAlpha",
      previous,
      nextLineId: () => `new-${++sequence}`,
      nextStudyUnitId: () => `unused-${sequence}`,
    });
    expect(result.lines.every(({ carried }) => !carried)).toBe(true);
    expect(result.retired.every(({ ambiguous }) => ambiguous)).toBe(true);
  });

  test("does not transfer occurrence identity across line splits or merges", () => {
    const prior = (lines: readonly string[]): readonly PriorLyricOccurrence[] =>
      lines.map((canonicalText, index) => ({
        canonicalText,
        lineId: `old-${index + 1}`,
        lineVersion: 1,
        normalizedText: normalizeLyricLineIdentityV1(canonicalText),
        ordinal: index + 1,
        sourceHash: `hash-${index + 1}`,
        studyUnitId: `unit-${index + 1}`,
      }));
    let sequence = 0;
    const split = reconcileLyricLineIdentities({
      lyrics: "We run\nfast\nStay",
      previous: prior(["We run fast", "Stay"]),
      nextLineId: () => `split-${++sequence}`,
      nextStudyUnitId: () => `split-unit-${sequence}`,
    });
    expect(split.lines.map(({ carried, lineId }) => ({ carried, lineId }))).toEqual([
      { carried: false, lineId: "split-1" },
      { carried: false, lineId: "split-2" },
      { carried: true, lineId: "old-2" },
    ]);
    expect(split.retired.map(({ lineId }) => lineId)).toEqual(["old-1"]);

    sequence = 0;
    const merged = reconcileLyricLineIdentities({
      lyrics: "We run\nStay",
      previous: prior(["We", "run", "Stay"]),
      nextLineId: () => `merge-${++sequence}`,
      nextStudyUnitId: () => `merge-unit-${sequence}`,
    });
    expect(merged.lines.map(({ carried, lineId }) => ({ carried, lineId }))).toEqual([
      { carried: false, lineId: "merge-1" },
      { carried: true, lineId: "old-3" },
    ]);
    expect(merged.retired.map(({ lineId }) => lineId)).toEqual(["old-1", "old-2"]);
  });
});
