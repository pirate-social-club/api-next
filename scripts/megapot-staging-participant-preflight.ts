import { ControlPlaneDb } from "@pirate/application";
import { Effect, Schema } from "effect";
import { makeDirectPostgresControlPlaneLayer } from "../packages/platform-cf/src/postgres.ts";
import {
  type MegapotParticipantPreflight,
  parseMegapotParticipantPreflight,
} from "./megapot-participant-preflight-artifact.ts";
import { megapotVeryEvidenceCte } from "./megapot-very-preflight-sql.ts";
import { normalizePostgresConnectionString } from "./postgres-migrations.ts";

const Identifier = Schema.NonEmptyString.check(Schema.isMaxLength(128));
const Input = Schema.Struct({
  accountId: Identifier,
  personaId: Identifier,
  communityId: Identifier,
  postId: Identifier,
});

type Input = Schema.Schema.Type<typeof Input>;

export const megapotParticipantPreflightSql = `${megapotVeryEvidenceCte}, one_evidence AS (
  SELECT exact_evidence.*, count(*) OVER () AS evidence_count
    FROM exact_evidence
), content AS (
  SELECT publication.audio_revision::integer AS audio_revision,
         publication.lyrics_revision::integer AS lyrics_revision,
         count(DISTINCT exercise.exercise_review_key)::integer AS study_exercise_count,
         count(DISTINCT exercise.exercise_review_key) FILTER (
           WHERE review.review_item_id IS NULL OR review.due_at <= clock_timestamp()
         )::integer AS study_due_exercise_count
    FROM media_publication_projections publication
    JOIN media_post_submissions submission
      ON submission.submission_id=publication.submission_id
     AND submission.audio_revision=publication.audio_revision
     AND submission.current_lyrics_revision=publication.lyrics_revision
    JOIN study_exercise_versions exercise
      ON exercise.community_id=publication.community_id
     AND exercise.post_id=publication.post_id
     AND exercise.audio_revision=publication.audio_revision
     AND exercise.lyrics_revision=publication.lyrics_revision
     AND exercise.exercise_type='say_it_back'
     AND exercise.target_language IS NULL
     AND exercise.learner_band IS NULL
     AND exercise.retired_at IS NULL
   LEFT JOIN study_review_items review
     ON review.account_id=$1
    AND review.post_id=exercise.post_id
    AND review.study_unit_id=exercise.study_unit_id
    AND review.exercise_kind=exercise.exercise_type
    AND review.learning_language=exercise.learning_language
    AND review.target_language IS NOT DISTINCT FROM exercise.target_language
    AND review.learner_band IS NOT DISTINCT FROM exercise.learner_band
    AND review.lifecycle_status='active'
   WHERE publication.community_id=$3 AND publication.post_id=$4
     AND publication.lyrics_status='ready'
   GROUP BY publication.audio_revision, publication.lyrics_revision
), active_study_session AS (
  SELECT session.session_id
    FROM study_sessions_v2 session
    JOIN media_publication_projections publication
      ON publication.community_id=session.community_id
     AND publication.post_id=session.post_id
     AND publication.audio_revision=session.audio_revision
     AND publication.lyrics_revision=session.lyrics_revision
     AND publication.lyrics_status='ready'
    JOIN study_session_items_v2 item ON item.session_id=session.session_id
    JOIN study_exercise_versions exercise
      ON exercise.exercise_version_id=item.exercise_version_id
     AND exercise.audio_revision=session.audio_revision
     AND exercise.lyrics_revision=session.lyrics_revision
     AND exercise.exercise_type='say_it_back'
     AND exercise.target_language IS NULL
     AND exercise.learner_band IS NULL
     AND exercise.retired_at IS NULL
   WHERE session.account_id=$1 AND session.persona_id=$2
     AND session.community_id=$3 AND session.post_id=$4
     AND session.status='active' AND session.expires_at > clock_timestamp()
   GROUP BY session.session_id, session.created_at
  HAVING count(DISTINCT item.session_item_id) >= 4
   ORDER BY session.created_at DESC
   LIMIT 1
)
SELECT 'megapot_participant_preflight_v1' AS object,
       to_char(clock_timestamp() AT TIME ZONE 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS checked_at,
       to_char(LEAST(
         clock_timestamp() + interval '10 minutes',
         COALESCE(evidence.evidence_expires_at, 'infinity'::timestamptz)
       ) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS valid_until,
       $1::text AS account_id, persona.persona_id, membership.community_id,
       $4::text AS post_id, membership.membership_id,
       content.audio_revision, content.lyrics_revision, content.study_exercise_count,
       content.study_due_exercise_count, active_study_session.session_id AS study_session_id,
       evidence.subject_key_id, evidence.binding_event_id, evidence.binding_epoch,
       evidence.binding_group_id, evidence.evidence_receipt_id, evidence.evidence_hash,
       evidence.personhood_assertion_id, evidence.subject_unique_assertion_id,
       CASE WHEN evidence.evidence_expires_at IS NULL THEN NULL ELSE
         to_char(evidence.evidence_expires_at AT TIME ZONE 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS evidence_expires_at
  FROM personas persona
  JOIN community_memberships membership
    ON membership.user_id=persona.account_id
   AND membership.community_id=$3
   AND membership.status='member'
  CROSS JOIN content
  CROSS JOIN one_evidence evidence
  LEFT JOIN active_study_session ON TRUE
 WHERE persona.account_id=$1 AND persona.persona_id=$2 AND persona.status='active'
   AND content.study_exercise_count >= 4
   AND (content.study_due_exercise_count >= 4 OR active_study_session.session_id IS NOT NULL)
   AND evidence.evidence_count=1`;

export class MegapotParticipantPreflightFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MegapotParticipantPreflightFailed";
  }
}

export async function loadMegapotParticipantPreflight(
  connectionString: string,
  input: Input,
): Promise<MegapotParticipantPreflight> {
  const rows = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.execute<Readonly<Record<string, unknown>>>({
          label: "megapot.participant.preflight",
          text: megapotParticipantPreflightSql,
          values: [input.accountId, input.personaId, input.communityId, input.postId],
          readonly: true,
        });
      }).pipe(
        Effect.provide(
          makeDirectPostgresControlPlaneLayer(normalizePostgresConnectionString(connectionString)),
        ),
      ),
    ),
  );
  if (rows.rows.length !== 1 || rows.rows[0] === undefined) {
    throw new MegapotParticipantPreflightFailed(
      "Participant preflight failed: exact fresh Very evidence, active membership/persona, and four selectable Study exercises or one matching active typed session are required.",
    );
  }
  return parseMegapotParticipantPreflight(rows.rows[0]);
}

function parseArgs(args: readonly string[]): Input {
  const value = (flag: string) => {
    const index = args.indexOf(flag);
    return index < 0 ? undefined : args[index + 1];
  };
  const document = {
    accountId: value("--account-id"),
    personaId: value("--persona-id"),
    communityId: value("--community-id"),
    postId: value("--post-id"),
  };
  const allowed = new Set([
    "--account-id",
    "--persona-id",
    "--community-id",
    "--post-id",
    ...Object.values(document),
  ]);
  if (args.some((argument) => !allowed.has(argument))) {
    throw new MegapotParticipantPreflightFailed("Unknown participant preflight option.");
  }
  try {
    return Schema.decodeUnknownSync(Input, { onExcessProperty: "error" })(document);
  } catch {
    throw new MegapotParticipantPreflightFailed(
      "Provide --account-id, --persona-id, --community-id, and --post-id.",
    );
  }
}

export async function main(args: readonly string[] = Bun.argv.slice(2)): Promise<void> {
  if (process.env.API_NEXT_ENV !== "staging") {
    throw new MegapotParticipantPreflightFailed(
      "Participant preflight is refused unless API_NEXT_ENV=staging.",
    );
  }
  const connectionString = process.env.CONTROL_PLANE_POSTGRES_RUNTIME_URL;
  if (connectionString === undefined || connectionString.trim() === "") {
    throw new MegapotParticipantPreflightFailed("CONTROL_PLANE_POSTGRES_RUNTIME_URL is required.");
  }
  console.log(
    JSON.stringify(
      await loadMegapotParticipantPreflight(connectionString, parseArgs(args)),
      null,
      2,
    ),
  );
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(
      error instanceof MegapotParticipantPreflightFailed
        ? error.message
        : "Participant preflight failed.",
    );
    process.exitCode = 1;
  });
}
