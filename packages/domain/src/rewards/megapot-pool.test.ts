import { describe, expect, test } from "bun:test";

import { isTransitionRejection } from "../money/state-machine.ts";
import {
  allocateMegapotWinnings,
  buildMegapotBeneficiarySnapshot,
  createMegapotPoolDrawing,
  type Digest32,
  deriveMegapotTicket,
  type MegapotPoolDrawing,
  MegapotPoolInvariantError,
  transitionMegapotPoolDrawing,
} from "./megapot-pool.ts";

const digest: Digest32 = (input) => {
  const output = new Uint8Array(32);
  let state = 0x811c9dc5;
  for (const byte of input) {
    state = Math.imul(state ^ byte, 0x01000193) >>> 0;
  }
  for (let index = 0; index < output.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    output[index] = state & 0xff;
  }
  return output;
};

const effectId = `0x${"11".repeat(32)}`;
const termsHash = `0x${"22".repeat(32)}`;
const snapshotHash = `0x${"33".repeat(32)}`;

function accepted(
  state: MegapotPoolDrawing,
  event: Parameters<typeof transitionMegapotPoolDrawing>[1],
): MegapotPoolDrawing {
  const next = transitionMegapotPoolDrawing(state, event);
  if (isTransitionRejection(next)) throw new Error(next.rejected);
  return next;
}

describe("Megapot deterministic ticket selection", () => {
  test("derives one stable in-range sorted ticket from frozen effect identity", () => {
    const first = deriveMegapotTicket({
      effectId,
      drawingId: 8_327n,
      ticketIndex: 0,
      ballMax: 25,
      bonusballMax: 13,
      keccak256: digest,
    });
    const replay = deriveMegapotTicket({
      effectId,
      drawingId: 8_327n,
      ticketIndex: 0,
      ballMax: 25,
      bonusballMax: 13,
      keccak256: digest,
    });
    expect(replay).toEqual(first);
    expect(new Set(first.normals).size).toBe(5);
    expect([...first.normals]).toEqual([...first.normals].sort((left, right) => left - right));
    expect(first.normals.every((normal) => normal >= 1 && normal <= 25)).toBe(true);
    expect(first.bonusball).toBeGreaterThanOrEqual(1);
    expect(first.bonusball).toBeLessThanOrEqual(13);
  });

  test("binds selection to drawing and index and rejects invalid provider ranges", () => {
    const base = {
      effectId,
      drawingId: 9n,
      ticketIndex: 0,
      ballMax: 25,
      bonusballMax: 13,
      keccak256: digest,
    } as const;
    expect(deriveMegapotTicket({ ...base, drawingId: 10n })).not.toEqual(deriveMegapotTicket(base));
    expect(deriveMegapotTicket({ ...base, ticketIndex: 1 })).not.toEqual(deriveMegapotTicket(base));
    expect(() => deriveMegapotTicket({ ...base, ballMax: 4 })).toThrow(MegapotPoolInvariantError);
  });
});

describe("Megapot beneficiary snapshots and allocation", () => {
  const beneficiaries = [
    { accountId: "account-c", personaId: "persona-c" },
    { accountId: "account-a", personaId: "persona-a" },
    { accountId: "account-b", personaId: "persona-b" },
  ] as const;

  test("publishes commitments only and allocates 900 and 901 exactly", () => {
    const snapshot = buildMegapotBeneficiarySnapshot({
      poolLegId: "pool-one",
      drawingId: 77n,
      termsHash,
      fallback: false,
      beneficiaries,
      sha256: digest,
    });
    const publishedBytes = JSON.stringify(snapshot.published);
    for (const beneficiary of beneficiaries) {
      expect(publishedBytes).not.toContain(beneficiary.accountId);
      expect(publishedBytes).not.toContain(beneficiary.personaId);
    }
    expect(snapshot.published.leafCount).toBe(3);
    expect(new Set(snapshot.published.leafCommitments).size).toBe(3);

    const nineHundred = allocateMegapotWinnings({ netAtomic: 900n, snapshot });
    expect(nineHundred.kind).toBe("user_allocations");
    if (nineHundred.kind !== "user_allocations") throw new Error("expected allocations");
    expect(nineHundred.allocations.map(({ amountAtomic }) => amountAtomic)).toEqual([
      300n,
      300n,
      300n,
    ]);

    const nineOhOne = allocateMegapotWinnings({ netAtomic: 901n, snapshot });
    expect(nineOhOne.kind).toBe("user_allocations");
    if (nineOhOne.kind !== "user_allocations") throw new Error("expected allocations");
    expect(nineOhOne.allocations.map(({ amountAtomic }) => amountAtomic)).toEqual([
      301n,
      300n,
      300n,
    ]);
    expect(
      nineOhOne.allocations.reduce((sum, allocation) => sum + allocation.amountAtomic, 0n),
    ).toBe(901n);
  });

  test("is independent of input order and rejects duplicate accounts", () => {
    const forward = buildMegapotBeneficiarySnapshot({
      poolLegId: "pool-one",
      drawingId: 77n,
      termsHash,
      fallback: false,
      beneficiaries,
      sha256: digest,
    });
    const reverse = buildMegapotBeneficiarySnapshot({
      poolLegId: "pool-one",
      drawingId: 77n,
      termsHash,
      fallback: false,
      beneficiaries: [...beneficiaries].reverse(),
      sha256: digest,
    });
    expect(reverse.published).toEqual(forward.published);
    expect(() =>
      buildMegapotBeneficiarySnapshot({
        poolLegId: "pool-one",
        drawingId: 77n,
        termsHash,
        fallback: false,
        beneficiaries: [beneficiaries[0], beneficiaries[0]],
        sha256: digest,
      }),
    ).toThrow("duplicate-beneficiary");
  });

  test("credits the sole fallback beneficiary without creating user allocations", () => {
    const snapshot = buildMegapotBeneficiarySnapshot({
      poolLegId: "pool-fallback",
      drawingId: 78n,
      termsHash,
      fallback: true,
      beneficiaries: [{ accountId: "sponsor-account", personaId: "sponsor-persona" }],
      sha256: digest,
    });
    expect(allocateMegapotWinnings({ netAtomic: 901n, snapshot })).toEqual({
      kind: "fallback_sponsorship_credit",
      sponsorAccountId: "sponsor-account",
      sponsorPersonaId: "sponsor-persona",
      amountAtomic: 901n,
    });
  });
});

describe("Megapot pool drawing reducer", () => {
  test("closes zero-entry no-purchase without snapshot or spend", () => {
    const state = createMegapotPoolDrawing({ poolLegId: "pool", drawingId: 1n });
    expect(
      transitionMegapotPoolDrawing(state, {
        type: "cutoff",
        expectedVersion: 1,
        shareCount: 0,
        emptyPoolPolicy: "no_purchase",
        fallbackEligible: false,
        activitiesAvailable: false,
        ceilingReserved: false,
        budgetReserved: false,
        snapshotHash: null,
      }),
    ).toMatchObject({ status: "closed_no_entries", version: 2, snapshotHash: null });
  });

  test("records each external fallback refusal as a distinct terminal", () => {
    const cases = [
      {
        fallbackEligible: false,
        activitiesAvailable: true,
        ceilingReserved: true,
        status: "closed_fallback_ineligible",
      },
      {
        fallbackEligible: true,
        activitiesAvailable: false,
        ceilingReserved: true,
        status: "closed_fallback_unavailable",
      },
      {
        fallbackEligible: true,
        activitiesAvailable: true,
        ceilingReserved: false,
        status: "closed_fallback_ceiling",
      },
    ] as const;
    for (const fixture of cases) {
      const state = createMegapotPoolDrawing({ poolLegId: "pool", drawingId: 2n });
      expect(
        transitionMegapotPoolDrawing(state, {
          type: "cutoff",
          expectedVersion: 1,
          shareCount: 0,
          emptyPoolPolicy: "funder_fallback",
          fallbackEligible: fixture.fallbackEligible,
          activitiesAvailable: fixture.activitiesAvailable,
          ceilingReserved: fixture.ceilingReserved,
          budgetReserved: true,
          snapshotHash,
        }),
      ).toMatchObject({ status: fixture.status, version: 2 });
    }
  });

  test("runs a populated drawing through purchase, no-win, and win-credit paths", () => {
    const frozen = accepted(createMegapotPoolDrawing({ poolLegId: "pool", drawingId: 3n }), {
      type: "cutoff",
      expectedVersion: 1,
      shareCount: 3,
      emptyPoolPolicy: "funder_fallback",
      fallbackEligible: true,
      activitiesAvailable: true,
      ceilingReserved: true,
      budgetReserved: true,
      snapshotHash,
    });
    expect(frozen).toMatchObject({ status: "cutoff_frozen", fallback: false, beneficiaryCount: 3 });
    const committed = accepted(frozen, {
      type: "commitment_published",
      expectedVersion: 2,
      commitmentRef: "commitment-3",
    });
    const pending = accepted(committed, {
      type: "purchase_reserved",
      expectedVersion: 3,
      purchaseEffectId: "purchase-3",
    });
    const confirmed = accepted(pending, {
      type: "purchase_confirmed",
      expectedVersion: 4,
      ticketIds: [44n],
    });
    const drawing = accepted(confirmed, { type: "drawing_waiting", expectedVersion: 5 });
    expect(
      accepted(drawing, { type: "sweep_completed", expectedVersion: 6, winningsAtomic: 0n }),
    ).toMatchObject({ status: "no_win", winningsAtomic: 0n });

    const winning = accepted(drawing, {
      type: "sweep_completed",
      expectedVersion: 6,
      winningsAtomic: 901n,
    });
    const claimPending = accepted(winning, {
      type: "claim_reserved",
      expectedVersion: 7,
      claimEffectId: "claim-3",
    });
    const claimed = accepted(claimPending, {
      type: "claim_confirmed",
      expectedVersion: 8,
      receivedAtomic: 901n,
    });
    const allocated = accepted(claimed, {
      type: "allocation_recorded",
      expectedVersion: 9,
      allocationBatchId: "allocation-3",
    });
    expect(accepted(allocated, { type: "credits_recorded", expectedVersion: 10 })).toMatchObject({
      status: "credited",
      version: 11,
    });
  });

  test("closes a committed drawing when purchase becomes unavailable before broadcast", () => {
    const frozen = accepted(createMegapotPoolDrawing({ poolLegId: "pool", drawingId: 4n }), {
      type: "cutoff",
      expectedVersion: 1,
      shareCount: 1,
      emptyPoolPolicy: "no_purchase",
      fallbackEligible: false,
      activitiesAvailable: true,
      ceilingReserved: true,
      budgetReserved: true,
      snapshotHash,
    });
    const committed = accepted(frozen, {
      type: "commitment_published",
      expectedVersion: 2,
      commitmentRef: "urn:pirate:test:commitment",
    });
    expect(
      transitionMegapotPoolDrawing(committed, {
        type: "purchase_unavailable",
        expectedVersion: 3,
      }),
    ).toMatchObject({ status: "closed_purchase_unavailable", version: 4 });
  });

  test("rejects stale, premature, and malformed economic transitions", () => {
    const state = createMegapotPoolDrawing({ poolLegId: "pool", drawingId: 4n });
    expect(
      transitionMegapotPoolDrawing(state, {
        type: "purchase_reserved",
        expectedVersion: 1,
        purchaseEffectId: "purchase-4",
      }),
    ).toEqual({ _tag: "transition_rejected", rejected: "purchase_not_allowed" });
    expect(
      transitionMegapotPoolDrawing(state, {
        type: "cutoff",
        expectedVersion: 2,
        shareCount: 1,
        emptyPoolPolicy: "no_purchase",
        fallbackEligible: true,
        activitiesAvailable: true,
        ceilingReserved: true,
        budgetReserved: true,
        snapshotHash,
      }),
    ).toEqual({ _tag: "transition_rejected", rejected: "stale_version" });
  });
});
