import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { generateClient } from "./codegen.ts";
import {
  GetSharedSongMegapotParticipationV2,
  SharedSongMegapotParticipationV2,
} from "./shared-song-megapot-participation.ts";

const hash = "a".repeat(64);
// Fictional decoding vectors, never a policy admission or financial configuration.
function fixture() {
  const bindings = ["study", "karaoke", "dance"].map((activity) => ({
    template_key: `test-template-${activity}`,
    activity,
    grading_family: activity === "dance" ? "moderator_verdict" : "numeric",
    qualification_policy_id: `test-policy-${activity}`,
    qualification_policy_hash: hash,
    numeric_floor_bps: activity === "dance" ? null : 8000,
    choreography_scope: activity === "dance" ? "any_policy_accepted" : "not_applicable",
    admission_id: `test-admission-${activity}`,
    admission_hash: hash,
    disclosure_version: "test-disclosure",
    binding_id: `test-binding-${activity}`,
    objective_id: `test-objective-${activity}`,
    offer_id: "test-offer",
    leg_id: "test-leg",
  }));
  const rules = bindings.map((binding) => ({
    binding,
    currently_available: true,
    rule:
      binding.activity === "study"
        ? {
            kind: "study_session_first_pass_v2",
            qualification_policy_version_id: binding.qualification_policy_id,
            required_correct_bps: 7000,
          }
        : binding.activity === "karaoke"
          ? {
              kind: "karaoke_qualification_v2",
              qualification_policy_version_id: binding.qualification_policy_id,
              minimum_scored_line_count: 5,
              minimum_coverage_bps: 8500,
              minimum_final_score_bps: 7000,
              eligible_playback_kinds: ["full_mix", "instrumental"],
            }
          : {
              kind: "dance_owner_verdict_v1",
              qualification_policy_version_id: binding.qualification_policy_id,
              grading_mode: "moderator_verdict",
              verdict: "passed",
            },
  }));
  return {
    object: "shared_song_megapot_participation",
    version: 2,
    as_of: "2026-10-22T12:00:00.000Z",
    target: {
      kind: "committed",
      community_id: "test-community",
      post_id: "test-song",
      canonical_song_id: "test-song",
      audio_revision: 1,
      offer_id: "test-offer",
      pool_leg_id: "test-leg",
    },
    terms: {
      version: "shared-song-megapot-v2",
      profile_id: "test-profile",
      profile_hash: hash,
      terms_hash: hash,
      funding_policy_revision: 1,
      funding_policy_hash: hash,
      budget_source: "leg_budget",
      empty_behavior: "no_purchase",
      eligible_activities: ["study", "karaoke", "dance"],
      dance_scope: "any_policy_accepted",
      starts_at: "2026-10-22T10:00:00.000Z",
      ends_at: "2026-10-25T17:00:00.000Z",
      first_drawing_id: "200",
      last_planned_drawing_id: "201",
      ticket_price_ceiling_atomic: "2000000",
      disclosure_version: "test-disclosure",
      origin_prospective_terms_hash: hash,
      origin_slot_generation: 0,
      reward_policy_hash: hash,
      qualification_bindings: bindings,
      qualification_bindings_hash: hash,
      planned_drawing_ids: ["200", "201"],
      planned_schedule_hash: hash,
    },
    chain_id: 84532,
    token_address: `0x${"1".repeat(40)}`,
    token_decimals: 6,
    offer_status: "active",
    leg_status: "active",
    confirmed_contributed_atomic: "10000000",
    remaining_budget_atomic: "8000000",
    participation_available: true,
    qualification_rules: rules,
    drawings: [
      {
        kind: "materialized",
        planned_drawing_id: "200",
        drawing_at: "2026-10-22T17:00:00.000Z",
        drawing: {
          object: "megapot_pool_drawing_projection",
          drawing_id: "200",
          lifecycle_status: "entry_open",
          state: "entry_open",
          entry_cutoff_at: "2026-10-22T16:55:00.000Z",
          beneficiary_count: 0,
          ticket_price_ceiling_atomic: "2000000",
          actual_ticket_cost_atomic: "0",
          gross_prize_pool_atomic: null,
          global_tickets_bought: null,
          prize_pool_observed_at: null,
          prize_pool_basis:
            "gross_observed_before_referral_win_share_terminal_last_observed_pre_rollover",
          global_tickets_basis: "drawing_wide_all_megapot_buyers",
          net_winnings_atomic: "0",
          commitment_reference: null,
          snapshot_hash: null,
          ticket_id: null,
          purchase_transaction_hash: null,
          claim_transaction_hash: null,
        },
        standing: { share_held: false, credit: null },
      },
      { kind: "not_open", planned_drawing_id: "201" },
    ],
  };
}
const decode = Schema.decodeUnknownSync(SharedSongMegapotParticipationV2, {
  onExcessProperty: "error",
});
const changed = (update: (value: ReturnType<typeof fixture>) => void) => {
  const value = fixture();
  update(value);
  return value;
};
function at<A>(values: readonly A[], index: number): A {
  const value = values[index];
  if (value === undefined) throw new Error("Missing fixture row");
  return value;
}
function materialized(value: ReturnType<typeof fixture>) {
  const entry = at(value.drawings, 0);
  const { drawing, standing, drawing_at } = entry;
  if (drawing === undefined || standing === undefined || drawing_at === undefined)
    throw new Error("Expected materialized fixture drawing");
  return { ...entry, drawing, standing, drawing_at };
}

describe("shared song participant contract", () => {
  test("supports all three frozen activities, a separate pool floor and an empty own standing", () => {
    const value = decode(fixture());
    expect(value.qualification_rules.map((row) => row.binding.activity)).toEqual([
      "study",
      "karaoke",
      "dance",
    ]);
    expect(value.qualification_rules[0]?.binding.numeric_floor_bps).toBe(8000);
    expect(value.drawings[1]).toEqual({ kind: "not_open", planned_drawing_id: "201" });
    expect(decode({ ...fixture(), chain_id: 8453 }).chain_id).toBe(8453);
  });
  test("keeps unavailable policies and a closed window readable without erasing funded terms", () => {
    const value = changed((value) => {
      value.participation_available = false;
      at(value.qualification_rules, 2).currently_available = false;
      materialized(value).drawing.state = "entry_closed";
      value.as_of = "2026-10-22T16:55:00.000Z";
    });
    expect(decode(value).terms.qualification_bindings).toHaveLength(3);
  });
  test.each(["activity", "policy", "binding", "target", "duplicate"])(
    "refuses a changed qualification %s",
    (kind) => {
      const value = fixture();
      const row = at(value.qualification_rules, 0);
      if (kind === "activity") row.rule.kind = "dance_owner_verdict_v1";
      if (kind === "policy") row.rule.qualification_policy_version_id = "foreign-policy";
      if (kind === "binding") row.binding = { ...row.binding, objective_id: "foreign-objective" };
      if (kind === "target") value.target.pool_leg_id = "foreign-leg";
      if (kind === "duplicate") value.qualification_rules[1] = row;
      expect(() => decode(value)).toThrow();
    },
  );
  test.each(["missing", "duplicate", "foreign", "reordered", "elapsed", "tuple", "share"])(
    "refuses %s drawing evidence",
    (kind) => {
      const value = fixture();
      if (kind === "missing") value.drawings.pop();
      if (kind === "duplicate") at(value.drawings, 1).planned_drawing_id = "200";
      if (kind === "foreign") materialized(value).drawing.drawing_id = "199";
      if (kind === "reordered") value.drawings.reverse();
      if (kind === "elapsed") value.as_of = "2026-10-22T16:55:00.000Z";
      if (kind === "tuple")
        Object.assign(materialized(value).drawing, { gross_prize_pool_atomic: "1000" });
      if (kind === "share") materialized(value).standing.share_held = true;
      expect(() => decode(value)).toThrow();
    },
  );
  test("rejects private contributor and wallet facts rather than silently dropping them", () => {
    for (const field of ["account_id", "wallet_address", "contributors", "provider_payload"]) {
      expect(() => decode({ ...fixture(), [field]: "private" })).toThrow();
    }
    expect(() => decode({ ...fixture(), token_decimals: 18 })).toThrow();
  });
  test("retains a credited earlier drawing when a newer one is open", () => {
    const value = fixture();
    const previous = materialized(value);
    Object.assign(previous.drawing, {
      lifecycle_status: "credited",
      state: "won",
      beneficiary_count: 10,
      actual_ticket_cost_atomic: "1000000",
      net_winnings_atomic: "1110000",
    });
    const credit = {
      credit_id: "test-credit",
      amount_atomic: "111000",
      state: "credited",
      claim: { status: "unclaimed", payout_status: null },
    };
    Object.assign(previous.standing, { share_held: true, credit });
    value.as_of = "2026-10-22T18:00:00.000Z";
    const next = materialized(fixture());
    next.planned_drawing_id = "201";
    next.drawing.drawing_id = "201";
    next.drawing.entry_cutoff_at = "2026-10-23T16:55:00.000Z";
    next.drawing_at = "2026-10-23T17:00:00.000Z";
    value.drawings[1] = next;
    const decoded = decode(value);
    const decodedPrevious = at(decoded.drawings, 0);
    expect(decodedPrevious.kind).toBe("materialized");
    if (decodedPrevious.kind !== "materialized") throw new Error("Expected previous drawing");
    expect(decodedPrevious.standing.credit?.amount_atomic).toBe("111000");
    // A zero or unbacked amount cannot create a claimable credit.
    credit.amount_atomic = "0";
    expect(() => decode(value)).toThrow();
  });
  test("is a separate browser-session private read with a declared disabled-service error", () => {
    const endpoint = GetSharedSongMegapotParticipationV2;
    expect(endpoint.method).toBe("GET");
    expect(endpoint.auth.browserSessionOnly).toBe(true);
    expect(endpoint.cacheControl).toBe("private, no-store");
    const generated = generateClient({ GetSharedSongMegapotParticipationV2: endpoint });
    expect(generated).toContain("get_communitiesCommunityIdPostsPostIdMegapotParticipation");
    expect(generated).toContain("provider_unavailable");
    expect(Schema.decodeUnknownSync(endpoint.response)(null)).toBeNull();
  });
});
