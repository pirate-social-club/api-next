import { Effect, Schema } from "effect";
import { digestFundingPreimageV2 } from "../../application/src/rewards/song-megapot-contributions.ts";
import { canonicalBodyHash } from "../../application/src/use-cases/content/common.ts";
import {
  committedTermsPreimageV2,
  fundingHashPreimageV2,
  projectQualificationBinding,
  TermsV2,
} from "../../contracts/src/rewards-song-contributions-v2.ts";
import { participantProjectionFixture } from "../../contracts/src/shared-song-megapot-participation.fixtures.ts";

/** Hash-valid fictional packet shared by decoder and isolated SQL tests.
 * It grants no policy admission and creates no provider or chain effect. */
export async function sharedSongParticipantFixture(asOf?: Date, noPoseDance = false) {
  const source = participantProjectionFixture();
  if (asOf !== undefined) {
    const offset = asOf.getTime() - Date.parse(source.as_of);
    const move = (date: string) => new Date(Date.parse(date) + offset).toISOString();
    source.as_of = asOf.toISOString();
    source.terms.starts_at = move(source.terms.starts_at);
    source.terms.ends_at = move(source.terms.ends_at);
    for (const drawing of source.drawings) {
      if (
        drawing.kind === "materialized" &&
        drawing.drawing !== undefined &&
        drawing.drawing_at !== undefined
      ) {
        drawing.drawing_at = move(drawing.drawing_at);
        drawing.drawing.entry_cutoff_at = move(drawing.drawing.entry_cutoff_at);
      }
    }
  }
  const documents = [];
  for (const binding of source.terms.qualification_bindings) {
    const kind =
      binding.activity === "study"
        ? "study_session_first_pass_v2"
        : binding.activity === "karaoke"
          ? "karaoke_qualification_v2"
          : "dance_owner_verdict_v1";
    const body: Record<string, unknown> =
      binding.activity === "study"
        ? { required_correct_bps: 7000 }
        : binding.activity === "karaoke"
          ? {
              minimum_scored_line_count: 5,
              minimum_coverage_bps: 8500,
              minimum_final_score_bps: 7000,
              eligible_playback_kinds: ["full_mix", "instrumental"],
            }
          : {
              grading_mode: "moderator_verdict",
              verdict: "passed",
              score_bps: null,
              calibration: null,
              numeric_floor_bps: null,
              ...(noPoseDance ? { opening_pose: "not_required" } : {}),
              producer_id: "test-producer",
              admission: "money_admitted",
              admission_version: binding.admission_id,
              admission_hash: binding.admission_hash,
            };
    const hash = await Effect.runPromise(
      canonicalBodyHash([
        "pirate.shared-song-qualification-policy.v1",
        binding.qualification_policy_id,
        binding.activity,
        kind,
        body,
      ]),
    );
    binding.qualification_policy_hash = hash;
    documents.push({
      binding_id: binding.binding_id,
      policy_id: binding.qualification_policy_id,
      activity: binding.activity,
      kind,
      policy_hash: hash,
      document: binding.activity === "dance" ? { ...body, policy_hash: hash } : body,
      currently_available: true,
    });
  }
  const bindingsHash = await Effect.runPromise(
    digestFundingPreimageV2(
      fundingHashPreimageV2(
        "pirate.shared-song-qualification-bindings.v1",
        Schema.decodeUnknownSync(TermsV2)(source.terms).qualification_bindings.map(
          projectQualificationBinding,
        ),
      ),
    ),
  );
  source.terms.qualification_bindings_hash = bindingsHash;
  source.terms.terms_hash = await Effect.runPromise(
    digestFundingPreimageV2(
      committedTermsPreimageV2(Schema.decodeUnknownSync(TermsV2)(source.terms)),
    ),
  );
  return {
    projection: { ...source, qualification_rules: [] },
    qualification_documents: documents,
  };
}
