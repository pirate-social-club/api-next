import { Schema } from "effect";
import {
  type MultiGoldenInput,
  RehearsalAtomic,
  RehearsalId,
  RehearsalInstant,
} from "./megapot-golden-multi-input.ts";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const GoldenObservation = Schema.Struct({
  leg_id: RehearsalId,
  drawing_id: RehearsalAtomic,
  observed_at: RehearsalInstant,
  community_id: RehearsalId,
  post_id: RehearsalId,
  audio_revision: Count,
  drawing_status: Schema.String,
  entry_cutoff_at: RehearsalInstant,
  funded_atomic: RehearsalAtomic,
  spent_atomic: RehearsalAtomic,
  refunded_atomic: RehearsalAtomic,
  reserved_atomic: RehearsalAtomic,
  net_winnings_atomic: RehearsalAtomic,
  ticket_count: Count,
  purchase_receipt_count: Count,
  unresolved_effect_count: Count,
  other_unresolved_drawings: Count,
  refund_receipt_atomic: RehearsalAtomic,
  claim_receipt_atomic: RehearsalAtomic,
  shares: Schema.Array(Schema.Struct({ account_id: RehearsalId, persona_id: RehearsalId })),
  qualifications: Schema.Array(
    Schema.Struct({
      account_id: RehearsalId,
      persona_id: RehearsalId,
      activity_key: Schema.String,
    }),
  ),
  beneficiaries: Schema.Array(
    Schema.Struct({ ordinal: Count, account_id: RehearsalId, persona_id: RehearsalId }),
  ),
  decisions: Schema.Array(
    Schema.Struct({
      account_id: RehearsalId,
      persona_id: RehearsalId,
      activity_key: Schema.String,
      outcome: Schema.String,
      reason: Schema.NullOr(Schema.String),
    }),
  ),
  credits: Schema.Array(
    Schema.Struct({
      account_id: RehearsalId,
      persona_id: RehearsalId,
      ordinal: Count,
      amount_atomic: RehearsalAtomic,
      paid_atomic: RehearsalAtomic,
      reserved_atomic: RehearsalAtomic,
      state: Schema.String,
      receipt_confirmed: Schema.Boolean,
    }),
  ),
});
export type GoldenObservation = typeof GoldenObservation.Type;

export function assertGoldenAdmission(
  input: MultiGoldenInput,
  observation: GoldenObservation,
): void {
  const positives = input.participants.filter((p) => p.expected_admission === "eligible");
  if (
    observation.community_id !== input.community_id ||
    observation.post_id !== input.post_id ||
    observation.audio_revision !== input.audio_revision ||
    observation.shares.length !== positives.length ||
    positives.some(
      (p) =>
        observation.shares.filter(
          (s) => s.account_id === p.account_id && s.persona_id === p.persona_id,
        ).length !== 1,
    ) ||
    input.participants.some((p) =>
      p.activities.some(
        (activity) =>
          !observation.qualifications.some(
            (q) =>
              q.account_id === p.account_id &&
              q.persona_id === p.persona_id &&
              q.activity_key === activity,
          ),
      ),
    ) ||
    input.participants.some((p) =>
      p.expected_admission === "eligible"
        ? !observation.decisions.some(
            (d) =>
              d.account_id === p.account_id &&
              d.persona_id === p.persona_id &&
              d.outcome === "eligible",
          )
        : p.activities.some(
            (activity) =>
              !observation.decisions.some(
                (d) =>
                  d.account_id === p.account_id &&
                  d.persona_id === p.persona_id &&
                  d.activity_key === activity &&
                  d.outcome === "ineligible" &&
                  d.reason === "verification_missing",
              ),
          ),
    )
  ) {
    throw new Error("Admission does not match the exact participant expectations.");
  }
}

export function evaluateGoldenSettlement(
  input: MultiGoldenInput,
  observation: GoldenObservation,
  now: number,
) {
  if (
    Date.parse(observation.observed_at) > now ||
    now - Date.parse(observation.observed_at) > 60000
  ) {
    throw new Error("Settlement observation is not fresh.");
  }
  assertGoldenAdmission(input, observation);
  if (
    observation.ticket_count > 1 ||
    BigInt(observation.funded_atomic) !== BigInt(input.funding_amount_atomic) ||
    BigInt(observation.spent_atomic) > BigInt(input.max_ticket_price_atomic)
  ) {
    throw new Error("Rehearsal economic bounds exceeded.");
  }
  const positives = input.participants.filter((p) => p.expected_admission === "eligible");
  const terminal =
    observation.drawing_status === "no_win" || observation.drawing_status === "credited";
  if (
    !terminal ||
    observation.ticket_count !== 1 ||
    observation.purchase_receipt_count !== 1 ||
    observation.unresolved_effect_count !== 0 ||
    observation.other_unresolved_drawings !== 0 ||
    BigInt(observation.reserved_atomic) !== 0n ||
    BigInt(observation.refunded_atomic) + BigInt(observation.spent_atomic) !==
      BigInt(observation.funded_atomic) ||
    BigInt(observation.refund_receipt_atomic) !== BigInt(observation.refunded_atomic)
  ) {
    return { state: "reconciliation_pending" as const, terminal: false as const };
  }
  if (
    observation.beneficiaries.length !== positives.length ||
    observation.beneficiaries.some((beneficiary, ordinal) => beneficiary.ordinal !== ordinal) ||
    positives.some(
      (p) =>
        observation.beneficiaries.filter(
          (b) => b.account_id === p.account_id && b.persona_id === p.persona_id,
        ).length !== 1,
    )
  ) {
    throw new Error("Frozen beneficiaries do not match admitted participants.");
  }
  const net = BigInt(observation.net_winnings_atomic);
  if (observation.drawing_status === "no_win") {
    if (
      net !== 0n ||
      observation.credits.length !== 0 ||
      BigInt(observation.claim_receipt_atomic) !== 0n
    ) {
      throw new Error("Losing drawing has unexpected winning liabilities.");
    }
    return {
      state: "reconciled_no_win" as const,
      terminal: true as const,
      unexplained_delta_atomic: "0",
    };
  }
  if (
    net < 1n ||
    observation.credits.length !== positives.length ||
    BigInt(observation.claim_receipt_atomic) !== net
  ) {
    return { state: "reconciliation_pending" as const, terminal: false as const };
  }
  let paid = 0n;
  const count = BigInt(positives.length);
  for (const beneficiary of observation.beneficiaries) {
    const credit = observation.credits.find(
      (c) =>
        c.ordinal === beneficiary.ordinal &&
        c.account_id === beneficiary.account_id &&
        c.persona_id === beneficiary.persona_id,
    );
    const expected = net / count + (BigInt(beneficiary.ordinal) < net % count ? 1n : 0n);
    if (!credit || BigInt(credit.amount_atomic) !== expected)
      throw new Error("Allocation split mismatch.");
    if (
      credit.state !== "sent" ||
      !credit.receipt_confirmed ||
      BigInt(credit.reserved_atomic) !== 0n ||
      BigInt(credit.paid_atomic) !== expected
    ) {
      return { state: "reconciliation_pending" as const, terminal: false as const };
    }
    paid += BigInt(credit.paid_atomic);
  }
  if (paid !== net) throw new Error("Payout conservation mismatch.");
  return {
    state: "reconciled_win" as const,
    terminal: true as const,
    unexplained_delta_atomic: "0",
  };
}

/** Observes ordinary jobs; never repairs SQL state or broadcasts a transaction. */
export async function waitForGoldenSettlement(
  input: MultiGoldenInput,
  scope: { legId: string; drawingId: string },
  ports: {
    observe: () => Promise<GoldenObservation>;
    now: () => number;
    sleep: (ms: number) => Promise<void>;
  },
  maxPolls = 120,
) {
  if (!input.authorization) throw new Error("Reconciliation authorization is missing.");
  for (
    let poll = 0;
    poll < maxPolls && ports.now() < Date.parse(input.authorization.reconciliation_deadline);
    poll++
  ) {
    const observation = await ports.observe();
    if (observation.leg_id !== scope.legId || observation.drawing_id !== scope.drawingId)
      throw new Error("Settlement scope changed.");
    const result = evaluateGoldenSettlement(input, observation, ports.now());
    if (result.terminal) return { ...result, observation };
    await ports.sleep(10000);
  }
  return {
    state: "reconciliation_required" as const,
    terminal: false as const,
    leg_id: scope.legId,
    drawing_id: scope.drawingId,
  };
}
