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
});
