import { createHash } from "node:crypto";
import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import {
  type KaraokeReadiness,
  KaraokeReadiness as KaraokeReadinessSchema,
} from "@pirate/contracts";
import { canonicalJson } from "@pirate/domain";
import { Effect, type Layer, Schema } from "effect";

type Row = Readonly<Record<string, unknown>>;

const KARAOKE_REVISION_ALGORITHM = "karaoke_revision_v1" as const;

const TimedSegment = Schema.Struct({
  text: Schema.String,
  start_ms: Schema.Number,
  end_ms: Schema.Number,
}).check(
  Schema.makeFilter((segment) =>
    Number.isSafeInteger(segment.start_ms) &&
    Number.isSafeInteger(segment.end_ms) &&
    segment.start_ms >= 0 &&
    segment.end_ms >= segment.start_ms
      ? undefined
      : "Timed lyric segment bounds are invalid",
  ),
);

const TimedLyricsArtifact = Schema.Struct({
  version: Schema.Literal("media-timed-lyrics-artifact-v1"),
  mode: Schema.Literals(["word", "character"]),
  segments: Schema.Array(TimedSegment),
});

type CatalogLine = Readonly<{ id: string; index: number; text: string }>;
type TimedArtifact = Schema.Schema.Type<typeof TimedLyricsArtifact>;
type PayloadLine = Readonly<{
  id: string;
  index: number;
  kind: "lyric";
  text: string;
  start_ms: number;
  end_ms: number;
  words: readonly Readonly<{ text: string; start_ms: number; end_ms: number }>[];
}>;

const compact = (value: string): string => value.replace(/\s+/gu, "");

const timedWords = (
  artifact: TimedArtifact,
): readonly Readonly<{ text: string; start_ms: number; end_ms: number }>[] | null => {
  if (artifact.mode === "word") {
    const words = artifact.segments.filter(({ text }) => compact(text).length > 0);
    return words.every(({ text }) => !/\s/u.test(text)) ? words : null;
  }
  const words: Array<{ text: string; start_ms: number; end_ms: number }> = [];
  let current: { text: string; start_ms: number; end_ms: number } | null = null;
  for (const segment of artifact.segments) {
    const isSpacing = /^\s+$/u.test(segment.text);
    if (isSpacing) {
      if (current !== null) words.push(current);
      current = null;
      continue;
    }
    if (/\s/u.test(segment.text) || segment.text.length === 0) return null;
    current =
      current === null
        ? { ...segment }
        : {
            text: current.text + segment.text,
            start_ms: current.start_ms,
            end_ms: segment.end_ms,
          };
  }
  if (current !== null) words.push(current);
  return words;
};

export const buildKaraokePayloadLines = (input: {
  readonly artifact: unknown;
  readonly catalogLines: readonly CatalogLine[];
}): readonly PayloadLine[] | null => {
  let artifact: TimedArtifact;
  try {
    artifact = Schema.decodeUnknownSync(TimedLyricsArtifact)(input.artifact);
  } catch {
    return null;
  }
  const words = timedWords(artifact);
  if (words === null) return null;
  let wordIndex = 0;
  const lines = [];
  for (const line of input.catalogLines) {
    const expected = compact(line.text);
    if (expected.length === 0) return null;
    const lineWords = [];
    let received = "";
    while (received.length < expected.length) {
      const word = words[wordIndex];
      if (word === undefined) return null;
      lineWords.push(word);
      received += compact(word.text);
      wordIndex += 1;
    }
    if (received !== expected) return null;
    const first = lineWords[0];
    const last = lineWords.at(-1);
    if (first === undefined || last === undefined) return null;
    lines.push({
      id: line.id,
      index: line.index,
      kind: "lyric" as const,
      text: line.text,
      start_ms: first.start_ms,
      end_ms: last.end_ms,
      words: lineWords,
    });
  }
  return wordIndex === words.length ? lines : null;
};

const string = (row: Row, key: string): string | null => {
  const value = row[key];
  return typeof value === "string" && value.length > 0 ? value : null;
};

const integer = (row: Row, key: string): number | null => {
  const value = Number(row[key]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
};

const decode = (value: unknown): KaraokeReadiness =>
  Schema.decodeUnknownSync(KaraokeReadinessSchema)(value);

const repository = (input: {
  readonly communityId: string;
  readonly postId: string;
}): Effect.Effect<KaraokeReadiness, ControlPlaneError, ControlPlaneDb> =>
  Effect.gen(function* () {
    const db = yield* ControlPlaneDb;
    const source = yield* db.execute<Row>({
      label: "karaoke-readiness.source",
      text: `SELECT post.post_type, post.status AS post_status, post.visibility,
                    publication.title, publication.audio_asset_ref,
                    publication.canonical_audio_sha256, publication.lyrics_status,
                    publication.lyrics_revision, alignment.status AS alignment_status,
                    artifact.artifact_sha256, artifact.artifact
               FROM posts AS post
               LEFT JOIN media_publication_projections AS publication
                 ON publication.community_id=post.community_id
                AND publication.post_id=post.post_id
               LEFT JOIN media_alignment_projections AS alignment
                 ON alignment.community_id=publication.community_id
                AND alignment.post_id=publication.post_id
                AND alignment.submission_id=publication.submission_id
                AND alignment.audio_revision=publication.audio_revision
                AND alignment.analysis_revision=publication.analysis_revision
                AND alignment.lyrics_revision=publication.lyrics_revision
               LEFT JOIN media_timed_lyrics_artifacts AS artifact
                 ON artifact.artifact_ref=alignment.current_artifact_ref
                AND artifact.artifact_revision=alignment.current_artifact_revision
                AND artifact.submission_id=publication.submission_id
                AND artifact.audio_revision=publication.audio_revision
                AND artifact.analysis_revision=publication.analysis_revision
                AND artifact.lyrics_revision=publication.lyrics_revision
                AND artifact.canonical_audio_sha256=publication.canonical_audio_sha256
              WHERE post.community_id=$1 AND post.post_id=$2`,
      values: [input.communityId, input.postId],
      readonly: true,
    });
    const row = source.rows[0];
    if (
      source.rows.length !== 1 ||
      row === undefined ||
      row.post_type !== "song" ||
      row.post_status !== "published" ||
      row.visibility !== "public"
    ) {
      return decode({ state: "unavailable", reason: "not_a_song" });
    }
    if (row.lyrics_status !== "ready" || integer(row, "lyrics_revision") === null) {
      return decode({ state: "unavailable", reason: "lyrics_not_accepted" });
    }
    if (row.alignment_status === "pending" || row.alignment_status === null) {
      return decode({ state: "processing", reason: "alignment_pending" });
    }
    if (row.alignment_status !== "ready") {
      return decode({ state: "unavailable", reason: "alignment_unavailable" });
    }
    const lyricsRevision = integer(row, "lyrics_revision");
    const audioRef = string(row, "audio_asset_ref");
    const audioHash = string(row, "canonical_audio_sha256");
    const artifactHash = string(row, "artifact_sha256");
    const title = string(row, "title");
    if (
      lyricsRevision === null ||
      audioRef === null ||
      audioHash === null ||
      artifactHash === null ||
      title === null ||
      row.artifact === null
    ) {
      return decode({ state: "unavailable", reason: "invalid_timed_lyrics" });
    }
    const catalog = yield* db.execute<Row>({
      label: "karaoke-readiness.catalog",
      text: `SELECT membership.ordinal, membership.lyric_line_id, version.canonical_text
               FROM localization_lyrics_revision_lines AS membership
               JOIN localization_lyric_line_versions AS version
                 ON version.community_id=membership.community_id
                AND version.post_id=membership.post_id
                AND version.lyric_line_id=membership.lyric_line_id
                AND version.line_version=membership.line_version
                AND version.source_hash=membership.source_hash
              WHERE membership.community_id=$1 AND membership.post_id=$2
                AND membership.lyrics_revision=$3
              ORDER BY membership.ordinal`,
      values: [input.communityId, input.postId, lyricsRevision],
      readonly: true,
    });
    const catalogLines = catalog.rows.flatMap((line) => {
      const id = string(line, "lyric_line_id");
      const index = integer(line, "ordinal");
      const lineText = string(line, "canonical_text");
      return id === null || index === null || lineText === null
        ? []
        : [{ id, index: index - 1, text: lineText }];
    });
    if (catalogLines.length === 0 || catalogLines.length !== catalog.rows.length) {
      return decode({ state: "unavailable", reason: "line_catalog_missing" });
    }
    const lines = buildKaraokePayloadLines({ artifact: row.artifact, catalogLines });
    if (lines === null || lines.length === 0) {
      return decode({ state: "unavailable", reason: "invalid_timed_lyrics" });
    }
    const revisionHash = createHash("sha256")
      .update(
        canonicalJson({
          algorithm: KARAOKE_REVISION_ALGORITHM,
          audio_sha256: audioHash,
          lyrics_revision: lyricsRevision,
          timed_artifact_sha256: artifactHash,
          playback_kind: "full_mix",
        }),
        "utf8",
      )
      .digest("hex");
    return decode({
      state: "ready",
      object: "song_karaoke_payload",
      community_id: input.communityId,
      post_id: input.postId,
      title,
      karaoke_revision_id: `karaoke-revision-${revisionHash}`,
      playback_audio: { kind: "full_mix", ref: audioRef },
      playback_kind: "full_mix",
      karaoke_lines: lines,
    });
  });

export const makeControlPlaneKaraokeReadinessStore = (
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): Readonly<{
  get: (input: {
    readonly communityId: string;
    readonly postId: string;
  }) => Promise<KaraokeReadiness>;
}> => ({
  get: (input) => Effect.runPromise(repository(input).pipe(Effect.provide(runtime))),
});
