import { describe, expect, test } from "bun:test";
import {
  applySpacesCapChangeV1,
  reduceSpacesIssuanceV1,
  type SpacesIssuanceDecisionV1,
  type SpacesIssuanceEventV1,
  type SpacesIssuanceStateV1,
  type SpacesUpstreamAckOutcomeV1,
  spacesAccountCapAdmitsV1,
  spacesClaimDelayedV1,
  submitSpacesClaimV1,
  tallySpacesAccountCapV1,
} from "./spaces-native-issuance.ts";

const OUTCOMES: readonly SpacesUpstreamAckOutcomeV1[] = [
  "staged",
  "already_staged_same_spk",
  "already_committed_same_spk",
  "already_staged_different_spk",
  "already_committed_different_spk",
  "invalid",
];
const SAME = new Set<SpacesUpstreamAckOutcomeV1>([
  "staged",
  "already_staged_same_spk",
  "already_committed_same_spk",
]);
const DIFFERENT = new Set<SpacesUpstreamAckOutcomeV1>([
  "already_staged_different_spk",
  "already_committed_different_spk",
]);

const submitted = (() => {
  const result = submitSpacesClaimV1({
    max_active_grants_per_account: 1,
    counter: { active_grant_count: 0, pending_issuance_count: 0 },
  });
  if (result.kind !== "accepted") throw new Error("submission refused");
  return result.state;
})();
const pending = (item: SpacesIssuanceStateV1["item"]): SpacesIssuanceStateV1 => ({
  ...submitted,
  item,
});
const ack = (
  outcome: SpacesUpstreamAckOutcomeV1,
  unresolved = false,
): Extract<SpacesIssuanceEventV1, { kind: "acknowledged" }> => ({
  kind: "acknowledged",
  outcome,
  unresolved_delivery_of_key_remains: unresolved,
});
const next = (decision: SpacesIssuanceDecisionV1): SpacesIssuanceStateV1 => {
  if (decision.kind !== "applied") throw new Error(`expected applied, got ${decision.kind}`);
  return decision.next;
};
const run = (state: SpacesIssuanceStateV1, ...events: SpacesIssuanceEventV1[]) =>
  events.reduce((current, event) => next(reduceSpacesIssuanceV1(current, event)), state);

describe("Spaces claim submission", () => {
  test("starts pending with an undelivered item, a pending fence, and a reserved slot", () => {
    expect(
      submitSpacesClaimV1({
        max_active_grants_per_account: 1,
        counter: { active_grant_count: 0, pending_issuance_count: 0 },
      }),
    ).toEqual({
      kind: "accepted",
      state: {
        claim: "issuance_pending",
        item: "undelivered",
        fence: "pending_issuance",
        cap: "reserved",
        verification_due: false,
      },
      counter: { active_grant_count: 0, pending_issuance_count: 1 },
    });
  });
});

describe("upstream acknowledgments against each registry item state", () => {
  test("an item no response included is never acknowledged", () => {
    for (const outcome of OUTCOMES) {
      expect(reduceSpacesIssuanceV1(pending("undelivered"), ack(outcome))).toEqual({
        kind: "scope_anomaly",
        reason: "no_delivered_item",
      });
      const withdrawn = run(submitted, { kind: "platform_stop" });
      expect(reduceSpacesIssuanceV1(withdrawn, ack(outcome))).toEqual({
        kind: "scope_anomaly",
        reason: "no_delivered_item",
      });
    }
  });

  test("a delivered or stopped item settles by outcome", () => {
    for (const item of ["delivered", "redelivery_stopped"] as const) {
      for (const outcome of OUTCOMES) {
        const decision = reduceSpacesIssuanceV1(pending(item), ack(outcome));
        if (SAME.has(outcome)) {
          expect(decision, `${item}:${outcome}`).toEqual({
            kind: "applied",
            next: { ...pending(item), item: "settled_same_spk", verification_due: true },
            cap_change: null,
            grant_status: null,
            alert: null,
          });
        } else if (DIFFERENT.has(outcome)) {
          expect(decision, `${item}:${outcome}`).toEqual({
            kind: "applied",
            next: {
              claim: "issuance_failed",
              item: "settled_different_spk",
              fence: "external_conflict",
              cap: "released",
              verification_due: false,
            },
            cap_change: "release",
            grant_status: null,
            alert: null,
          });
        } else {
          expect(decision, `${item}:${outcome}`).toEqual({
            kind: "applied",
            next: {
              claim: "issuance_failed",
              item: "settled_invalid",
              fence: "released",
              cap: "released",
              verification_due: false,
            },
            cap_change: "release",
            grant_status: null,
            alert: "invalid_outcome",
          });
        }
      }
    }
  });

  test("a settled item accepts only an idempotent replay of its own outcome class", () => {
    const settled = {
      settled_same_spk: run(pending("delivered"), ack("staged")),
      settled_different_spk: run(pending("delivered"), ack("already_staged_different_spk")),
      settled_invalid: run(pending("delivered"), ack("invalid")),
    };
    const agrees = {
      settled_same_spk: SAME,
      settled_different_spk: DIFFERENT,
      settled_invalid: new Set<SpacesUpstreamAckOutcomeV1>(["invalid"]),
    };
    for (const [item, state] of Object.entries(settled) as [
      keyof typeof settled,
      SpacesIssuanceStateV1,
    ][]) {
      expect(state.item).toBe(item);
      for (const outcome of OUTCOMES) {
        expect(reduceSpacesIssuanceV1(state, ack(outcome)), `${item}:${outcome}`).toEqual(
          agrees[item].has(outcome)
            ? { kind: "unchanged" }
            : { kind: "scope_anomaly", reason: "contradicts_recorded_outcome" },
        );
      }
    }
  });

  test("an invalid outcome keeps the fence while another delivery of the key is unresolved", () => {
    const held = run(pending("delivered"), ack("invalid", true));
    expect(held).toEqual({
      claim: "issuance_failed",
      item: "settled_invalid",
      fence: "pending_issuance",
      cap: "released",
      verification_due: false,
    });
    expect(run(held, { kind: "key_deliveries_resolved" }).fence).toBe("released");
    expect(reduceSpacesIssuanceV1(submitted, { kind: "key_deliveries_resolved" })).toEqual({
      kind: "unchanged",
    });
  });

  test("a late acknowledgment never regresses an issued claim", () => {
    const issued = run(pending("delivered"), {
      kind: "final_issuance_verified",
      owner_persona_retired: false,
    });
    expect(issued.item).toBe("redelivery_stopped");
    for (const outcome of OUTCOMES) {
      const decision = reduceSpacesIssuanceV1(issued, ack(outcome));
      expect(decision, outcome).toEqual(
        SAME.has(outcome)
          ? {
              kind: "applied",
              next: { ...issued, item: "settled_same_spk" },
              cap_change: null,
              grant_status: null,
              alert: null,
            }
          : { kind: "scope_anomaly", reason: "contradicts_recorded_outcome" },
      );
    }
  });
});

describe("Spaces claim transitions", () => {
  test("delivery happens only while the claim is pending and unsettled", () => {
    expect(run(submitted, { kind: "delivery_recorded" }).item).toBe("delivered");
    expect(run(submitted, { kind: "delivery_recorded" }, { kind: "delivery_recorded" }).item).toBe(
      "delivered",
    );
    for (const state of [
      run(pending("delivered"), ack("staged")),
      run(pending("delivered"), { kind: "platform_stop" }),
      run(submitted, { kind: "platform_stop" }),
    ]) {
      expect(reduceSpacesIssuanceV1(state, { kind: "delivery_recorded" })).toEqual({
        kind: "refused",
        reason: "not_deliverable",
      });
    }
  });

  test("a commit hint schedules verification and never creates a grant", () => {
    expect(reduceSpacesIssuanceV1(submitted, { kind: "committed_hint" })).toEqual({
      kind: "scope_anomaly",
      reason: "no_delivered_item",
    });
    expect(reduceSpacesIssuanceV1(pending("delivered"), { kind: "committed_hint" })).toEqual({
      kind: "applied",
      next: { ...pending("delivered"), verification_due: true },
      cap_change: null,
      grant_status: null,
      alert: null,
    });
    const staged = run(pending("delivered"), ack("staged"));
    expect(reduceSpacesIssuanceV1(staged, { kind: "committed_hint" })).toEqual({
      kind: "unchanged",
    });
  });

  test("final verification issues exactly once, with or without an acknowledgment", () => {
    const final = { kind: "final_issuance_verified", owner_persona_retired: false } as const;
    for (const state of [
      submitted,
      pending("delivered"),
      run(pending("delivered"), ack("staged")),
    ]) {
      const decision = reduceSpacesIssuanceV1(state, final);
      expect(decision).toMatchObject({
        kind: "applied",
        next: {
          claim: "issued",
          fence: "permanent_grant",
          cap: "converted_to_grant",
          verification_due: false,
        },
        cap_change: "convert_to_active_grant",
        grant_status: "active",
      });
      expect(reduceSpacesIssuanceV1(next(decision), final)).toEqual({ kind: "unchanged" });
    }
    expect(next(reduceSpacesIssuanceV1(submitted, final)).item).toBe("withdrawn");
    const failed = run(pending("delivered"), ack("already_committed_different_spk"));
    expect(reduceSpacesIssuanceV1(failed, final)).toEqual({
      kind: "refused",
      reason: "claim_terminal",
    });
  });

  test("a persona retired while pending gets its grant created and tombstoned together", () => {
    expect(
      reduceSpacesIssuanceV1(run(pending("delivered"), ack("staged")), {
        kind: "final_issuance_verified",
        owner_persona_retired: true,
      }),
    ).toMatchObject({
      kind: "applied",
      next: { claim: "issued", fence: "permanent_grant", cap: "converted_to_grant" },
      cap_change: "convert_to_tombstoned_grant",
      grant_status: "tombstoned",
    });
  });

  test("a stop before any possible delivery withdraws and releases", () => {
    expect(reduceSpacesIssuanceV1(submitted, { kind: "platform_stop" })).toEqual({
      kind: "applied",
      next: {
        claim: "issuance_failed",
        item: "withdrawn",
        fence: "released",
        cap: "released",
        verification_due: false,
      },
      cap_change: "release",
      grant_status: null,
      alert: null,
    });
  });

  test("a stop after possible delivery only stops redelivery", () => {
    const stopped = run(pending("delivered"), { kind: "platform_stop" });
    expect(stopped).toEqual({
      claim: "issuance_pending",
      item: "redelivery_stopped",
      fence: "pending_issuance",
      cap: "reserved",
      verification_due: false,
    });
    expect(reduceSpacesIssuanceV1(stopped, { kind: "platform_stop" })).toEqual({
      kind: "unchanged",
    });
    const staged = run(pending("delivered"), ack("staged"));
    expect(reduceSpacesIssuanceV1(staged, { kind: "platform_stop" })).toEqual({
      kind: "unchanged",
    });
    // Upstream work still resolves the stopped claim either way.
    expect(
      run(stopped, ack("staged"), { kind: "final_issuance_verified", owner_persona_retired: false })
        .claim,
    ).toBe("issued");
    expect(run(stopped, ack("already_staged_different_spk")).fence).toBe("external_conflict");
    const issued = run(submitted, {
      kind: "final_issuance_verified",
      owner_persona_retired: false,
    });
    expect(reduceSpacesIssuanceV1(issued, { kind: "platform_stop" })).toEqual({
      kind: "unchanged",
    });
  });
});

describe("Spaces account caps", () => {
  test("a pending claim occupies a slot for every persona of the account", () => {
    const personaA = submitSpacesClaimV1({
      max_active_grants_per_account: 1,
      counter: { active_grant_count: 0, pending_issuance_count: 0 },
    });
    if (personaA.kind !== "accepted") throw new Error("persona A refused");
    expect(
      submitSpacesClaimV1({ max_active_grants_per_account: 1, counter: personaA.counter }),
    ).toEqual({ kind: "refused", reason: "account_grant_limit_reached" });
    expect(
      submitSpacesClaimV1({ max_active_grants_per_account: 2, counter: personaA.counter }).kind,
    ).toBe("accepted");
    expect(
      submitSpacesClaimV1({ max_active_grants_per_account: null, counter: personaA.counter }).kind,
    ).toBe("accepted");
  });

  test("counts pending claims and active grants across sibling personas only", () => {
    const record = (
      overrides: Partial<Parameters<typeof tallySpacesAccountCapV1>[0]["records"][number]>,
    ) => ({
      account_id: "account_01",
      owner_persona_id: "persona_a",
      offering_id: "offering_spaces_free_01",
      claim: "issuance_pending" as const,
      grant_status: null,
      ...overrides,
    });
    const counter = tallySpacesAccountCapV1({
      account_id: "account_01",
      offering_id: "offering_spaces_free_01",
      records: [
        record({}),
        record({ owner_persona_id: "persona_b", claim: "issued", grant_status: "active" }),
        record({ owner_persona_id: "persona_c", claim: "issued", grant_status: "tombstoned" }),
        record({ owner_persona_id: "persona_c", claim: "issuance_failed" }),
        record({ account_id: "account_02" }),
        record({ offering_id: "offering_other" }),
      ],
    });
    expect(counter).toEqual({ active_grant_count: 1, pending_issuance_count: 1 });
    expect(spacesAccountCapAdmitsV1(2, counter)).toBe(false);
    expect(spacesAccountCapAdmitsV1(3, counter)).toBe(true);
  });

  test("converts or releases each reservation exactly once", () => {
    const reserved = { active_grant_count: 0, pending_issuance_count: 1 };
    expect(applySpacesCapChangeV1(reserved, "convert_to_active_grant")).toEqual({
      active_grant_count: 1,
      pending_issuance_count: 0,
    });
    expect(applySpacesCapChangeV1(reserved, "convert_to_tombstoned_grant")).toEqual({
      active_grant_count: 0,
      pending_issuance_count: 0,
    });
    expect(applySpacesCapChangeV1(reserved, "release")).toEqual({
      active_grant_count: 0,
      pending_issuance_count: 0,
    });
    expect(() =>
      applySpacesCapChangeV1({ active_grant_count: 1, pending_issuance_count: 0 }, "release"),
    ).toThrow("No pending issuance reservation");
    const issued = applySpacesCapChangeV1(reserved, "convert_to_active_grant");
    expect(spacesAccountCapAdmitsV1(1, issued)).toBe(false);
  });
});

describe("Spaces pending display", () => {
  test("reports delay only while pending and only on an observed pause or overdue alert", () => {
    expect(
      spacesClaimDelayedV1({
        claim: "issuance_pending",
        commits_paused: true,
        past_overdue_alert: false,
      }),
    ).toBe(true);
    expect(
      spacesClaimDelayedV1({
        claim: "issuance_pending",
        commits_paused: null,
        past_overdue_alert: false,
      }),
    ).toBe(false);
    expect(
      spacesClaimDelayedV1({
        claim: "issuance_pending",
        commits_paused: false,
        past_overdue_alert: true,
      }),
    ).toBe(true);
    expect(
      spacesClaimDelayedV1({ claim: "issued", commits_paused: true, past_overdue_alert: true }),
    ).toBe(false);
  });
});
