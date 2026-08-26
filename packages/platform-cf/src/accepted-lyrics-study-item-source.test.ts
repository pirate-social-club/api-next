import { describe, expect, test } from "bun:test";
import { buildAcceptedLyricsStudyItemSource } from "./accepted-lyrics-study-item-source.ts";

const request = {
  communityId: "community-1",
  postId: "post-1",
  audioRevision: 3,
  lyricsRevision: 2,
} as const;

describe("accepted lyrics Study item source", () => {
  test("builds a deterministic private grading snapshot from accepted lyric lines", () => {
    const first = buildAcceptedLyricsStudyItemSource({
      request,
      lyricsText: "Sail away tonight\nUnder a paper moon!\nSail away tonight",
    });
    const second = buildAcceptedLyricsStudyItemSource({
      request,
      lyricsText: "Sail away tonight\nUnder a paper moon!\nSail away tonight",
    });

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      version: "study_item_source_v1",
      song_revision: {
        community_id: "community-1",
        post_id: "post-1",
        audio_revision: 3,
        lyrics_revision: 2,
      },
      source_revision: 2,
      provenance: {
        kind: "accepted_song_lyrics",
        producer_id: "accepted-lyrics-cloze",
        producer_revision: "accepted-lyrics-cloze-v1",
      },
      items: [
        {
          source_item_key: "line-01",
          prompt: { kind: "text_response", text: "Complete the accepted lyric: Sail away ____" },
          answer_key: { accepted_answers: ["tonight"] },
        },
        {
          source_item_key: "line-02",
          prompt: {
            kind: "text_response",
            text: "Complete the accepted lyric: Under a paper ____",
          },
          answer_key: { accepted_answers: ["moon!", "moon"] },
        },
      ],
    });
  });

  test("accepts a one-word line without inventing an answer", () => {
    expect(buildAcceptedLyricsStudyItemSource({ request, lyricsText: "Tonight" })).toMatchObject({
      items: [
        {
          prompt: { text: "Enter the missing accepted lyric word: ____" },
          answer_key: { accepted_answers: ["Tonight"] },
        },
      ],
    });
  });

  test("fails closed when accepted lyrics cannot yield a bounded item", () => {
    expect(buildAcceptedLyricsStudyItemSource({ request, lyricsText: " \n\t " })).toBeNull();
    expect(
      buildAcceptedLyricsStudyItemSource({
        request,
        lyricsText: `${"a".repeat(4_097)} answer`,
      }),
    ).toBeNull();
  });

  test("caps the immutable source snapshot at the contract maximum", () => {
    const source = buildAcceptedLyricsStudyItemSource({
      request,
      lyricsText: Array.from({ length: 80 }, (_, index) => `line ${index} answer`).join("\n"),
    });
    expect(source?.items).toHaveLength(64);
    expect(source?.items.at(-1)?.source_item_key).toBe("line-64");
  });
});
