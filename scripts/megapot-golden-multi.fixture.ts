import { type MultiGoldenInput, parseMultiGoldenInput } from "./megapot-golden-multi-input.ts";
import type { GoldenObservation } from "./megapot-golden-reconciliation.ts";

export const rehearsalTime = Date.parse("2026-09-21T10:00:00.000Z");
export const rehearsalInput = () =>
  parseMultiGoldenInput({
    object: "megapot_base_sepolia_golden_v2",
    run_id: "local-proof",
    community_id: "community",
    post_id: "song",
    persona_id: "sponsor",
    audio_revision: 1,
    lyrics_revision: 1,
    starts_at: "2026-09-21T09:59:00.000Z",
    ends_at: "2026-09-21T11:00:00.000Z",
    funding_amount_atomic: "1000",
    max_ticket_price_atomic: "100",
    entry_cutoff_seconds: 300,
    participants: [
      {
        key: "study",
        account_id: "study",
        persona_id: "study-persona",
        timezone: "UTC",
        credential_key: "STUDY",
        preflight_path: "/absent-study.json",
        activities: ["study"],
        expected_admission: "eligible",
        accepted_lyrics: "one\ntwo\nthree\nfour",
      },
      {
        key: "karaoke",
        account_id: "karaoke",
        persona_id: "karaoke-persona",
        timezone: "UTC",
        credential_key: "KARAOKE",
        preflight_path: "/absent-karaoke.json",
        activities: ["karaoke"],
        expected_admission: "eligible",
        karaoke_audio: {
          pcm_path: "/absent-vocals.pcm",
          sha256: "a".repeat(64),
          duration_ms: 500,
          source: "reviewed_participant_vocal_performance",
          consent_reference: "consent-test",
          allow_stored_retention: false,
        },
      },
      {
        key: "negative",
        account_id: "negative",
        persona_id: "negative-persona",
        timezone: "UTC",
        credential_key: "NEGATIVE",
        preflight_path: "/absent-negative.json",
        activities: ["study"],
        expected_admission: "verification_missing",
        accepted_lyrics: "one\ntwo\nthree\nfour",
      },
    ],
    authorization: {
      owner_approval_reference: "test-only",
      execution_starts_at: "2026-09-21T09:59:00.000Z",
      qualification_deadline: "2026-09-21T10:10:00.000Z",
      reconciliation_deadline: "2026-09-21T12:00:00.000Z",
      max_tickets: 1,
      max_gas_wei: "1",
      max_study_submissions: 8,
      max_karaoke_attempts: 1,
      max_provider_spend_atomic: "1",
      provider_budget_reference: "test-only",
      http_version: "http",
      jobs_version: "jobs",
      rollback_http_version: "rollback-http",
      rollback_jobs_version: "rollback-jobs",
      bootstrap_approval_reference: "test-only",
      enabled_window_approval_reference: "test-only",
    },
  });

export function onePalmRehearsalInput(): MultiGoldenInput {
  const base = rehearsalInput();
  const verified = base.participants[0];
  const karaoke = base.participants[1];
  const unverified = base.participants[2];
  if (!verified || !karaoke?.karaoke_audio || !unverified) throw new Error("fixture");
  return parseMultiGoldenInput({
    ...base,
    participants: [
      {
        ...verified,
        activities: ["study", "karaoke"],
        karaoke_audio: karaoke.karaoke_audio,
      },
      unverified,
    ],
  });
}

export function rehearsalObservation(
  input: MultiGoldenInput = rehearsalInput(),
): GoldenObservation {
  const positives = input.participants.filter((p) => p.expected_admission === "eligible");
  return {
    leg_id: "leg",
    drawing_id: "101",
    observed_at: new Date(rehearsalTime).toISOString(),
    community_id: input.community_id,
    post_id: input.post_id,
    audio_revision: 1,
    drawing_status: "no_win",
    entry_cutoff_at: "2026-09-21T10:20:00.000Z",
    funded_atomic: "1000",
    spent_atomic: "100",
    refunded_atomic: "900",
    reserved_atomic: "0",
    net_winnings_atomic: "0",
    ticket_count: 1,
    purchase_receipt_count: 1,
    unresolved_effect_count: 0,
    other_unresolved_drawings: 0,
    refund_receipt_atomic: "900",
    claim_receipt_atomic: "0",
    shares: positives.map((p) => ({ account_id: p.account_id, persona_id: p.persona_id })),
    qualifications: input.participants.flatMap((p) =>
      p.activities.map((activity_key) => ({
        account_id: p.account_id,
        persona_id: p.persona_id,
        activity_key,
      })),
    ),
    beneficiaries: positives.map((p, ordinal) => ({
      ordinal,
      account_id: p.account_id,
      persona_id: p.persona_id,
    })),
    // Mirrors migration 0134: an admitted account gets one decision, for its
    // first qualifying activity; a refused account gets one per qualification.
    decisions: input.participants.flatMap((p) =>
      (p.expected_admission === "eligible" ? p.activities.slice(0, 1) : p.activities).map(
        (activity_key) => ({
          account_id: p.account_id,
          persona_id: p.persona_id,
          activity_key,
          outcome: p.expected_admission === "eligible" ? "eligible" : "ineligible",
          reason: p.expected_admission === "eligible" ? null : "verification_missing",
        }),
      ),
    ),
    credits: [],
  };
}
