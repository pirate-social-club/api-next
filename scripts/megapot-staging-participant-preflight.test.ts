import { describe, expect, test } from "bun:test";

import { megapotParticipantPreflightSql } from "./megapot-staging-participant-preflight.ts";

describe("Megapot staging participant preflight", () => {
  test("copies the reward trigger's exact Very witness and freshness predicate", () => {
    for (const fragment of [
      "subject.issuer='https://verify.very.org'",
      "subject.method='palm_web'",
      "subject.scope_kind='issuer_rp_scope'",
      "subject.issuer_rp_scope='pirate-social'",
      "binding.binding_mode='same_subject'",
      "personhood.claim_id='human.personhood'",
      `personhood.assertion_value='{"personhood": true}'::jsonb`,
      "subject_unique.claim_id='credential.subject_unique'",
      `subject_unique.assertion_value='{"subject_unique": true}'::jsonb`,
      "receipt.provider_id='very.web'",
      "receipt.protocol_version='very-web-v1'",
      "receipt.evidence_kind='very.web.server-verified.v1'",
      "receipt.provenance_kind='proof_session'",
      "session.status='completed'",
      "session.completed_at=session.terminal_at",
      "event.outcome",
      "), 'accepted')='accepted'",
      "evidence.evidence_count=1",
    ]) {
      expect(megapotParticipantPreflightSql).toContain(fragment);
    }
  });

  test("also fences persona, membership, and exact current Study revisions", () => {
    for (const fragment of [
      "persona.status='active'",
      "membership.status='member'",
      "submission.audio_revision=publication.audio_revision",
      "submission.current_lyrics_revision=publication.lyrics_revision",
      "exercise.audio_revision=publication.audio_revision",
      "exercise.lyrics_revision=publication.lyrics_revision",
      "exercise.exercise_type='say_it_back'",
      "exercise.retired_at IS NULL",
      "review.account_id=$1",
      "review.study_unit_id=exercise.study_unit_id",
      "review.exercise_kind=exercise.exercise_type",
      "review.lifecycle_status='active'",
      "review.review_item_id IS NULL OR review.due_at <= clock_timestamp()",
      "content.study_exercise_count >= 4",
      "active_study_session.session_id AS study_session_id",
      "session.status='active'",
      "session.expires_at > clock_timestamp()",
      "count(DISTINCT item.session_item_id) >= 4",
      "content.study_due_exercise_count >= 4 OR active_study_session.session_id IS NOT NULL",
    ]) {
      expect(megapotParticipantPreflightSql).toContain(fragment);
    }
  });
});
