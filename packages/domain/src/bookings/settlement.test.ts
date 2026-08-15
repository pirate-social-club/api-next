import { describe, expect, test } from "bun:test";
import {
  actingPartyForAttendanceOutcome,
  BOOKING_RESOLVABLE_STATES,
  custodyIncidentEvidenceMatches,
  custodyRefundEvidenceMatches,
  evaluateBookingSettlementGate,
} from "./settlement";

// Ported from the old booking-settlement-evaluator gate tests (which stubbed a
// SQL executor; the pure port asserts the same decisions) and the custody
// equality branches of booking-confirm-service.

const HOST = "host_1";
const BOOKER = "booker_1";
const SLOT_END = "2026-07-02T11:00:00.000Z";
const AFTER = "2026-07-02T12:00:00.000Z";

function gateInput(overrides: Record<string, unknown> = {}) {
  return {
    bookingExists: true,
    hostUserId: HOST,
    bookerUserId: BOOKER,
    actorUserId: BOOKER,
    status: "confirmed",
    slotEndUtc: SLOT_END,
    nowUtc: AFTER,
    ...overrides,
  } as Parameters<typeof evaluateBookingSettlementGate>[0];
}

describe("evaluateBookingSettlementGate", () => {
  test("resolvable states are confirmed and live only", () => {
    expect([...BOOKING_RESOLVABLE_STATES].sort()).toEqual(["confirmed", "live"]);
  });

  test("a party settling after the slot window is allowed", () => {
    for (const actorUserId of [HOST, BOOKER]) {
      expect(evaluateBookingSettlementGate(gateInput({ actorUserId }))).toEqual({ ok: true });
    }
  });

  test("hides non-existent bookings", () => {
    expect(evaluateBookingSettlementGate(gateInput({ bookingExists: false }))).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  test("hides the booking from users who are neither host nor booker", () => {
    expect(evaluateBookingSettlementGate(gateInput({ actorUserId: "stranger" }))).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  test("refuses to settle a booking that is not in a resolvable state", () => {
    for (const status of ["settled", "pending", "cancelled", "no_show_host"]) {
      expect(evaluateBookingSettlementGate(gateInput({ status }))).toEqual({
        ok: false,
        reason: "not_settleable",
      });
    }
  });

  test("refuses to settle before the slot window has closed (no premature, self-attested settlement)", () => {
    expect(
      evaluateBookingSettlementGate(gateInput({ nowUtc: "2026-07-02T10:30:00.000Z" })),
    ).toEqual({ ok: false, reason: "session_not_ended" });
    expect(evaluateBookingSettlementGate(gateInput({ nowUtc: SLOT_END }))).toEqual({ ok: true });
  });
});

describe("actingPartyForAttendanceOutcome", () => {
  test("the host acts on completion and a booker no-show; the booker acts on a host no-show", () => {
    expect(actingPartyForAttendanceOutcome("completed", HOST, BOOKER)).toBe(HOST);
    expect(actingPartyForAttendanceOutcome("no_show_booker", HOST, BOOKER)).toBe(HOST);
    expect(actingPartyForAttendanceOutcome("no_show_host", HOST, BOOKER)).toBe(BOOKER);
  });
});

describe("custodyRefundEvidenceMatches", () => {
  const observation = {
    claimedTxRef: "0xabc",
    observedAmountAtomic: "1500000",
    senderAddress: "0xAaA1111111111111111111111111111111111111",
    reason: "wrong_transfer_amount" as const,
  };
  const matchingEvidence = {
    claimedTxRef: "0xabc",
    status: "custody_refund_pending",
    custodyObservedAmountAtomic: "1500000",
    custodySenderAddress: "0xaaa1111111111111111111111111111111111111",
    custodyReason: "wrong_transfer_amount" as const,
  };

  test("matches when the re-verified amount, sender, and reason equal the persisted evidence", () => {
    expect(custodyRefundEvidenceMatches(matchingEvidence, observation)).toBe(true);
  });

  test("a different tx ref, amount, reason, or status never matches", () => {
    for (const changed of [
      { claimedTxRef: "0xdef" },
      { custodyObservedAmountAtomic: "1600000" },
      { custodyReason: "unexpected_sender" as const },
      { status: "verified" },
      { custodySenderAddress: null },
    ]) {
      expect(custodyRefundEvidenceMatches({ ...matchingEvidence, ...changed }, observation)).toBe(
        false,
      );
    }
  });

  test("a different sender address never matches even with identical other fields", () => {
    expect(
      custodyRefundEvidenceMatches(
        { ...matchingEvidence, custodySenderAddress: "0xbbb1111111111111111111111111111111111111" },
        observation,
      ),
    ).toBe(false);
  });
});

describe("custodyIncidentEvidenceMatches", () => {
  const transfers = [
    { senderAddress: "0xA", observedAmountAtomic: "100", transferCount: 1 },
    { senderAddress: "0xB", observedAmountAtomic: "200", transferCount: 2 },
  ];
  const evidence = { claimedTxRef: "0xabc", status: "custody_operator_incident", transfers };

  test("matches a re-observed identical transfer list", () => {
    expect(custodyIncidentEvidenceMatches(evidence, { claimedTxRef: "0xabc", transfers })).toBe(
      true,
    );
  });

  test("any divergence in tx ref, status, or transfer list fails the match", () => {
    expect(custodyIncidentEvidenceMatches(evidence, { claimedTxRef: "0xdef", transfers })).toBe(
      false,
    );
    expect(
      custodyIncidentEvidenceMatches(
        { ...evidence, status: "custody_refund_pending" },
        { claimedTxRef: "0xabc", transfers },
      ),
    ).toBe(false);
    expect(
      custodyIncidentEvidenceMatches(evidence, {
        claimedTxRef: "0xabc",
        transfers: [transfers[0]!],
      }),
    ).toBe(false);
    expect(
      custodyIncidentEvidenceMatches(evidence, {
        claimedTxRef: "0xabc",
        transfers: [{ ...transfers[0]!, transferCount: 3 }, transfers[1]!],
      }),
    ).toBe(false);
    expect(
      custodyIncidentEvidenceMatches(
        { claimedTxRef: "0xabc", status: "custody_operator_incident", transfers: null },
        { claimedTxRef: "0xabc", transfers },
      ),
    ).toBe(false);
  });
});
