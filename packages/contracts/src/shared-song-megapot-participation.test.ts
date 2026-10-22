import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { generateClient } from "./codegen.ts";
import { participantProjectionFixture as fixture } from "./shared-song-megapot-participation.fixtures.ts";
import {
  GetSharedSongMegapotParticipationV2,
  SharedSongMegapotParticipationV2,
} from "./shared-song-megapot-participation.ts";

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
