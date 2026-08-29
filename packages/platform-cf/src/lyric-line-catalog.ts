import { createHash } from "node:crypto";
import type { ControlPlaneError, ControlPlaneTransaction } from "@pirate/application";
import {
  LYRIC_LINE_IDENTITY_NORMALIZATION_V1,
  normalizeLyricLineIdentityV1,
  type PriorLyricOccurrence,
  reconcileLyricLineIdentities,
} from "@pirate/domain";
import { Effect } from "effect";

type Row = Readonly<Record<string, unknown>>;

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

const text = (row: Row, key: string): string => {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`invalid ${key}`);
  return value;
};

const positiveInteger = (row: Row, key: string): number => {
  const value = Number(row[key]);
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`invalid ${key}`);
  return value;
};

export const materializeAcceptedLyricLineCatalog = (
  tx: ControlPlaneTransaction,
  input: Readonly<{
    communityId: string;
    lyrics: string;
    lyricsRevision: number;
    postId: string;
    sourceLanguage: string | null;
    submissionId: string;
    actorUserId: string;
  }>,
): Effect.Effect<void, ControlPlaneError> =>
  Effect.gen(function* () {
    yield* tx.execute({
      label: "lyric-line-catalog.post-lock",
      text: "SELECT 1 FROM posts WHERE community_id=$1 AND post_id=$2 FOR UPDATE",
      values: [input.communityId, input.postId],
      readonly: false,
    });
    const priorRows = yield* tx.execute<Row>({
      label: "lyric-line-catalog.previous",
      text: `WITH previous_revision AS (
             SELECT max(lyrics_revision) AS lyrics_revision
               FROM localization_lyrics_revision_lines
              WHERE community_id=$1 AND post_id=$2 AND lyrics_revision < $3
           )
           SELECT membership.lyrics_revision, membership.ordinal, membership.lyric_line_id, membership.line_version,
                  version.canonical_text, version.source_hash, unit.study_unit_id
             FROM localization_lyrics_revision_lines AS membership
             JOIN previous_revision
               ON previous_revision.lyrics_revision=membership.lyrics_revision
             JOIN localization_lyric_line_versions AS version
               ON version.community_id=membership.community_id
              AND version.post_id=membership.post_id
              AND version.lyric_line_id=membership.lyric_line_id
              AND version.line_version=membership.line_version
             JOIN localization_lyric_line_study_units AS unit
               ON unit.community_id=version.community_id
              AND unit.post_id=version.post_id
              AND unit.lyric_line_id=version.lyric_line_id
              AND unit.line_version=version.line_version
            ORDER BY membership.ordinal`,
      values: [input.communityId, input.postId, input.lyricsRevision],
      readonly: false,
    });
    const previous = priorRows.rows.map(
      (row): PriorLyricOccurrence => ({
        canonicalText: text(row, "canonical_text"),
        lineId: text(row, "lyric_line_id"),
        lineVersion: positiveInteger(row, "line_version"),
        normalizedText: normalizeLyricLineIdentityV1(text(row, "canonical_text")),
        ordinal: positiveInteger(row, "ordinal"),
        sourceHash: text(row, "source_hash"),
        studyUnitId: text(row, "study_unit_id"),
      }),
    );
    const firstPriorRow = priorRows.rows[0];
    const previousLyricsRevision =
      firstPriorRow === undefined ? null : positiveInteger(firstPriorRow, "lyrics_revision");
    const unitRows = yield* tx.execute<Row>({
      label: "lyric-line-catalog.study-units",
      text: `SELECT study_unit_id, normalized_source_hash
             FROM localization_study_units
            WHERE community_id=$1 AND post_id=$2
              AND identity_normalization_revision=$3`,
      values: [input.communityId, input.postId, LYRIC_LINE_IDENTITY_NORMALIZATION_V1],
      readonly: false,
    });
    const unitByHash = new Map(
      unitRows.rows.map((row) => [text(row, "normalized_source_hash"), text(row, "study_unit_id")]),
    );
    const normalizedCandidates = input.lyrics
      .split(/\r\n?|\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map(normalizeLyricLineIdentityV1);
    const unitsByText = new Map<string, string>();
    for (const normalized of normalizedCandidates) {
      const unitId = unitByHash.get(sha256(normalized));
      if (unitId !== undefined) unitsByText.set(normalized, unitId);
    }
    const result = reconcileLyricLineIdentities({
      lyrics: input.lyrics,
      previous,
      studyUnitsByNormalizedText: unitsByText,
      nextLineId: () => `lyric-line-${crypto.randomUUID()}`,
      nextStudyUnitId: () => `study-unit-${crypto.randomUUID()}`,
    });
    const sourceLanguage = input.sourceLanguage ?? "und";
    const priorById = new Map(previous.map((line) => [line.lineId, line]));
    for (const line of result.lines) {
      const normalizedHash = sha256(line.normalizedText);
      yield* tx.execute({
        label: "lyric-line-catalog.study-unit.insert",
        text: `INSERT INTO localization_study_units (
               community_id, post_id, study_unit_id, identity_normalization_revision,
               normalized_source_hash
             ) VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (
               community_id, post_id, identity_normalization_revision, normalized_source_hash
             ) DO NOTHING`,
        values: [
          input.communityId,
          input.postId,
          line.studyUnitId,
          LYRIC_LINE_IDENTITY_NORMALIZATION_V1,
          normalizedHash,
        ],
        readonly: false,
      });
      if (!line.carried) {
        yield* tx.execute({
          label: "lyric-line-catalog.occurrence.insert",
          text: `INSERT INTO localization_lyric_line_occurrences (
                 community_id, post_id, lyric_line_id
               ) VALUES ($1,$2,$3)`,
          values: [input.communityId, input.postId, line.lineId],
          readonly: false,
        });
      }
      const prior = priorById.get(line.lineId);
      const sourceHash = sha256(line.canonicalText);
      if (prior === undefined || prior.sourceHash !== sourceHash) {
        yield* tx.execute({
          label: "lyric-line-catalog.version.insert",
          text: `INSERT INTO localization_lyric_line_versions (
                 community_id, post_id, lyric_line_id, line_version, canonical_text,
                 source_language, source_hash
               ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          values: [
            input.communityId,
            input.postId,
            line.lineId,
            line.lineVersion,
            line.canonicalText,
            sourceLanguage,
            sourceHash,
          ],
          readonly: false,
        });
      }
      yield* tx.execute({
        label: "lyric-line-catalog.unit-membership.insert",
        text: `INSERT INTO localization_lyric_line_study_units (
               community_id, post_id, lyric_line_id, line_version, study_unit_id
             ) VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (community_id, post_id, lyric_line_id, line_version) DO NOTHING`,
        values: [input.communityId, input.postId, line.lineId, line.lineVersion, line.studyUnitId],
        readonly: false,
      });
      yield* tx.execute({
        label: "lyric-line-catalog.revision-membership.insert",
        text: `INSERT INTO localization_lyrics_revision_lines (
               community_id, actor_user_id, post_id, submission_id, lyrics_revision,
               ordinal, lyric_line_id, line_version, source_hash
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        values: [
          input.communityId,
          input.actorUserId,
          input.postId,
          input.submissionId,
          input.lyricsRevision,
          line.ordinal,
          line.lineId,
          line.lineVersion,
          sourceHash,
        ],
        readonly: false,
      });
      if (line.priorOrdinal !== null) {
        if (previousLyricsRevision === null)
          throw new TypeError("missing previous lyrics revision");
        yield* tx.execute({
          label: "lyric-line-catalog.reconciliation.retained",
          text: `INSERT INTO localization_lyric_reconciliation_decisions (
                 reconciliation_id, community_id, post_id, from_lyrics_revision,
                 to_lyrics_revision, prior_ordinal, candidate_ordinal, outcome,
                 lyric_line_id, reason
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,'retained',$8,$9)`,
          values: [
            `lyric-reconciliation-${crypto.randomUUID()}`,
            input.communityId,
            input.postId,
            previousLyricsRevision,
            input.lyricsRevision,
            line.priorOrdinal,
            line.ordinal,
            line.lineId,
            LYRIC_LINE_IDENTITY_NORMALIZATION_V1,
          ],
          readonly: false,
        });
      }
    }
    for (const retired of result.retired) {
      if (previousLyricsRevision === null) throw new TypeError("missing previous lyrics revision");
      yield* tx.execute({
        label: "lyric-line-catalog.occurrence.retire",
        text: `UPDATE localization_lyric_line_occurrences
                SET lifecycle_status='retired', retirement_reason=$1, retired_at=clock_timestamp()
              WHERE community_id=$2 AND post_id=$3 AND lyric_line_id=$4
                AND lifecycle_status='active'`,
        values: [
          result.lines.some(({ carried }) => !carried) ? "replaced" : "deleted",
          input.communityId,
          input.postId,
          retired.lineId,
        ],
        readonly: false,
      });
      const candidateOrdinal = result.lines.find(
        (line) => line.normalizedText === previous[retired.ordinal - 1]?.normalizedText,
      )?.ordinal;
      yield* tx.execute({
        label: "lyric-line-catalog.reconciliation.retired",
        text: `INSERT INTO localization_lyric_reconciliation_decisions (
               reconciliation_id, community_id, post_id, from_lyrics_revision,
               to_lyrics_revision, prior_ordinal, candidate_ordinal, outcome,
               lyric_line_id, reason
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        values: [
          `lyric-reconciliation-${crypto.randomUUID()}`,
          input.communityId,
          input.postId,
          previousLyricsRevision,
          input.lyricsRevision,
          retired.ordinal,
          candidateOrdinal ?? null,
          retired.ambiguous ? "uncertain" : "retired",
          retired.ambiguous ? null : retired.lineId,
          retired.ambiguous ? "ambiguous_in_order_exact_match" : "no_in_order_exact_match",
        ],
        readonly: false,
      });
    }
  });
