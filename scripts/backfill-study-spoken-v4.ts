import {
  evaluateStudyUnitSayItBackEligibilityV1,
  normalizeLyricLineIdentityV1,
} from "@pirate/domain";
import {
  acceptedSpokenV4Insert,
  spokenV4ContentRevision,
} from "@pirate/platform-cf/study-spoken-v4-materialization";
import { Client } from "pg";
import { normalizePostgresConnectionString } from "./postgres-connection-string.ts";

type SourceRow = {
  community_id: string;
  post_id: string;
  audio_revision: string;
  lyrics_revision: string;
  lyric_line_id: string;
  line_version: string;
  canonical_text: string;
  source_hash: string;
  study_unit_id: string;
  policy_revision: string;
  eligibility: string;
  language_profile_revision: string | null;
  current_policy: string | null;
  current_content_revision: string | null;
};

const sourceSql = `SELECT DISTINCT ON (unit.study_unit_id)
  projection.community_id, projection.post_id, projection.audio_revision,
  projection.lyrics_revision, membership.lyric_line_id, membership.line_version,
  version.canonical_text, version.source_hash, unit.study_unit_id,
  eligibility.policy_revision, eligibility.eligibility,
  profile.language_profile_revision,
  current_exercise.grader_policy_revision AS current_policy,
  current_exercise.current_content_revision
 FROM media_publication_projections projection
 JOIN media_post_submissions submission
   ON submission.submission_id=projection.submission_id
  AND submission.community_id=projection.community_id
  AND submission.post_id=projection.post_id
 JOIN media_song_lyrics_revisions lyrics
   ON lyrics.submission_id=submission.submission_id
  AND lyrics.lyrics_revision=projection.lyrics_revision
 JOIN localization_lyrics_revision_lines membership
   ON membership.community_id=projection.community_id
  AND membership.post_id=projection.post_id
  AND membership.lyrics_revision=projection.lyrics_revision
 JOIN localization_lyric_line_versions version
   ON version.community_id=membership.community_id
  AND version.post_id=membership.post_id
  AND version.lyric_line_id=membership.lyric_line_id
  AND version.line_version=membership.line_version
  AND version.source_hash=membership.source_hash
 JOIN localization_lyric_line_study_units unit
   ON unit.community_id=membership.community_id
  AND unit.post_id=membership.post_id
  AND unit.lyric_line_id=membership.lyric_line_id
  AND unit.line_version=membership.line_version
 JOIN study_unit_exercise_eligibility eligibility
   ON eligibility.community_id=unit.community_id
  AND eligibility.post_id=unit.post_id
  AND eligibility.study_unit_id=unit.study_unit_id
  AND eligibility.exercise_kind='say_it_back'
 LEFT JOIN LATERAL (
   SELECT language_profile_revision FROM study_language_profiles profile
    WHERE profile.community_id=projection.community_id
      AND profile.post_id=projection.post_id
      AND profile.lyrics_revision=projection.lyrics_revision
      AND profile.source_hash=lyrics.lyrics_sha256
    ORDER BY language_profile_revision DESC LIMIT 1
 ) profile ON true
 LEFT JOIN LATERAL (
   SELECT grader_policy_revision, content_revision AS current_content_revision
     FROM study_exercise_versions exercise
    WHERE exercise.community_id=unit.community_id
      AND exercise.post_id=unit.post_id
      AND exercise.study_unit_id=unit.study_unit_id
      AND exercise.audio_revision=projection.audio_revision
      AND exercise.lyrics_revision=projection.lyrics_revision
      AND exercise.exercise_type='say_it_back'
      AND exercise.retired_at IS NULL
    ORDER BY content_revision DESC LIMIT 1
 ) current_exercise ON true
 WHERE projection.lyrics_status='ready'
   AND submission.status='published'
   AND submission.current_lyrics_revision=projection.lyrics_revision
   AND projection.post_id=$1
   AND eligibility.eligibility='eligible'
 ORDER BY unit.study_unit_id, membership.ordinal`;

const required = (key: string): string => {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
};

const positive = (value: string) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("invalid source revision");
  return number;
};

export const backfillStudySpokenV4 = async (client: Client, postId: string, apply: boolean) => {
  await client.query(apply ? "BEGIN" : "BEGIN READ ONLY");
  try {
    await client.query("SET LOCAL search_path TO api_next, pg_catalog");
    await client.query("SET LOCAL statement_timeout TO '15s'");
    if (apply) {
      const locked = await client.query("SELECT 1 FROM posts WHERE post_id=$1 FOR UPDATE", [
        postId,
      ]);
      if (locked.rowCount !== 1) throw new Error("post lock was missing or ambiguous");
    }
    const rows = (await client.query<SourceRow>(sourceSql, [postId])).rows;
    if (rows.length === 0) throw new Error("no current eligible spoken source rows");
    const revisions = new Set(rows.map((row) => `${row.audio_revision}:${row.lyrics_revision}`));
    if (revisions.size !== 1) throw new Error("ambiguous source revisions");
    const report = { postId, eligible: rows.length, alreadyV4: 0, inserted: 0 };
    for (const row of rows) {
      if (row.language_profile_revision === null) throw new Error("accepted profile is missing");
      const eligibility = evaluateStudyUnitSayItBackEligibilityV1(
        normalizeLyricLineIdentityV1(row.canonical_text),
      );
      if (
        eligibility.policyRevision !== row.policy_revision ||
        eligibility.eligibility !== row.eligibility
      )
        throw new Error("stored spoken eligibility differs from source policy");
      if (eligibility.eligibility !== "eligible") continue;
      if (row.current_policy === "script_aware_token_phonetic_v4") {
        report.alreadyV4++;
        continue;
      }
      const audioRevision = positive(row.audio_revision);
      const lyricsRevision = positive(row.lyrics_revision);
      const targetRevision = spokenV4ContentRevision(audioRevision, lyricsRevision);
      if (
        row.current_content_revision !== null &&
        Number(row.current_content_revision) >= targetRevision
      )
        throw new Error("current spoken version is newer than the v4 backfill target");
      const statement = acceptedSpokenV4Insert({
        communityId: row.community_id,
        postId: row.post_id,
        audioRevision,
        lyricsRevision,
        lineId: row.lyric_line_id,
        lineVersion: positive(row.line_version),
        canonicalText: row.canonical_text,
        sourceHash: row.source_hash,
        studyUnitId: row.study_unit_id,
      });
      if (!apply) continue;
      const inserted = await client.query(statement.text, statement.values);
      report.inserted += inserted.rowCount ?? 0;
      const selected = await client.query<{ grader_policy_revision: string }>(
        `SELECT grader_policy_revision FROM study_exercise_versions
          WHERE exercise_review_key=$1 AND content_revision=$2`,
        [`study-say-it-back:${postId}:${row.study_unit_id}`, targetRevision],
      );
      if (selected.rows[0]?.grader_policy_revision !== "script_aware_token_phonetic_v4") {
        throw new Error("v4 version did not materialize");
      }
    }
    await client.query(apply ? "COMMIT" : "ROLLBACK");
    return report;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
};

if (import.meta.main) {
  const postId = required("STUDY_BACKFILL_POST_ID");
  const url = new URL(normalizePostgresConnectionString(required("STUDY_BACKFILL_DATABASE_URL")));
  if (
    url.hostname !== required("STUDY_BACKFILL_EXPECTED_HOST") ||
    decodeURIComponent(url.pathname.slice(1)) !== required("STUDY_BACKFILL_EXPECTED_DATABASE") ||
    !decodeURIComponent(url.username).endsWith(required("STUDY_BACKFILL_EXPECTED_USER_SUFFIX"))
  )
    throw new Error("database branch pin mismatch");
  const apply = process.argv.includes("--apply");
  const client = new Client({ connectionString: url.toString(), connectionTimeoutMillis: 10_000 });
  try {
    await client.connect();
    const report = await backfillStudySpokenV4(client, postId, apply);
    console.log(JSON.stringify({ mode: apply ? "apply" : "preview", ...report }));
  } finally {
    await client.end();
  }
}
