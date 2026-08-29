import { describe, expect, test } from "bun:test";
import { tokenizeKaraokeText } from "../scoring";

const STRAIGHT = "'";
const CURLY = "’";

describe("g-drop normalization", () => {
  test("expands in' to ing before whitespace and at end of input", () => {
    expect(tokenizeKaraokeText(`lovin${STRAIGHT} you`)).toEqual(["loving", "you"]);
    expect(tokenizeKaraokeText(`lovin${STRAIGHT}`)).toEqual(["loving"]);
    expect(tokenizeKaraokeText(`lovin${CURLY} you`)).toEqual(["loving", "you"]);
    expect(tokenizeKaraokeText(`lovin${CURLY}`)).toEqual(["loving"]);
  });

  test("expands in' to ing before trailing punctuation", () => {
    expect(tokenizeKaraokeText(`lovin${STRAIGHT}, you`)).toEqual(["loving", "you"]);
    expect(tokenizeKaraokeText(`lovin${STRAIGHT}.`)).toEqual(["loving"]);
    expect(tokenizeKaraokeText(`lovin${CURLY}, you`)).toEqual(["loving", "you"]);
    expect(tokenizeKaraokeText(`lovin${CURLY}.`)).toEqual(["loving"]);
    expect(tokenizeKaraokeText(`mornin${STRAIGHT},`)).toEqual(["morning"]);
    expect(tokenizeKaraokeText(`feelin${CURLY}!`)).toEqual(["feeling"]);
    expect(tokenizeKaraokeText(`walkin${CURLY}…`)).toEqual(["walking"]);
  });

  test("expands g-dropped words across a punctuated line", () => {
    expect(tokenizeKaraokeText(`somethin${STRAIGHT} right,`)).toEqual(["something", "right"]);
    expect(tokenizeKaraokeText(`savin${STRAIGHT} me, lovin${CURLY} you.`)).toEqual([
      "saving",
      "me",
      "loving",
      "you",
    ]);
  });

  test("leaves short stems and apostrophe-less words untouched", () => {
    expect(tokenizeKaraokeText(`in${STRAIGHT},`)).toEqual(["in"]);
    expect(tokenizeKaraokeText(`pin${STRAIGHT} drop`)).toEqual(["pin", "drop"]);
    expect(tokenizeKaraokeText("lovin you")).toEqual(["lovin", "you"]);
    // Known boundary: the {3,}-letter stem guard excludes two-letter stems, so
    // goin'/doin' never expand. Widening it needs false-positive analysis first
    // (ruin'→"ruing", and basin'→"basing" already expands on main).
    expect(tokenizeKaraokeText(`goin${STRAIGHT},`)).toEqual(["goin"]);
  });

  test("keeps existing contraction and slang expansions intact", () => {
    expect(tokenizeKaraokeText(`won${STRAIGHT}t,`)).toEqual(["will", "not"]);
    expect(tokenizeKaraokeText(`it${CURLY}s gone`)).toEqual(["it", "is", "gone"]);
    expect(tokenizeKaraokeText("gonna stay")).toEqual(["going", "to", "stay"]);
  });
});
