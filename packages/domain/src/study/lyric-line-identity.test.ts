import { describe, expect, test } from "bun:test";
import {
  acceptedLyricLines,
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

  test("parses every nonblank accepted occurrence without deduplicating choruses", () => {
    expect(acceptedLyricLines(" Verse one \r\n\r\nChorus\n Chorus ")).toEqual([
      "Verse one",
      "Chorus",
      "Chorus",
    ]);
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
});
