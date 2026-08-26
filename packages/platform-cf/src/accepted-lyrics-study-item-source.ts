import {
  ControlPlaneDb,
  type ControlPlaneError,
  type StudyItemSource,
  StudyItemSourceError,
  type StudyItemSourceRequest,
  type StudyItemSourceSetV1,
} from "@pirate/application";
import { Effect, type Layer } from "effect";

const PRODUCER_ID = "accepted-lyrics-cloze";
const PRODUCER_REVISION = "accepted-lyrics-cloze-v1";
const MAX_ITEMS = 64;

type PublicationRow = Readonly<{
  audio_revision: unknown;
  lyrics_revision: unknown;
  lyrics_text: unknown;
}>;

const unavailable = () => new StudyItemSourceError({ reason: "unavailable" });
const invalidSource = () => new StudyItemSourceError({ reason: "invalid-source" });

const positiveSafeInteger = (value: unknown): number | null => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

const acceptedAnswers = (answer: string): readonly [string, ...string[]] => {
  const withoutEdgePunctuation = answer.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "");
  return withoutEdgePunctuation.length > 0 && withoutEdgePunctuation !== answer
    ? [answer, withoutEdgePunctuation]
    : [answer];
};

const normalizedLyricsLines = (lyricsText: string): readonly string[] => {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const rawLine of lyricsText.split(/\r\n?|\n/u)) {
    const line = rawLine.replace(/\s+/gu, " ").trim();
    if (line.length === 0 || seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines;
};

export function buildAcceptedLyricsStudyItemSource(input: {
  readonly request: StudyItemSourceRequest;
  readonly lyricsText: string;
}): StudyItemSourceSetV1 | null {
  const items: Array<StudyItemSourceSetV1["items"][number]> = [];
  for (const line of normalizedLyricsLines(input.lyricsText)) {
    if (items.length >= MAX_ITEMS) break;
    const words = line.split(" ");
    const answer = words.at(-1);
    if (answer === undefined || answer.length === 0 || answer.length > 4_096) continue;
    const prefix = words.slice(0, -1).join(" ");
    const promptText =
      prefix.length === 0
        ? "Enter the missing accepted lyric word: ____"
        : `Complete the accepted lyric: ${prefix} ____`;
    if (promptText.length > 4_096) continue;
    items.push({
      source_item_key: `line-${String(items.length + 1).padStart(2, "0")}`,
      prompt: { kind: "text_response", text: promptText },
      answer_key: {
        kind: "text_response",
        comparison: "unicode_casefold_whitespace_v1",
        accepted_answers: acceptedAnswers(answer),
      },
    });
  }
  const firstItem = items[0];
  if (firstItem === undefined) return null;
  const sourceItems: StudyItemSourceSetV1["items"] = [firstItem, ...items.slice(1)];

  return {
    version: "study_item_source_v1",
    song_revision: {
      community_id: input.request.communityId,
      post_id: input.request.postId,
      audio_revision: input.request.audioRevision,
      lyrics_revision: input.request.lyricsRevision,
    },
    source_revision: input.request.lyricsRevision,
    provenance: {
      kind: "accepted_song_lyrics",
      producer_id: PRODUCER_ID,
      producer_revision: PRODUCER_REVISION,
    },
    items: sourceItems,
  };
}

export function makeControlPlaneAcceptedLyricsStudyItemSource(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): StudyItemSource["Service"] {
  return {
    getForAcceptedSongRevision: (input) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute<PublicationRow>({
          label: "study-item-source.accepted-lyrics.read",
          text: `SELECT publication.audio_revision, publication.lyrics_revision,
                        publication.lyrics_text
                   FROM posts AS post
                   JOIN media_publication_projections AS publication
                     ON publication.community_id=post.community_id
                    AND publication.post_id=post.post_id
                  WHERE post.community_id=$1 AND post.post_id=$2
                    AND post.post_type='song' AND post.status='published'
                    AND post.visibility='public'
                    AND publication.audio_revision=$3
                    AND publication.lyrics_revision=$4
                    AND publication.lyrics_status='ready'
                    AND publication.lyrics_text IS NOT NULL`,
          values: [input.communityId, input.postId, input.audioRevision, input.lyricsRevision],
          readonly: true,
        });
        const row = result.rows[0];
        if (result.rows.length === 0 || row === undefined) {
          return yield* Effect.fail(unavailable());
        }
        const lyricsText = row.lyrics_text;
        if (
          result.rows.length !== 1 ||
          positiveSafeInteger(row.audio_revision) !== input.audioRevision ||
          positiveSafeInteger(row.lyrics_revision) !== input.lyricsRevision ||
          typeof lyricsText !== "string"
        ) {
          return yield* Effect.fail(invalidSource());
        }
        const source = yield* Effect.try({
          try: () => buildAcceptedLyricsStudyItemSource({ request: input, lyricsText }),
          catch: () => invalidSource(),
        });
        return source ?? (yield* Effect.fail(unavailable()));
      }).pipe(
        Effect.provide(runtime),
        Effect.mapError((error) => (error instanceof StudyItemSourceError ? error : unavailable())),
      ),
  };
}
