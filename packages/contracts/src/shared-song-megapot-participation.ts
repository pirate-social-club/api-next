import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { endpoint } from "./endpoint.ts";
import { AuthError, InternalError, NotFound, ProviderUnavailable } from "./errors.ts";
import {
  KaraokeQualificationPolicyV1,
  KaraokeQualificationPolicyV2,
  StudyQualificationPolicyV1,
} from "./rewards-qualification.ts";
import {
  AddressV2,
  AtomicV2,
  ChainV2,
  CommittedTargetV2,
  IdV2,
  InstantV2,
  projectQualificationBinding,
  QualificationBindingV2,
  TermsV2,
  UIntV2,
} from "./rewards-song-contributions-v2.ts";
import {
  MegapotPoolDrawingProjectionV1,
  MegapotPoolLegStatusV1,
  RewardCreditClaimV1,
  RewardCreditStateV1,
  SongRewardOfferStatusV1,
} from "./rewards-song-offers.ts";

const DanceParticipantRuleV2 = Schema.Struct({
  kind: Schema.Literal("dance_owner_verdict_v1"),
  qualification_policy_version_id: IdV2,
  grading_mode: Schema.Literal("moderator_verdict"),
  verdict: Schema.Literal("passed"),
});

/** Frozen qualification rules and the separate pool floor are both visible.
 * Current availability never rewrites the funded policy or its history. */
export const SharedSongParticipantRuleV2 = Schema.Struct({
  binding: QualificationBindingV2,
  rule: Schema.Union([
    StudyQualificationPolicyV1,
    KaraokeQualificationPolicyV1,
    KaraokeQualificationPolicyV2,
    DanceParticipantRuleV2,
  ]),
  currently_available: Schema.Boolean,
}).check(
  Schema.makeFilter(({ binding, rule }) => {
    if (binding.qualification_policy_id !== rule.qualification_policy_version_id)
      return "Qualification disclosure changed its immutable policy";
    if (
      (binding.activity === "study" && rule.kind !== "study_session_first_pass_v2") ||
      (binding.activity === "karaoke" &&
        rule.kind !== "karaoke_qualification_v1" &&
        rule.kind !== "karaoke_qualification_v2") ||
      (binding.activity === "dance" && rule.kind !== "dance_owner_verdict_v1")
    )
      return "Qualification disclosure changed its activity";
    return undefined;
  }),
);
export type SharedSongParticipantRuleV2 = typeof SharedSongParticipantRuleV2.Type;

/** An amount exists only after the participant's allocation has a confirmed
 * credit. Missing evidence is pending, never a fabricated zero or Claim. */
export const SharedSongParticipantCreditV2 = Schema.Struct({
  credit_id: IdV2,
  amount_atomic: AtomicV2,
  state: RewardCreditStateV1,
  claim: RewardCreditClaimV1,
});
export type SharedSongParticipantCreditV2 = typeof SharedSongParticipantCreditV2.Type;

export const SharedSongParticipantStandingV2 = Schema.Struct({
  share_held: Schema.Boolean,
  credit: Schema.NullOr(SharedSongParticipantCreditV2),
}).check(
  Schema.makeFilter((value) =>
    value.credit !== null && !value.share_held
      ? "A participant credit requires the account's exact drawing share"
      : undefined,
  ),
);
export type SharedSongParticipantStandingV2 = typeof SharedSongParticipantStandingV2.Type;

const MaterializedDrawingV2 = Schema.Struct({
  kind: Schema.Literal("materialized"),
  planned_drawing_id: UIntV2,
  drawing_at: InstantV2,
  drawing: MegapotPoolDrawingProjectionV1,
  standing: SharedSongParticipantStandingV2,
}).check(
  Schema.makeFilter((value) => {
    if (value.planned_drawing_id !== value.drawing.drawing_id)
      return "Drawing changed its planned identity";
    if (Date.parse(value.drawing_at) <= Date.parse(value.drawing.entry_cutoff_at))
      return "Drawing must follow its safe entry cutoff";
    const drawing = value.drawing;
    if (
      (drawing.gross_prize_pool_atomic === null) !== (drawing.global_tickets_bought === null) ||
      (drawing.gross_prize_pool_atomic === null) !== (drawing.prize_pool_observed_at === null)
    )
      return "Observed prize pool facts must be one tuple";
    if (value.standing.share_held && drawing.beneficiary_count === 0)
      return "A held share requires a beneficiary";
    if (
      value.standing.credit !== null &&
      (!["allocated", "credited"].includes(drawing.lifecycle_status) ||
        BigInt(value.standing.credit.amount_atomic) > BigInt(drawing.net_winnings_atomic))
    )
      return "A participant amount requires allocated net winnings";
    return undefined;
  }),
);

/** A planned ID without an actual drawing has no invented time or result. */
export const SharedSongParticipantDrawingV2 = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("not_open"), planned_drawing_id: UIntV2 }),
  MaterializedDrawingV2,
]);
export type SharedSongParticipantDrawingV2 = typeof SharedSongParticipantDrawingV2.Type;

export const SharedSongMegapotParticipationV2 = Schema.Struct({
  object: Schema.Literal("shared_song_megapot_participation"),
  version: Schema.Literal(2),
  as_of: InstantV2,
  target: CommittedTargetV2,
  terms: TermsV2,
  chain_id: ChainV2,
  token_address: AddressV2,
  token_decimals: Schema.Literal(6),
  offer_status: SongRewardOfferStatusV1,
  leg_status: MegapotPoolLegStatusV1,
  confirmed_contributed_atomic: UIntV2,
  remaining_budget_atomic: UIntV2,
  participation_available: Schema.Boolean,
  qualification_rules: Schema.Array(SharedSongParticipantRuleV2).check(
    Schema.isMinLength(3),
    Schema.isMaxLength(3),
  ),
  drawings: Schema.Array(SharedSongParticipantDrawingV2).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(30),
  ),
}).check(
  Schema.makeFilter((value) => {
    const { target, terms } = value;
    const ids = terms.planned_drawing_ids;
    if (
      new Set(ids).size !== ids.length ||
      ids[0] !== terms.first_drawing_id ||
      ids.at(-1) !== terms.last_planned_drawing_id ||
      ids.some((id, i) => {
        const previous = ids[i - 1];
        return previous !== undefined && BigInt(id) <= BigInt(previous);
      }) ||
      value.drawings.length !== ids.length ||
      value.drawings.some((drawing, i) => drawing.planned_drawing_id !== ids[i])
    )
      return "Drawing history must cover the exact immutable plan";
    if (
      terms.qualification_bindings.some(
        (binding) => binding.offer_id !== target.offer_id || binding.leg_id !== target.pool_leg_id,
      ) ||
      value.qualification_rules.some(
        (rule) =>
          !terms.qualification_bindings.some(
            (binding) =>
              JSON.stringify(projectQualificationBinding(binding)) ===
              JSON.stringify(projectQualificationBinding(rule.binding)),
          ),
      ) ||
      new Set(value.qualification_rules.map((rule) => rule.binding.activity)).size !== 3
    )
      return "Participant disclosures must bind every exact funded objective";
    if (
      value.drawings.some(
        (drawing) =>
          drawing.kind === "materialized" &&
          drawing.drawing.state === "entry_open" &&
          Date.parse(drawing.drawing.entry_cutoff_at) <= Date.parse(value.as_of),
      )
    )
      return "An elapsed safe cutoff cannot advertise open entry";
    return undefined;
  }),
);
export type SharedSongMegapotParticipationV2 = typeof SharedSongMegapotParticipationV2.Type;

export const GetSharedSongMegapotParticipationV2 = endpoint({
  method: "GET",
  path: "/communities/:communityId/posts/:postId/megapot-participation",
  auth: Auth.user({ browserSessionOnly: true }),
  cacheControl: "private, no-store",
  request: { path: Schema.Struct({ communityId: IdV2, postId: IdV2 }) },
  response: Schema.NullOr(SharedSongMegapotParticipationV2),
  errors: [AuthError, NotFound, ProviderUnavailable, InternalError],
});
