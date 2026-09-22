import { expect, test } from "bun:test";
import { rehearsalInput, rehearsalTime } from "./megapot-golden-multi.fixture.ts";
import { assembleGoldenPreflight } from "./megapot-golden-preflight-v2.ts";

test("v2 collector formats current witnesses and refuses invented eligibility or unreviewed ceremonies", () => {
  const input = rehearsalInput();
  const participant = input.participants[0];
  const negative = input.participants[2];
  if (!participant || !negative) throw new Error("fixture");
  const identity = {
    assignment_id: "wallet",
    address: `0x${"a".repeat(40)}`,
    evidence: [
      {
        subject_key_id: "subject",
        binding_event_id: "binding",
        binding_group_id: "group",
        binding_epoch: 1,
        evidence_receipt_id: "receipt",
        proof_session_id: "proof-session",
        evidence_hash: "a".repeat(64),
        personhood_assertion_id: "personhood",
        subject_unique_assertion_id: "unique",
        evidence_expires_at: null,
      },
    ],
  };
  const content = { audio_revision: 1, lyrics_revision: 1, study_exercise_count: 4 };
  expect(
    assembleGoldenPreflight(
      input,
      participant,
      identity,
      content,
      null,
      "reviewed-real-ceremony",
      rehearsalTime,
    ),
  ).toMatchObject({
    object: "megapot_participant_preflight_v2",
    verification_state: "eligible",
    very_evidence: [
      { proof_session_id: "proof-session", ceremony_reference: "reviewed-real-ceremony" },
    ],
  });
  expect(() =>
    assembleGoldenPreflight(input, participant, identity, content, null, undefined, rehearsalTime),
  ).toThrow("ceremony");
  expect(() =>
    assembleGoldenPreflight(
      input,
      negative,
      identity,
      content,
      null,
      "reviewed-real-ceremony",
      rehearsalTime,
    ),
  ).toThrow("preflight");
  expect(
    assembleGoldenPreflight(
      input,
      negative,
      { ...identity, evidence: [] },
      content,
      null,
      undefined,
      rehearsalTime,
    ),
  ).toMatchObject({ verification_state: "verification_missing", very_evidence: [] });
  expect(() =>
    assembleGoldenPreflight(
      input,
      participant,
      identity,
      { ...content, audio_revision: 2 },
      null,
      "reviewed-real-ceremony",
      rehearsalTime,
    ),
  ).toThrow("preflight");
});
