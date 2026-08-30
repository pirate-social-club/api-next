import type { StudySessionV2 } from "@pirate/contracts";
import { Schema } from "effect";

const Identifier = Schema.NonEmptyString.check(Schema.isMaxLength(128));
const EvidenceIdentifier = Schema.NonEmptyString.check(Schema.isMaxLength(512));
const CanonicalInstant = Schema.String.check(
  Schema.makeFilter((value) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
      ? undefined
      : "Expected a canonical ISO instant";
  }),
);

const ParticipantPreflight = Schema.Struct({
  object: Schema.Literal("megapot_participant_preflight_v1"),
  checked_at: CanonicalInstant,
  valid_until: CanonicalInstant,
  account_id: Identifier,
  persona_id: Identifier,
  community_id: Identifier,
  post_id: Identifier,
  membership_id: EvidenceIdentifier,
  audio_revision: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  ),
  lyrics_revision: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  ),
  study_exercise_count: Schema.Int.check(
    Schema.isBetween({ minimum: 4, maximum: Number.MAX_SAFE_INTEGER }),
  ),
  study_due_exercise_count: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  ),
  subject_key_id: EvidenceIdentifier,
  binding_event_id: EvidenceIdentifier,
  binding_epoch: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  ),
  binding_group_id: EvidenceIdentifier,
  evidence_receipt_id: EvidenceIdentifier,
  evidence_hash: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  personhood_assertion_id: EvidenceIdentifier,
  subject_unique_assertion_id: EvidenceIdentifier,
  evidence_expires_at: Schema.NullOr(CanonicalInstant),
  study_session_id: Schema.optional(Schema.NullOr(Identifier)),
});

export type MegapotParticipantPreflight = Schema.Schema.Type<typeof ParticipantPreflight>;

export function parseMegapotParticipantPreflight(value: unknown): MegapotParticipantPreflight {
  return Schema.decodeUnknownSync(ParticipantPreflight, { onExcessProperty: "error" })(value);
}

export function participantPreflightMatches(
  artifact: MegapotParticipantPreflight | undefined,
  input: {
    readonly accountId: string;
    readonly personaId: string;
    readonly communityId: string;
    readonly postId: string;
  },
  now: Date,
): artifact is MegapotParticipantPreflight {
  const timestamp = now.getTime();
  return (
    artifact !== undefined &&
    Date.parse(artifact.checked_at) <= timestamp &&
    Date.parse(artifact.valid_until) > timestamp &&
    Date.parse(artifact.valid_until) - Date.parse(artifact.checked_at) <= 10 * 60_000 &&
    artifact.account_id === input.accountId &&
    artifact.persona_id === input.personaId &&
    artifact.community_id === input.communityId &&
    artifact.post_id === input.postId &&
    (artifact.study_due_exercise_count >= 4 || artifact.study_session_id != null)
  );
}

export function studySessionMatchesParticipantPreflight(
  session: StudySessionV2,
  artifact: MegapotParticipantPreflight,
): boolean {
  return (
    session.community_id === artifact.community_id &&
    session.post_id === artifact.post_id &&
    session.persona_id === artifact.persona_id &&
    session.audio_revision === artifact.audio_revision &&
    session.lyrics_revision === artifact.lyrics_revision &&
    session.items.length >= 4 &&
    session.items.every(
      (item) =>
        item.line.audio_revision === artifact.audio_revision &&
        item.line.lyrics_revision === artifact.lyrics_revision,
    )
  );
}
