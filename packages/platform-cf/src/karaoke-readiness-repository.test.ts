import { describe, expect, test } from "bun:test";
import { buildKaraokePayloadLines } from "./karaoke-readiness-repository.ts";

const catalogLines = [
  { id: "line-1", index: 0, text: "Hold on" },
  { id: "line-2", index: 1, text: "날 잡아" },
];

describe("Karaoke readiness payload", () => {
  test("binds word timing to stable occurrence ids", () => {
    expect(
      buildKaraokePayloadLines({
        catalogLines,
        artifact: {
          version: "media-timed-lyrics-artifact-v1",
          mode: "word",
          segments: [
            { text: "Hold", start_ms: 0, end_ms: 300 },
            { text: "on", start_ms: 350, end_ms: 600 },
            { text: "날", start_ms: 700, end_ms: 900 },
            { text: "잡아", start_ms: 950, end_ms: 1200 },
          ],
        },
      }),
    ).toEqual([
      {
        id: "line-1",
        index: 0,
        kind: "lyric",
        text: "Hold on",
        start_ms: 0,
        end_ms: 600,
        words: [
          { text: "Hold", start_ms: 0, end_ms: 300 },
          { text: "on", start_ms: 350, end_ms: 600 },
        ],
      },
      {
        id: "line-2",
        index: 1,
        kind: "lyric",
        text: "날 잡아",
        start_ms: 700,
        end_ms: 1200,
        words: [
          { text: "날", start_ms: 700, end_ms: 900 },
          { text: "잡아", start_ms: 950, end_ms: 1200 },
        ],
      },
    ]);
  });

  test("groups character timing and rejects stale or incomplete text", () => {
    const artifact = {
      version: "media-timed-lyrics-artifact-v1",
      mode: "character",
      segments: [
        { text: "H", start_ms: 0, end_ms: 50 },
        { text: "o", start_ms: 50, end_ms: 100 },
        { text: "l", start_ms: 100, end_ms: 150 },
        { text: "d", start_ms: 150, end_ms: 200 },
        { text: " ", start_ms: 200, end_ms: 250 },
        { text: "on", start_ms: 250, end_ms: 400 },
        { text: "\n", start_ms: 400, end_ms: 450 },
        { text: "날", start_ms: 450, end_ms: 600 },
        { text: " ", start_ms: 600, end_ms: 650 },
        { text: "잡아", start_ms: 650, end_ms: 900 },
      ],
    };
    expect(buildKaraokePayloadLines({ catalogLines, artifact })?.[0]?.words).toEqual([
      { text: "Hold", start_ms: 0, end_ms: 200 },
      { text: "on", start_ms: 250, end_ms: 400 },
    ]);
    expect(
      buildKaraokePayloadLines({
        catalogLines,
        artifact: {
          ...artifact,
          segments: artifact.segments.slice(0, -1),
        },
      }),
    ).toBeNull();
  });

  test("keeps occurrence ids across realignment and rejects stale lyric text", () => {
    const align = (offset: number, lastWord = "잡아") =>
      buildKaraokePayloadLines({
        catalogLines,
        artifact: {
          version: "media-timed-lyrics-artifact-v1",
          mode: "word",
          segments: [
            { text: "Hold", start_ms: offset, end_ms: offset + 300 },
            { text: "on", start_ms: offset + 350, end_ms: offset + 600 },
            { text: "날", start_ms: offset + 700, end_ms: offset + 900 },
            { text: lastWord, start_ms: offset + 950, end_ms: offset + 1_200 },
          ],
        },
      });
    expect(align(0)?.map(({ id }) => id)).toEqual(["line-1", "line-2"]);
    expect(align(5_000)?.map(({ id }) => id)).toEqual(["line-1", "line-2"]);
    expect(align(0, "놓아")).toBeNull();
  });

  test("skips artifact words for metadata lines the catalog excluded", () => {
    const rawLyrics = "[Verse 1]\nHold on\n(oh yeah)\n[Chorus]\n(Instrumental)\n날 잡아\n";
    const lines = buildKaraokePayloadLines({
      rawLyrics,
      catalogLines: [
        { id: "line-1", index: 0, text: "Hold on" },
        { id: "line-2", index: 1, text: "(oh yeah)" },
        { id: "line-3", index: 2, text: "날 잡아" },
      ],
      artifact: {
        version: "media-timed-lyrics-artifact-v1",
        mode: "word",
        segments: [
          { text: "[Verse", start_ms: 0, end_ms: 100 },
          { text: "1]", start_ms: 100, end_ms: 200 },
          { text: "Hold", start_ms: 200, end_ms: 500 },
          { text: "on", start_ms: 550, end_ms: 800 },
          { text: "(oh", start_ms: 850, end_ms: 1_000 },
          { text: "yeah)", start_ms: 1_050, end_ms: 1_300 },
          { text: "[Chorus]", start_ms: 1_400, end_ms: 1_600 },
          { text: "(Instrumental)", start_ms: 1_700, end_ms: 2_500 },
          { text: "날", start_ms: 2_600, end_ms: 2_800 },
          { text: "잡아", start_ms: 2_850, end_ms: 3_100 },
        ],
      },
    });
    expect(lines?.map(({ id }) => id)).toEqual(["line-1", "line-2", "line-3"]);
    expect(lines?.[0]?.start_ms).toBe(200);
    expect(lines?.[1]?.text).toBe("(oh yeah)");
    expect(lines?.[1]?.words.map(({ text }) => text)).toEqual(["(oh", "yeah)"]);
    expect(lines?.[2]?.words.map(({ text }) => text)).toEqual(["날", "잡아"]);
  });

  test("fails closed when metadata words are missing from the artifact", () => {
    expect(
      buildKaraokePayloadLines({
        rawLyrics: "[Intro]\nHold on\n날 잡아\n",
        catalogLines,
        artifact: {
          version: "media-timed-lyrics-artifact-v1",
          mode: "word",
          segments: [
            { text: "Hold", start_ms: 0, end_ms: 300 },
            { text: "on", start_ms: 350, end_ms: 600 },
            { text: "날", start_ms: 700, end_ms: 900 },
            { text: "잡아", start_ms: 950, end_ms: 1_200 },
          ],
        },
      }),
    ).toBeNull();
  });

  test("fails closed when a raw lyric line is absent from the catalog", () => {
    expect(
      buildKaraokePayloadLines({
        rawLyrics: "Hold on\nA line the catalog never accepted\n날 잡아\n",
        catalogLines,
        artifact: {
          version: "media-timed-lyrics-artifact-v1",
          mode: "word",
          segments: [
            { text: "Hold", start_ms: 0, end_ms: 300 },
            { text: "on", start_ms: 350, end_ms: 600 },
            { text: "A", start_ms: 650, end_ms: 700 },
            { text: "line", start_ms: 720, end_ms: 800 },
            { text: "the", start_ms: 820, end_ms: 860 },
            { text: "catalog", start_ms: 880, end_ms: 1_000 },
            { text: "never", start_ms: 1_020, end_ms: 1_100 },
            { text: "accepted", start_ms: 1_120, end_ms: 1_260 },
            { text: "날", start_ms: 1_300, end_ms: 1_500 },
            { text: "잡아", start_ms: 1_550, end_ms: 1_800 },
          ],
        },
      }),
    ).toBeNull();
  });
});
