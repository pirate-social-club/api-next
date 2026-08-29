import { ControlPlaneDb } from "@pirate/application";
import { Effect, Schema } from "effect";
import { makeDirectPostgresControlPlaneLayer } from "../packages/platform-cf/src/postgres.ts";
import {
  type MegapotParticipantPreflight,
  parseMegapotParticipantPreflight,
} from "./megapot-participant-preflight-artifact.ts";
import { normalizePostgresConnectionString } from "./postgres-migrations.ts";

const Identifier = Schema.NonEmptyString.check(Schema.isMaxLength(128));
const Input = Schema.Struct({
  accountId: Identifier,
  personaId: Identifier,
  communityId: Identifier,
  postId: Identifier,
});

type Input = Schema.Schema.Type<typeof Input>;

export const megapotParticipantPreflightSql = `WITH exact_evidence AS (
  SELECT DISTINCT ON (subject.subject_key_id)
         subject.subject_key_id,
         active_binding.binding_event_id,
         active_binding.binding_epoch::integer AS binding_epoch,
         binding.binding_group_id,
         receipt.evidence_receipt_id,
         receipt.evidence_hash,
         personhood.assertion_id AS personhood_assertion_id,
         subject_unique.assertion_id AS subject_unique_assertion_id,
         LEAST(receipt.expires_at, personhood.expires_at, subject_unique.expires_at)
           AS evidence_expires_at,
         receipt.observed_at
    FROM subject_keys subject
    JOIN active_subject_key_bindings active_binding
      ON active_binding.subject_key_id=subject.subject_key_id
     AND active_binding.user_id=$1
    JOIN assertion_bindings binding
      ON binding.user_id=$1
     AND binding.binding_mode='same_subject'
     AND binding.subject_key_id=subject.subject_key_id
     AND binding.subject_binding_event_id=active_binding.binding_event_id
     AND binding.subject_binding_epoch=active_binding.binding_epoch
    JOIN assertions personhood
      ON personhood.binding_group_id=binding.binding_group_id
     AND personhood.user_id=$1
     AND personhood.subject_key_id=subject.subject_key_id
     AND personhood.claim_id='human.personhood'
     AND personhood.assertion_value='{"personhood": true}'::jsonb
     AND personhood.assurance='provider_attested'
    JOIN assertions subject_unique
      ON subject_unique.binding_group_id=binding.binding_group_id
     AND subject_unique.user_id=$1
     AND subject_unique.subject_key_id=subject.subject_key_id
     AND subject_unique.evidence_receipt_id=personhood.evidence_receipt_id
     AND subject_unique.claim_id='credential.subject_unique'
     AND subject_unique.assertion_value='{"subject_unique": true}'::jsonb
     AND subject_unique.assurance='provider_attested'
    JOIN evidence_receipts receipt
      ON receipt.evidence_receipt_id=personhood.evidence_receipt_id
     AND receipt.user_id=$1
     AND receipt.subject_key_id=subject.subject_key_id
     AND receipt.subject_binding_event_id=active_binding.binding_event_id
     AND receipt.subject_binding_epoch=active_binding.binding_epoch
     AND receipt.provider_id='very.web'
     AND receipt.issuer='https://verify.very.org'
     AND receipt.method='palm_web'
     AND receipt.scope_kind='issuer_rp_scope'
     AND receipt.issuer_rp_scope='pirate-social'
     AND receipt.issuer_rp_action_scope IS NULL
     AND receipt.protocol_version='very-web-v1'
     AND receipt.evidence_kind='very.web.server-verified.v1'
     AND receipt.provenance_kind='proof_session'
    JOIN proof_sessions session
      ON session.proof_session_id=receipt.proof_session_id
     AND session.actor_id=$1
     AND session.status='completed'
     AND session.completed_at=session.terminal_at
     AND session.provider_id=receipt.provider_id
     AND session.issuer=receipt.issuer
     AND session.method=receipt.method
     AND session.scope_kind=receipt.scope_kind
     AND session.issuer_rp_scope=receipt.issuer_rp_scope
     AND session.issuer_rp_action_scope IS NOT DISTINCT FROM receipt.issuer_rp_action_scope
     AND session.protocol_version=receipt.protocol_version
     AND session.requested_requirements=
       '[{"claim_id":"credential.subject_unique"},{"claim_id":"human.personhood"}]'::jsonb
     AND session.requested_claim_ids=
       '["credential.subject_unique","human.personhood"]'::jsonb
   WHERE subject.issuer='https://verify.very.org'
     AND subject.method='palm_web'
     AND subject.scope_kind='issuer_rp_scope'
     AND subject.issuer_rp_scope='pirate-social'
     AND subject.issuer_rp_action_scope IS NULL
     AND (receipt.expires_at IS NULL OR receipt.expires_at > clock_timestamp() + interval '5 seconds')
     AND (personhood.expires_at IS NULL OR personhood.expires_at > clock_timestamp() + interval '5 seconds')
     AND (subject_unique.expires_at IS NULL OR subject_unique.expires_at > clock_timestamp() + interval '5 seconds')
     AND COALESCE((
       SELECT event.outcome FROM assertion_revalidation_events event
        WHERE event.assertion_id=personhood.assertion_id
        ORDER BY event.observed_at DESC, event.assertion_revalidation_event_id DESC LIMIT 1
     ), 'accepted')='accepted'
     AND COALESCE((
       SELECT event.outcome FROM assertion_revalidation_events event
        WHERE event.assertion_id=subject_unique.assertion_id
        ORDER BY event.observed_at DESC, event.assertion_revalidation_event_id DESC LIMIT 1
     ), 'accepted')='accepted'
   ORDER BY subject.subject_key_id, receipt.observed_at DESC, receipt.evidence_receipt_id DESC
), one_evidence AS (
  SELECT exact_evidence.*, count(*) OVER () AS evidence_count
    FROM exact_evidence
), content AS (
  SELECT publication.audio_revision::integer AS audio_revision,
         publication.lyrics_revision::integer AS lyrics_revision,
         count(DISTINCT exercise.exercise_review_key)::integer AS study_exercise_count
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
   WHERE publication.community_id=$3 AND publication.post_id=$4
     AND publication.lyrics_status='ready'
   GROUP BY publication.audio_revision, publication.lyrics_revision
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
 WHERE persona.account_id=$1 AND persona.persona_id=$2 AND persona.status='active'
   AND content.study_exercise_count >= 4
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
      "Participant preflight failed: exact fresh Very evidence, active membership/persona, and four current Study exercises are required.",
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
