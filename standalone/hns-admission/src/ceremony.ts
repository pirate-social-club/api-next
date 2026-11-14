import { Schema } from "effect";
import { Binding, Seconds } from "./protocol.ts";
import { Hash } from "./records.ts";
import { Observation } from "./observation.ts";
import { Code, ConflictDetail } from "./outcomes.ts";
export const State = Schema.Struct({
  id: Hash,
  binding: Binding,
  bindingDigest: Hash,
  resourceDigest: Hash,
  beforeResourceDigest: Hash,
  publicationJson: Schema.String,
  nonce: Hash,
  challenge: Schema.String,
  revision: Schema.Int,
  phase: Schema.Literals([
    "AwaitingConsent",
    "AwaitingPublication",
    "Maturing",
    "ReadyToSubmit",
    "Cancelled",
    "Expired",
    "Suspended",
  ]),
  condition: Code,
  conditionDetail: Schema.NullOr(ConflictDetail),
  lastObservation: Schema.NullOr(Observation),
  createdAt: Seconds,
  consentDeadline: Seconds,
  publicationDeadline: Seconds,
  firstIncludedAt: Schema.NullOr(Seconds),
  maturityDeadline: Schema.NullOr(Seconds),
  maturedAt: Schema.NullOr(Seconds),
  ownershipEpoch: Schema.NullOr(Hash),
  consented: Schema.Boolean,
  updatedAt: Seconds,
  nextObservationAt: Seconds,
  observationFailures: Schema.Int,
});
export type State = typeof State.Type;
export type Action =
  | { type: "Consent"; now: number; deadline: number }
  | { type: "Suspend"; now: number; reason: Code }
  | { type: "Cancel"; now: number }
  | { type: "Tick"; now: number }
  | { type: "Unavailable"; now: number; reason: Code; detail?: ConflictDetail }
  | {
      type: "Observed";
      evidence?: Observation;
      now: number;
      includedAt: number | null;
      ownershipEpoch: string;
      safe: boolean;
      transferPending: boolean;
    };
const terminal = (s: State) =>
  ["Cancelled", "Expired", "Suspended"].includes(s.phase);
export function advance(state: State, event: Action): State {
  if (event.now < state.updatedAt) throw new Error("clock_regression");
  // Late observation may establish publication before its deadline. It never revives cancellation.
  if (
    event.type === "Observed" &&
    event.includedAt !== null &&
    event.includedAt <= state.publicationDeadline &&
    event.includedAt <= event.now + 120 &&
    event.now < event.includedAt + 86400 &&
    ((state.phase !== "Expired" && !terminal(state)) ||
      (state.phase === "Expired" && state.condition === "publication_deadline"))
  ) {
    state = {
      ...state,
      phase: state.consented ? "Maturing" : "AwaitingConsent",
      firstIncludedAt: event.includedAt,
      maturityDeadline: event.includedAt + 86400,
    };
  }
  if (terminal(state)) return state;
  let s = {
    ...state,
    revision: state.revision + 1,
    updatedAt: event.now,
    conditionDetail: null as ConflictDetail | null,
  };
  if (event.type === "Cancel")
    return { ...s, phase: "Cancelled", condition: "cancelled" };
  if (s.firstIncludedAt === null && event.now >= s.publicationDeadline)
    return { ...s, phase: "Expired", condition: "publication_deadline" };
  if (
    s.maturedAt === null &&
    s.maturityDeadline !== null &&
    event.now >= s.maturityDeadline
  )
    return { ...s, phase: "Expired", condition: "maturity_deadline" };
  if (event.type === "Suspend")
    return { ...s, phase: "Suspended", condition: event.reason };
  if (event.type === "Consent") {
    if (event.deadline <= event.now || event.deadline > event.now + 259200)
      throw new Error("invalid_consent_deadline");
    return {
      ...s,
      consentDeadline: event.deadline,
      consented: true,
      phase: s.firstIncludedAt === null ? "AwaitingPublication" : "Maturing",
      condition: "publication_pending",
    };
  }
  if (event.now >= s.consentDeadline)
    return {
      ...s,
      phase: "AwaitingConsent",
      condition: "consent_expired",
      consented: false,
    };
  if (event.type === "Unavailable")
    return {
      ...s,
      condition: event.reason,
      conditionDetail: event.detail ?? null,
    };
  if (event.type === "Observed") {
    s = { ...s, lastObservation: event.evidence ?? null };
    if (s.ownershipEpoch !== null && s.ownershipEpoch !== event.ownershipEpoch)
      return { ...s, phase: "Suspended", condition: "ownership_changed" };
    if (event.transferPending)
      return { ...s, phase: "Maturing", condition: "transfer_pending" };
    if (event.includedAt === null)
      return {
        ...s,
        phase: s.consented ? "AwaitingPublication" : "AwaitingConsent",
        firstIncludedAt: null,
        maturityDeadline: null,
        maturedAt: null,
        condition: "publication_pending",
      };
    if (event.includedAt > event.now)
      return { ...s, condition: "observer_stale" };
    if (event.includedAt > s.publicationDeadline)
      return { ...s, phase: "Expired", condition: "publication_deadline" };
    s = {
      ...s,
      firstIncludedAt: event.includedAt,
      maturityDeadline: event.includedAt + 86400,
      ownershipEpoch: event.ownershipEpoch,
    };
    if (s.maturedAt === null && event.now >= s.maturityDeadline!)
      return { ...s, phase: "Expired", condition: "maturity_deadline" };
    return {
      ...s,
      phase: !s.consented
        ? "AwaitingConsent"
        : event.safe
          ? "ReadyToSubmit"
          : "Maturing",
      maturedAt: event.safe ? (s.maturedAt ?? event.now) : null,
      condition: !s.consented
        ? "consent_required"
        : event.safe
          ? "submission_not_enabled"
          : "maturity_pending",
    };
  }
  return event.type === "Tick" ? state : s;
}
