/** Pure L5 arithmetic over authoritative, already verified schedule evidence.
 * This module cannot obtain or attest a provider schedule. Missing proof is unavailable.
 */
export type DrawingCapacityRow = Readonly<{
  id: string;
  drawingTime: number;
  entryCutoff: number;
  purchaseDeadline: number;
  priceAtomic: bigint;
  proof: "initialized_state" | "attested_recurrence";
  state: "uncommitted" | "committed" | "settled" | "cancelled";
  reservedCostAtomic: bigint;
}>;

export type CapacityProfile = Readonly<{
  maxDrawings: number;
  reservationMs: number;
  safetyMarginMs: number;
  maximumWitnessAgeMs: number;
  validUntil: number;
  attestationValidUntil: number;
  priceCeilingAtomic: bigint;
  minimumAtomic: bigint;
}>;

export type AuthoritativeSchedule = Readonly<{
  observedAt: number;
  validUntil: number;
  ruleHash: string;
  priceRuleHash: string;
  recurrenceProven: boolean;
  rows: readonly DrawingCapacityRow[];
}>;

export type CapacityFailure = Readonly<{
  ok: false;
  reason:
    | "policy_unavailable"
    | "schedule_unproven"
    | "observation_stale"
    | "quote_expired"
    | "price_changed"
    | "recovery_required"
    | "capacity_exhausted";
}>;
const refuse = (reason: CapacityFailure["reason"]): CapacityFailure => ({ ok: false, reason });
const instant = (n: number) => Number.isSafeInteger(n) && n >= 0;
const uint = (n: bigint) => n >= 0n && n < 1n << 256n;

function validate(
  now: number,
  profile: CapacityProfile | null,
  schedule: AuthoritativeSchedule | null,
): CapacityFailure | null {
  if (
    profile === null ||
    !Number.isSafeInteger(profile.maxDrawings) ||
    profile.maxDrawings < 1 ||
    profile.maxDrawings > 30 ||
    !instant(profile.reservationMs) ||
    profile.reservationMs === 0 ||
    !instant(profile.safetyMarginMs) ||
    !instant(profile.maximumWitnessAgeMs) ||
    profile.maximumWitnessAgeMs === 0 ||
    !instant(profile.validUntil) ||
    !instant(profile.attestationValidUntil) ||
    !uint(profile.priceCeilingAtomic) ||
    profile.priceCeilingAtomic === 0n ||
    !uint(profile.minimumAtomic) ||
    profile.minimumAtomic === 0n
  )
    return refuse("policy_unavailable");
  if (
    schedule === null ||
    schedule.ruleHash.length === 0 ||
    schedule.priceRuleHash.length === 0 ||
    !instant(schedule.observedAt) ||
    !instant(schedule.validUntil) ||
    schedule.rows.length === 0 ||
    schedule.rows.length > 30 ||
    new Set(schedule.rows.map((r) => r.id)).size !== schedule.rows.length
  )
    return refuse("schedule_unproven");
  if (
    !instant(now) ||
    schedule.observedAt > now ||
    now - schedule.observedAt > profile.maximumWitnessAgeMs ||
    now >= schedule.validUntil ||
    now >= profile.validUntil ||
    now >= profile.attestationValidUntil
  )
    return refuse("observation_stale");
  for (const row of schedule.rows) {
    if (
      !/^(0|[1-9][0-9]*)$/u.test(row.id) ||
      !instant(row.drawingTime) ||
      !instant(row.entryCutoff) ||
      !instant(row.purchaseDeadline) ||
      row.entryCutoff > row.drawingTime ||
      row.purchaseDeadline > row.drawingTime ||
      (row.proof === "attested_recurrence" && !schedule.recurrenceProven) ||
      !uint(row.priceAtomic) ||
      row.priceAtomic === 0n ||
      !uint(row.reservedCostAtomic)
    )
      return refuse("schedule_unproven");
    if (row.priceAtomic > profile.priceCeilingAtomic) return refuse("price_changed");
    if ((row.state === "committed") !== row.reservedCostAtomic > 0n)
      return refuse("recovery_required");
  }
  return null;
}

/** Selection is anchored to the stored witness, not GET time or a calendar cadence. */
export function initialMegapotWindow(input: {
  readonly now: number;
  readonly profile: CapacityProfile | null;
  readonly schedule: AuthoritativeSchedule | null;
}):
  | CapacityFailure
  | Readonly<{
      ok: true;
      plannedDrawingIds: readonly string[];
      fixedEndsAt: number;
      latestAllocationAt: number;
      reservationDeadlineUpperBound: number;
    }> {
  const invalid = validate(input.now, input.profile, input.schedule);
  if (invalid !== null) return invalid;
  const p = input.profile;
  const s = input.schedule;
  if (p === null || s === null) return refuse("policy_unavailable");
  const earliestDeadline = s.observedAt + p.reservationMs + p.safetyMarginMs;
  const rows = s.rows
    .filter(
      (r) =>
        r.state === "uncommitted" &&
        earliestDeadline < r.entryCutoff &&
        earliestDeadline < r.purchaseDeadline,
    )
    .sort((a, b) => a.drawingTime - b.drawingTime || (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
    .slice(0, p.maxDrawings);
  const last = rows.at(-1);
  if (last === undefined) return refuse("capacity_exhausted");
  const latestAllocationAt = Math.min(
    s.validUntil,
    p.validUntil,
    p.attestationValidUntil,
    last.drawingTime - p.reservationMs,
    ...rows.flatMap((r) => [
      r.entryCutoff - p.reservationMs - p.safetyMarginMs,
      r.purchaseDeadline - p.reservationMs - p.safetyMarginMs,
    ]),
  );
  if (input.now >= latestAllocationAt) return refuse("quote_expired");
  return {
    ok: true,
    plannedDrawingIds: rows.map((r) => r.id),
    fixedEndsAt: last.drawingTime,
    latestAllocationAt,
    reservationDeadlineUpperBound: latestAllocationAt + p.reservationMs,
  };
}

export type PoolPrincipalBudget = Readonly<{
  funded: bigint;
  spent: bigint;
  committedPurchases: bigint;
  refunded: bigint;
  otherObligations: bigint;
  liveInboundReservations: bigint;
}>;

/** Existing targets always pass their ORIGINAL end and ID set. Never derives a new end. */
export function songMegapotCapacity(input: {
  readonly now: number;
  readonly profile: CapacityProfile | null;
  readonly schedule: AuthoritativeSchedule | null;
  readonly plannedDrawingIds: readonly string[];
  readonly fixedEndsAt: number;
  readonly reservationDeadlineUpperBound: number;
  readonly budget: PoolPrincipalBudget;
  readonly outboundCostsReconciled: boolean;
}):
  | CapacityFailure
  | Readonly<{ ok: true; availableAtomic: bigint; usableDrawingIds: readonly string[] }> {
  const invalid = validate(input.now, input.profile, input.schedule);
  if (invalid !== null) return invalid;
  const p = input.profile;
  const s = input.schedule;
  if (p === null || s === null) return refuse("policy_unavailable");
  if (!input.outboundCostsReconciled || !Object.values(input.budget).every(uint))
    return refuse("recovery_required");
  if (
    !instant(input.fixedEndsAt) ||
    !instant(input.reservationDeadlineUpperBound) ||
    input.now >= input.fixedEndsAt ||
    input.now + p.reservationMs >= input.reservationDeadlineUpperBound
  )
    return refuse("quote_expired");
  const ids = new Set(input.plannedDrawingIds);
  if (
    ids.size === 0 ||
    ids.size !== input.plannedDrawingIds.length ||
    ids.size > p.maxDrawings ||
    [...ids].some((id) => !s.rows.some((r) => r.id === id))
  )
    return refuse("schedule_unproven");
  const committed = s.rows
    .filter((r) => ids.has(r.id) && r.state === "committed")
    .reduce((sum, r) => sum + r.reservedCostAtomic, 0n);
  if (committed !== input.budget.committedPurchases) return refuse("recovery_required");
  const b = input.budget;
  const free = b.funded - b.spent - b.committedPurchases - b.refunded - b.otherObligations;
  if (free < 0n) return refuse("recovery_required");
  const rows = s.rows.filter(
    (r) =>
      ids.has(r.id) &&
      r.state === "uncommitted" &&
      r.entryCutoff <= input.fixedEndsAt &&
      input.reservationDeadlineUpperBound + p.safetyMarginMs <= r.entryCutoff &&
      input.reservationDeadlineUpperBound + p.safetyMarginMs <= r.purchaseDeadline,
  );
  const total = rows.reduce((sum, r) => sum + r.priceAtomic, 0n);
  const remaining = total - free - b.liveInboundReservations;
  return {
    ok: true,
    availableAtomic: remaining > 0n ? remaining : 0n,
    usableDrawingIds: rows.map((r) => r.id),
  };
}
