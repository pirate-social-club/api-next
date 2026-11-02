import type { Client } from "pg";

/** Eight disposable ready songs sort ahead of the real start target. Only the
 * catalogue fixtures are replicated; the learner and session use ordinary writes. */
export async function insertTelegramCatalogueFirstPage(admin: Client) {
  const copy = async (
    table: string,
    where: string,
    patch: string,
    values: unknown[],
    tail = "",
  ) => {
    const columns = (
      await admin.query(
        `SELECT attname FROM pg_attribute WHERE attrelid=$1::regclass
      AND attnum>0 AND NOT attisdropped AND attgenerated='' ORDER BY attnum`,
        [table],
      )
    ).rows.map((row: { attname: string }) => `"${row.attname.replaceAll('"', '""')}"`);
    await admin.query(
      `INSERT INTO ${table}(${columns.join(",")})
      SELECT ${columns.map((column) => `target.${column}`).join(",")}
      FROM ${table} source CROSS JOIN LATERAL jsonb_populate_record(NULL::${table},to_jsonb(source)||${patch}) target
      WHERE ${where} ${tail}`,
      values,
    );
  };
  await admin.query("SET session_replication_role=replica");
  try {
    for (let index = 1; index <= 8; index++) {
      const postId = `page-${index}`;
      const replacement = {
        post_id: postId,
        submission_id: `page-submission-${index}`,
        operation_id: `page-operation-${index}`,
        idempotency_key: `page-key-${index}`,
        audio_reservation_id: `page-audio-${index}`,
      };
      for (const table of [
        "posts",
        "media_post_submissions",
        "media_publication_projections",
        "localization_lyric_line_occurrences",
        "localization_lyrics_revision_lines",
        "study_language_profiles",
        "study_language_profile_units",
      ])
        await copy(table, "source.post_id='study-post'", "$1::jsonb", [
          JSON.stringify(replacement),
        ]);
      await copy(
        "media_song_stems",
        "source.submission_id='study-submission'",
        "$1::jsonb||jsonb_build_object('reservation_id',$2||source.slot,'immutable_ref',$2||source.immutable_ref,'destination_ref',$2||source.destination_ref)",
        [JSON.stringify(replacement), `${postId}-`],
      );
      await copy(
        "study_exercise_versions",
        "source.post_id='study-post'",
        "$1::jsonb||jsonb_build_object('exercise_version_id',$2||source.exercise_version_id,'exercise_review_key',$2||source.exercise_review_key)",
        [JSON.stringify(replacement), `${postId}-`],
      );
      await copy(
        "study_learner_catalogue_decisions",
        "source.post_id='study-post'",
        "jsonb_build_object('post_id',$1::text,'decision_revision',1)",
        [postId],
        "ORDER BY source.decision_revision DESC LIMIT 1",
      );
    }
  } finally {
    await admin.query("SET session_replication_role=origin");
  }
}
