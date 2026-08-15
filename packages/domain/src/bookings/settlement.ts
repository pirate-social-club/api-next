// Pure decision core extracted from the old booking-settlement-evaluator and
// booking-confirm services. The application layer loads rows and applies these
// decisions; the gate order and equality rules are the ported invariants.

import type { AttendanceConfig, AttendanceOutcome } from "./attendance";

export const BOOKING_RESOLVABLE_STATES: ReadonlySet<string> = new Set(["confirmed", "live"]);

export type BookingSettlementGateRejection =
  | { readonly ok: false; readonly reason: "not_found" }
  | { readonly ok: false; readonly reason: "not_settleable" }
  | { readonly ok: false; readonly reason: "session_not_ended" };

export interface BookingSettlementGateInput {
  readonly bookingExists: boolean;
  readonly hostUserId: string;
  readonly bookerUserId: string;
  readonly actorUserId: string;
  readonly status: string;
  readonly slotEndUtc: string;
  readonly nowUtc: string;
}

// Non-parties are told "not found" — no existence leak. Attendance can only be
// judged after the full window has elapsed; before then the cron would not act
// either. This gate replaces self-attested settlement.
export function evaluateBookingSettlementGate(
  input: BookingSettlementGateInput,
): { readonly ok: true } | BookingSettlementGateRejection {
  const isParty =
    input.actorUserId === input.hostUserId || input.actorUserId === input.bookerUserId;
  if (!input.bookingExists || !isParty) return { ok: false, reason: "not_found" };
  if (!BOOKING_RESOLVABLE_STATES.has(input.status)) return { ok: false, reason: "not_settleable" };
  if (Date.parse(input.nowUtc) < Date.parse(input.slotEndUtc))
    return { ok: false, reason: "session_not_ended" };
  return { ok: true };
}

// Who may act on each attendance outcome: the host drives completion and a
// booker no-show; the booker drives a host no-show.
export function actingPartyForAttendanceOutcome(
  outcome: AttendanceOutcome,
  host: string,
  booker: string,
): string {
  if (outcome === "no_show_host") return booker;
  return host;
}

export type CustodyRefundReason = "wrong_transfer_amount" | "unexpected_sender";

export interface CustodyRefundEvidence {
  readonly claimedTxRef: string | null;
  readonly status: string;
  readonly custodyObservedAmountAtomic: string | null;
  readonly custodySenderAddress: string | null;
  readonly custodyReason: CustodyRefundReason | null;
}

export interface CustodyRefundObservation {
  readonly claimedTxRef: string;
  readonly observedAmountAtomic: string;
  readonly senderAddress: string;
  readonly reason: CustodyRefundReason;
}

function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

// A retry of a custody-mismatch verification is idempotent ONLY when the
// re-verified amount and sender equal the persisted custody evidence exactly.
export function custodyRefundEvidenceMatches(
  evidence: CustodyRefundEvidence,
  observation: CustodyRefundObservation,
): boolean {
  return (
    evidence.status === "custody_refund_pending" &&
    evidence.claimedTxRef === observation.claimedTxRef &&
    evidence.custodyObservedAmountAtomic === observation.observedAmountAtomic &&
    sameAddress(evidence.custodySenderAddress, observation.senderAddress) &&
    evidence.custodyReason === observation.reason
  );
}

export interface CustodyIncidentTransfer {
  readonly senderAddress: string;
  readonly observedAmountAtomic: string;
  readonly transferCount: number;
}

export interface CustodyIncidentEvidence {
  readonly claimedTxRef: string | null;
  readonly status: string;
  readonly transfers: readonly CustodyIncidentTransfer[] | null;
}

// A retry of a multi-sender incident is idempotent only when the persisted
// transfer list deep-equals the re-observed one, same tx ref.
export function custodyIncidentEvidenceMatches(
  evidence: CustodyIncidentEvidence,
  observation: { claimedTxRef: string; transfers: readonly CustodyIncidentTransfer[] },
): boolean {
  return (
    evidence.status === "custody_operator_incident" &&
    evidence.claimedTxRef === observation.claimedTxRef &&
    JSON.stringify(evidence.transfers) === JSON.stringify(observation.transfers)
  );
}

export type { AttendanceConfig, AttendanceOutcome };
