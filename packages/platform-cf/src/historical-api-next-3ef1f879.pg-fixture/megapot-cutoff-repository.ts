import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
  type MegapotCutoffBeneficiary,
  type MegapotCutoffCandidate,
  type MegapotCutoffFailure,
  MegapotCutoffRejected,
  type MegapotCutoffResult,
  MegapotCutoffStorageFailed,
  type MegapotCutoffStore,
} from "@pirate/application";
import type { MegapotBeneficiarySnapshot } from "@pirate/domain";
import { Effect, type Layer } from "effect";
import { sha256, toBytes } from "viem";
import { mapMegapotStorageFailure } from "./control-plane-error-classification.ts";

type Row = Readonly<Record<string, unknown>>;

const storage = (reason: MegapotCutoffStorageFailed["reason"]) =>
  new MegapotCutoffStorageFailed({ reason });
const rejected = (reason: MegapotCutoffRejected["reason"]) => new MegapotCutoffRejected({ reason });

const mapped = <A, E, R>(effect: Effect.Effect<A, E | ControlPlaneError, R>) =>
  effect.pipe(
    Effect.mapError((error) =>
      mapMegapotStorageFailure<E, MegapotCutoffStorageFailed>(error, storage),
    ),
  );

function text(row: Row, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${field}`);
  return value;
}

function nullableText(row: Row, field: string): string | null {
  const value = row[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${field}`);
  return value;
}

function integer(row: Row, field: string): number {
  const value = row[field];
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`invalid ${field}`);
  return parsed;
}

function bigint(row: Row, field: string): bigint {
  const value = row[field];
  if (
    (typeof value !== "string" && typeof value !== "bigint" && typeof value !== "number") ||
    !/^[0-9]+$/u.test(String(value))
  ) {
    throw new Error(`invalid ${field}`);
  }
  return BigInt(value);
}

function bool(row: Row, field: string): boolean {
  const value = row[field];
  if (typeof value !== "boolean") throw new Error(`invalid ${field}`);
  return value;
}

function instant(row: Row, field: string): string {
  const value = row[field];
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  throw new Error(`invalid ${field}`);
}

function textArray(row: Row, field: string): readonly string[] {
  const value = row[field];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string")
  ) {
    throw new Error(`invalid ${field}`);
  }
  return value as readonly string[];
}

function beneficiary(row: Row): MegapotCutoffBeneficiary {
  return { accountId: text(row, "account_id"), personaId: text(row, "persona_id") };
}

const DUE_SELECT = `
  SELECT drawing.pool_leg_id, drawing.drawing_id, drawing.version,
         drawing.entry_cutoff_at, leg.leg_terms_hash, leg.empty_pool_policy,
         leg.funding_source, leg.fallback_beneficiary_account_id,
         coalesce(leg.fallback_payout_persona_id, fallback_persona.persona_id)
           AS fallback_persona_id
    FROM megapot_pool_drawings drawing
    JOIN song_reward_offer_legs leg ON leg.leg_id=drawing.pool_leg_id
    LEFT JOIN LATERAL (
      SELECT persona_id FROM personas
       WHERE account_id=leg.fallback_beneficiary_account_id
       ORDER BY is_first_persona DESC, created_at, persona_id LIMIT 1
    ) fallback_persona ON true
   WHERE drawing.status='entry_open' AND drawing.entry_cutoff_at <= $1::timestamptz
   ORDER BY drawing.entry_cutoff_at, drawing.pool_leg_id, drawing.drawing_id
   LIMIT $2`;

function candidateFromRow(
  row: Row,
  shares: readonly MegapotCutoffBeneficiary[],
): MegapotCutoffCandidate {
  const emptyPoolPolicy = text(row, "empty_pool_policy");
  const fundingSource = text(row, "funding_source");
  if (emptyPoolPolicy !== "no_purchase" && emptyPoolPolicy !== "funder_fallback") {
    throw new Error("invalid empty pool policy");
  }
  if (fundingSource !== "leg_budget" && fundingSource !== "shared_sponsor_budget") {
    throw new Error("invalid funding source");
  }
  const fallbackAccountId = nullableText(row, "fallback_beneficiary_account_id");
  const fallbackPersonaId = nullableText(row, "fallback_persona_id");
  return {
    poolLegId: text(row, "pool_leg_id"),
    drawingId: bigint(row, "drawing_id"),
    version: integer(row, "version"),
    entryCutoffAt: instant(row, "entry_cutoff_at"),
    termsHash: text(row, "leg_terms_hash"),
    emptyPoolPolicy,
    fundingSource,
    fallbackBeneficiary:
      fallbackAccountId === null || fallbackPersonaId === null
        ? null
        : { accountId: fallbackAccountId, personaId: fallbackPersonaId },
    shares,
  };
}

function sameBeneficiaries(
  left: readonly MegapotCutoffBeneficiary[],
  right: readonly MegapotCutoffBeneficiary[],
): boolean {
  const normalize = (values: readonly MegapotCutoffBeneficiary[]) =>
    values
      .map((value) => `${value.accountId}\u0000${value.personaId}`)
      .sort()
      .join("\u0001");
  return normalize(left) === normalize(right);
}

function resultFromRow(row: Row): MegapotCutoffResult {
  const status = text(row, "status");
  if (
    status !== "cutoff_frozen" &&
    status !== "closed_no_entries" &&
    status !== "closed_unfunded" &&
    status !== "closed_fallback_ineligible" &&
    status !== "closed_fallback_unavailable" &&
    status !== "closed_fallback_ceiling"
  ) {
    throw new Error("invalid cutoff status");
  }
  return {
    poolLegId: text(row, "pool_leg_id"),
    drawingId: bigint(row, "drawing_id"),
    version: integer(row, "version"),
    status,
    frozenShareCount: integer(row, "frozen_share_count"),
    fallback: bool(row, "fallback_beneficiary"),
    reservedTicketCostAtomic: bigint(row, "reserved_ticket_cost_atomic"),
    snapshotId: nullableText(row, "snapshot_id"),
    snapshotHash: nullableText(row, "snapshot_hash"),
    terminalReason: nullableText(row, "terminal_reason"),
  };
}

function closeDrawing(
  transaction: ControlPlaneTransaction,
  input: {
    readonly poolLegId: string;
    readonly drawingId: bigint;
    readonly currentVersion: number;
    readonly status: Exclude<MegapotCutoffResult["status"], "cutoff_frozen">;
    readonly reason: string;
    readonly frozenAt: string;
    readonly shareCount: number;
  },
): Effect.Effect<MegapotCutoffResult, MegapotCutoffFailure | ControlPlaneError> {
  return Effect.gen(function* () {
    const nextVersion = input.currentVersion + 1;
    yield* transaction.execute({
      label: "megapot-cutoff.transition.close",
      text: `INSERT INTO megapot_pool_drawing_transitions (
               pool_leg_id, drawing_id, target_version, event_type, event
             ) VALUES ($1,$2,$3,'cutoff',$4::jsonb)`,
      values: [
        input.poolLegId,
        input.drawingId.toString(),
        nextVersion,
        JSON.stringify({ type: "cutoff", outcome: input.status, reason: input.reason }),
      ],
      readonly: false,
    });
    const updated = yield* transaction.execute<Row>({
      label: "megapot-cutoff.drawing.close",
      text: `UPDATE megapot_pool_drawings
                SET status=$4, version=$3, frozen_share_count=$5,
                    fallback_beneficiary=false, terminal_reason=$6,
                    cutoff_frozen_at=$7::timestamptz, terminal_at=$7::timestamptz,
                    updated_at=clock_timestamp()
              WHERE pool_leg_id=$1 AND drawing_id=$2 AND status='entry_open'
                AND version=$3-1
          RETURNING pool_leg_id, drawing_id, version, status, frozen_share_count,
                    fallback_beneficiary, reserved_ticket_cost_atomic, snapshot_id,
                    NULL::text AS snapshot_hash, terminal_reason`,
      values: [
        input.poolLegId,
        input.drawingId.toString(),
        nextVersion,
        input.status,
        input.shareCount,
        input.reason,
        input.frozenAt,
      ],
      readonly: false,
    });
    if (updated.rows.length !== 1) return yield* rejected("cutoff-conflict");
    return yield* Effect.try({
      try: () => resultFromRow(updated.rows[0] as Row),
      catch: () => storage("invalid-row"),
    });
  });
}

function hashDocument(value: unknown): string {
  return sha256(toBytes(JSON.stringify(value))).slice(2);
}

function snapshotId(snapshot: MegapotBeneficiarySnapshot): string {
  return `megapot_snapshot_${snapshot.published.snapshotHash.slice(2)}`;
}

export function makeControlPlaneMegapotCutoffRepository() {
  return {
    loadDue: (input: Parameters<MegapotCutoffStore["loadDue"]>[0]) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          const due = yield* db.execute<Row>({
            label: "megapot-cutoff.due.read",
            text: DUE_SELECT,
            values: [input.cutoffAtOrBefore, input.limit],
            readonly: true,
          });
          return yield* Effect.forEach(due.rows, (row) =>
            Effect.gen(function* () {
              const shares = yield* db.execute<Row>({
                label: "megapot-cutoff.shares.read",
                text: `SELECT account_id, persona_id FROM megapot_pool_shares
                        WHERE pool_leg_id=$1 AND drawing_id=$2
                        ORDER BY account_id, persona_id`,
                values: [text(row, "pool_leg_id"), text(row, "drawing_id")],
                readonly: true,
              });
              return yield* Effect.try({
                try: () => candidateFromRow(row, shares.rows.map(beneficiary)),
                catch: () => storage("invalid-row"),
              });
            }),
          );
        }),
      ),

    freeze: (input: Parameters<MegapotCutoffStore["freeze"]>[0]) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((transaction) =>
            Effect.gen(function* () {
              const current = yield* transaction.execute<Row>({
                label: "megapot-cutoff.drawing.lock",
                text: `SELECT drawing.pool_leg_id, drawing.drawing_id, drawing.version,
                              drawing.entry_cutoff_at, leg.leg_terms_hash,
                              leg.empty_pool_policy, leg.funding_source,
                              leg.fallback_beneficiary_account_id,
                              coalesce(leg.fallback_payout_persona_id,
                                fallback_persona.persona_id) AS fallback_persona_id,
                              leg.fallback_payout_persona_id, leg.funder_account_id,
                              leg.max_ticket_price_atomic, leg.funded_atomic,
                              leg.reserved_atomic, leg.spent_atomic,
                              leg.fulfilled_atomic, leg.refunded_atomic,
                              leg.chain_id, leg.token_address, leg.eligible_activities,
                              offer.community_id, offer.post_id, offer.audio_revision
                         FROM megapot_pool_drawings drawing
                         JOIN song_reward_offer_legs leg ON leg.leg_id=drawing.pool_leg_id
                         JOIN song_reward_offers offer ON offer.offer_id=leg.offer_id
                         LEFT JOIN LATERAL (
                           SELECT persona_id FROM personas
                            WHERE account_id=leg.fallback_beneficiary_account_id
                            ORDER BY is_first_persona DESC, created_at, persona_id LIMIT 1
                         ) fallback_persona ON true
                        WHERE drawing.pool_leg_id=$1 AND drawing.drawing_id=$2
                          AND drawing.status='entry_open' FOR UPDATE OF drawing, leg`,
                values: [input.candidate.poolLegId, input.candidate.drawingId.toString()],
                readonly: false,
              });
              if (current.rows.length !== 1) return yield* rejected("cutoff-conflict");
              const row = current.rows[0] as Row;
              if (
                integer(row, "version") !== input.candidate.version ||
                instant(row, "entry_cutoff_at") !== input.candidate.entryCutoffAt ||
                text(row, "leg_terms_hash") !== input.candidate.termsHash ||
                Date.parse(input.frozenAt) < Date.parse(input.candidate.entryCutoffAt)
              ) {
                return yield* rejected("cutoff-conflict");
              }
              const shareRows = yield* transaction.execute<Row>({
                label: "megapot-cutoff.shares.lock",
                text: `SELECT account_id, persona_id FROM megapot_pool_shares
                        WHERE pool_leg_id=$1 AND drawing_id=$2
                        ORDER BY account_id, persona_id FOR SHARE`,
                values: [input.candidate.poolLegId, input.candidate.drawingId.toString()],
                readonly: false,
              });
              const shares = shareRows.rows.map(beneficiary);
              if (!sameBeneficiaries(shares, input.candidate.shares)) {
                return yield* rejected("cutoff-conflict");
              }
              const shareCount = shares.length;
              const emptyPoolPolicy = text(row, "empty_pool_policy");
              const fundingSource = text(row, "funding_source");
              if (shareCount === 0 && emptyPoolPolicy === "no_purchase") {
                return yield* closeDrawing(transaction, {
                  poolLegId: input.candidate.poolLegId,
                  drawingId: input.candidate.drawingId,
                  currentVersion: input.candidate.version,
                  status: "closed_no_entries",
                  reason: "no_entries",
                  frozenAt: input.frozenAt,
                  shareCount,
                });
              }

              let fallbackDecision: Row | null = null;
              let availabilityRows: readonly Row[] = [];
              const fallback = shareCount === 0;
              if (fallback) {
                const eligibility = yield* transaction.execute<Row>({
                  label: "megapot-cutoff.fallback-eligibility.read",
                  text: `SELECT eligibility_decision_id, account_id, persona_id,
                                outcome, expires_at
                           FROM reward_eligibility_decisions
                          WHERE leg_id=$1 AND purpose='fallback_cutoff' AND drawing_id=$2
                          ORDER BY decided_at DESC, eligibility_decision_id DESC LIMIT 1 FOR SHARE`,
                  values: [input.candidate.poolLegId, input.candidate.drawingId.toString()],
                  readonly: false,
                });
                fallbackDecision = eligibility.rows[0] ?? null;
                if (
                  fallbackDecision === null ||
                  text(fallbackDecision, "outcome") !== "eligible" ||
                  Date.parse(instant(fallbackDecision, "expires_at")) <= Date.parse(input.frozenAt)
                ) {
                  return yield* closeDrawing(transaction, {
                    poolLegId: input.candidate.poolLegId,
                    drawingId: input.candidate.drawingId,
                    currentVersion: input.candidate.version,
                    status: "closed_fallback_ineligible",
                    reason: "fallback_ineligible",
                    frozenAt: input.frozenAt,
                    shareCount,
                  });
                }
                const discoverable = yield* transaction.execute<Row>({
                  label: "megapot-cutoff.discovery.read",
                  text: `SELECT EXISTS (
                           SELECT 1 FROM posts
                            WHERE community_id=$1 AND post_id=$2 AND post_type='song'
                              AND status='published' AND visibility='public'
                         ) AS discoverable`,
                  values: [text(row, "community_id"), text(row, "post_id")],
                  readonly: true,
                });
                const activities = textArray(row, "eligible_activities");
                const availability = yield* transaction.execute<Row>({
                  label: "megapot-cutoff.availability.read",
                  text: `SELECT requested.activity_key,
                                latest.availability_observation_id,
                                latest.state, latest.observed_at, latest.expires_at
                           FROM unnest($4::text[]) WITH ORDINALITY requested(activity_key, ordinal)
                           LEFT JOIN LATERAL (
                             SELECT availability_observation_id, state, observed_at, expires_at
                               FROM reward_activity_availability_observations
                              WHERE community_id=$1 AND post_id=$2 AND audio_revision=$3
                                AND activity_key=requested.activity_key
                              ORDER BY observed_at DESC, availability_observation_id DESC LIMIT 1
                           ) latest ON true
                          ORDER BY requested.ordinal`,
                  values: [
                    text(row, "community_id"),
                    text(row, "post_id"),
                    integer(row, "audio_revision"),
                    activities,
                  ],
                  readonly: true,
                });
                availabilityRows = availability.rows;
                const available =
                  discoverable.rows.length === 1 &&
                  bool(discoverable.rows[0] as Row, "discoverable") &&
                  availabilityRows.length === activities.length &&
                  availabilityRows.every(
                    (availabilityRow) =>
                      nullableText(availabilityRow, "availability_observation_id") !== null &&
                      text(availabilityRow, "state") === "available" &&
                      Date.parse(instant(availabilityRow, "observed_at")) <=
                        Date.parse(input.frozenAt) &&
                      Date.parse(instant(availabilityRow, "expires_at")) >
                        Date.parse(input.frozenAt),
                  );
                if (!available) {
                  return yield* closeDrawing(transaction, {
                    poolLegId: input.candidate.poolLegId,
                    drawingId: input.candidate.drawingId,
                    currentVersion: input.candidate.version,
                    status: "closed_fallback_unavailable",
                    reason: "fallback_unavailable",
                    frozenAt: input.frozenAt,
                    shareCount,
                  });
                }
              }

              if (input.snapshot === null) return yield* rejected("snapshot-required");
              const reserveAtomic = bigint(row, "max_ticket_price_atomic");
              const sponsorAccountId = text(row, "funder_account_id");
              if (fundingSource === "leg_budget") {
                const available =
                  bigint(row, "funded_atomic") -
                  bigint(row, "reserved_atomic") -
                  bigint(row, "spent_atomic") -
                  bigint(row, "fulfilled_atomic") -
                  bigint(row, "refunded_atomic");
                if (available < reserveAtomic) {
                  return yield* closeDrawing(transaction, {
                    poolLegId: input.candidate.poolLegId,
                    drawingId: input.candidate.drawingId,
                    currentVersion: input.candidate.version,
                    status: "closed_unfunded",
                    reason: "insufficient_budget",
                    frozenAt: input.frozenAt,
                    shareCount,
                  });
                }
              } else {
                const budget = yield* transaction.execute<Row>({
                  label: "megapot-cutoff.sponsorship-budget.lock",
                  text: `SELECT funded_atomic, winnings_credited_atomic, reserved_atomic,
                                spent_atomic, withdrawn_atomic
                           FROM platform_sponsorship_budgets
                          WHERE sponsor_account_id=$1 AND chain_id=$2
                            AND token_address=$3 FOR UPDATE`,
                  values: [sponsorAccountId, integer(row, "chain_id"), text(row, "token_address")],
                  readonly: false,
                });
                if (budget.rows.length !== 1) {
                  return yield* closeDrawing(transaction, {
                    poolLegId: input.candidate.poolLegId,
                    drawingId: input.candidate.drawingId,
                    currentVersion: input.candidate.version,
                    status: "closed_unfunded",
                    reason: "sponsor_budget_missing",
                    frozenAt: input.frozenAt,
                    shareCount,
                  });
                }
                const budgetRow = budget.rows[0] as Row;
                const available =
                  bigint(budgetRow, "funded_atomic") +
                  bigint(budgetRow, "winnings_credited_atomic") -
                  bigint(budgetRow, "reserved_atomic") -
                  bigint(budgetRow, "spent_atomic") -
                  bigint(budgetRow, "withdrawn_atomic");
                if (available < reserveAtomic) {
                  return yield* closeDrawing(transaction, {
                    poolLegId: input.candidate.poolLegId,
                    drawingId: input.candidate.drawingId,
                    currentVersion: input.candidate.version,
                    status: "closed_unfunded",
                    reason: "sponsor_budget_exhausted",
                    frozenAt: input.frozenAt,
                    shareCount,
                  });
                }
              }

              const needsDailyReservation = fundingSource === "shared_sponsor_budget" || fallback;
              let sponsorKind: "shared_platform" | "external_fallback" | null = null;
              const sponsorDay = input.frozenAt.slice(0, 10);
              if (needsDailyReservation) {
                sponsorKind =
                  fundingSource === "shared_sponsor_budget"
                    ? "shared_platform"
                    : "external_fallback";
                const ticketCeiling =
                  sponsorKind === "shared_platform"
                    ? input.sharedSponsorDailyTicketCeiling
                    : input.externalSponsorDailyTicketCeiling;
                const spendCeiling =
                  sponsorKind === "shared_platform"
                    ? input.sharedSponsorDailySpendCeilingAtomic
                    : input.externalSponsorDailySpendCeilingAtomic;
                yield* transaction.execute({
                  label: "megapot-cutoff.daily-total.create",
                  text: `INSERT INTO sponsor_daily_ticket_totals (
                           sponsor_account_id, sponsor_day, sponsor_kind,
                           ticket_ceiling, spend_ceiling_atomic
                         ) VALUES ($1,$2::date,$3,$4,$5)
                         ON CONFLICT (sponsor_account_id, sponsor_day, sponsor_kind) DO NOTHING`,
                  values: [
                    sponsorAccountId,
                    sponsorDay,
                    sponsorKind,
                    ticketCeiling,
                    spendCeiling.toString(),
                  ],
                  readonly: false,
                });
                const dailyReserved = yield* transaction.execute({
                  label: "megapot-cutoff.daily-total.reserve",
                  text: `UPDATE sponsor_daily_ticket_totals
                            SET reserved_ticket_count=reserved_ticket_count + 1,
                                reserved_spend_atomic=reserved_spend_atomic + $6,
                                updated_at=clock_timestamp()
                          WHERE sponsor_account_id=$1 AND sponsor_day=$2::date
                            AND sponsor_kind=$3 AND ticket_ceiling=$4
                            AND spend_ceiling_atomic=$5
                            AND confirmed_ticket_count + reserved_ticket_count
                                  - released_ticket_count + 1 <= ticket_ceiling
                            AND confirmed_spend_atomic + reserved_spend_atomic
                                  - released_spend_atomic + $6 <= spend_ceiling_atomic`,
                  values: [
                    sponsorAccountId,
                    sponsorDay,
                    sponsorKind,
                    ticketCeiling,
                    spendCeiling.toString(),
                    reserveAtomic.toString(),
                  ],
                  readonly: false,
                });
                if (dailyReserved.rowCount !== 1) {
                  return yield* closeDrawing(transaction, {
                    poolLegId: input.candidate.poolLegId,
                    drawingId: input.candidate.drawingId,
                    currentVersion: input.candidate.version,
                    status:
                      sponsorKind === "external_fallback"
                        ? "closed_fallback_ceiling"
                        : "closed_unfunded",
                    reason: "sponsor_daily_ceiling",
                    frozenAt: input.frozenAt,
                    shareCount,
                  });
                }
              }

              if (fundingSource === "leg_budget") {
                const reserved = yield* transaction.execute({
                  label: "megapot-cutoff.leg-budget.reserve",
                  text: `UPDATE song_reward_offer_legs
                            SET reserved_atomic=reserved_atomic + $2,
                                updated_at=clock_timestamp()
                          WHERE leg_id=$1
                            AND funded_atomic-reserved_atomic-spent_atomic
                              -fulfilled_atomic-refunded_atomic >= $2`,
                  values: [input.candidate.poolLegId, reserveAtomic.toString()],
                  readonly: false,
                });
                if (reserved.rowCount !== 1) return yield* storage("conflict");
              } else {
                const reserved = yield* transaction.execute<Row>({
                  label: "megapot-cutoff.sponsorship-budget.reserve",
                  text: `UPDATE platform_sponsorship_budgets
                            SET reserved_atomic=reserved_atomic + $2,
                                updated_at=clock_timestamp()
                          WHERE sponsor_account_id=$1
                            AND funded_atomic+winnings_credited_atomic-reserved_atomic
                              -spent_atomic-withdrawn_atomic >= $2
                      RETURNING funded_atomic, winnings_credited_atomic, reserved_atomic,
                                spent_atomic, withdrawn_atomic`,
                  values: [sponsorAccountId, reserveAtomic.toString()],
                  readonly: false,
                });
                if (reserved.rows.length !== 1) return yield* storage("conflict");
                const budgetRow = reserved.rows[0] as Row;
                yield* transaction.execute({
                  label: "megapot-cutoff.sponsorship-entry.create",
                  text: `INSERT INTO platform_sponsorship_budget_entries (
                           budget_entry_id, sponsor_account_id, entry_kind,
                           amount_atomic, source_reference, balance_hash
                         ) VALUES ($1,$2,'purchase_reserved',$3,$4,$5)`,
                  values: [
                    `sponsor_reserve_${hashDocument({
                      pool_leg_id: input.candidate.poolLegId,
                      drawing_id: input.candidate.drawingId.toString(),
                    })}`,
                    sponsorAccountId,
                    reserveAtomic.toString(),
                    `${input.candidate.poolLegId}:${input.candidate.drawingId}`,
                    hashDocument({
                      funded: bigint(budgetRow, "funded_atomic").toString(),
                      winnings: bigint(budgetRow, "winnings_credited_atomic").toString(),
                      reserved: bigint(budgetRow, "reserved_atomic").toString(),
                      spent: bigint(budgetRow, "spent_atomic").toString(),
                      withdrawn: bigint(budgetRow, "withdrawn_atomic").toString(),
                    }),
                  ],
                  readonly: false,
                });
              }

              if (fallback && fallbackDecision !== null && sponsorKind !== null) {
                const publicEvidenceHash = hashDocument({
                  community_id: text(row, "community_id"),
                  post_id: text(row, "post_id"),
                  audio_revision: integer(row, "audio_revision"),
                  status: "published",
                  visibility: "public",
                  checked_at: input.frozenAt,
                });
                const availabilitySetHash = hashDocument(
                  availabilityRows.map((availabilityRow) => ({
                    activity_key: text(availabilityRow, "activity_key"),
                    observation_id: text(availabilityRow, "availability_observation_id"),
                  })),
                );
                yield* transaction.execute({
                  label: "megapot-cutoff.fallback-evidence.create",
                  text: `INSERT INTO megapot_fallback_cutoff_evidence (
                           pool_leg_id, drawing_id, sponsor_account_id,
                           payout_persona_id, eligibility_decision_id, sponsor_day,
                           sponsor_kind, public_discovery_evidence_hash,
                           availability_set_hash, checked_at
                         ) VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10::timestamptz)`,
                  values: [
                    input.candidate.poolLegId,
                    input.candidate.drawingId.toString(),
                    sponsorAccountId,
                    nullableText(row, "fallback_payout_persona_id"),
                    text(fallbackDecision, "eligibility_decision_id"),
                    sponsorDay,
                    sponsorKind,
                    publicEvidenceHash,
                    availabilitySetHash,
                    input.frozenAt,
                  ],
                  readonly: false,
                });
                for (const availabilityRow of availabilityRows) {
                  yield* transaction.execute({
                    label: "megapot-cutoff.fallback-activity-evidence.create",
                    text: `INSERT INTO megapot_fallback_cutoff_activity_evidence (
                             pool_leg_id, drawing_id, activity_key,
                             availability_observation_id
                           ) VALUES ($1,$2,$3,$4)`,
                    values: [
                      input.candidate.poolLegId,
                      input.candidate.drawingId.toString(),
                      text(availabilityRow, "activity_key"),
                      text(availabilityRow, "availability_observation_id"),
                    ],
                    readonly: false,
                  });
                }
              }

              const targetSnapshotId = snapshotId(input.snapshot);
              yield* transaction.execute({
                label: "megapot-cutoff.snapshot.create",
                text: `INSERT INTO megapot_pool_beneficiary_snapshots (
                         snapshot_id, pool_leg_id, drawing_id, domain, terms_hash,
                         algorithm_version, fallback, leaf_count, snapshot_hash,
                         published_artifact, frozen_at
                       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::timestamptz)`,
                values: [
                  targetSnapshotId,
                  input.candidate.poolLegId,
                  input.candidate.drawingId.toString(),
                  input.snapshot.published.domain,
                  input.snapshot.published.termsHash,
                  input.snapshot.published.algorithmVersion,
                  input.snapshot.published.fallback,
                  input.snapshot.published.leafCount,
                  input.snapshot.published.snapshotHash,
                  JSON.stringify(input.snapshot.published),
                  input.frozenAt,
                ],
                readonly: false,
              });
              for (const [ordinal, leaf] of input.snapshot.privateLeaves.entries()) {
                yield* transaction.execute({
                  label: "megapot-cutoff.snapshot-leaf.create",
                  text: `INSERT INTO megapot_pool_snapshot_private_leaves (
                           snapshot_id, ordinal, account_id, persona_id,
                           order_key, leaf_commitment
                         ) VALUES ($1,$2,$3,$4,$5,$6)`,
                  values: [
                    targetSnapshotId,
                    ordinal,
                    leaf.accountId,
                    leaf.personaId,
                    leaf.orderKey,
                    leaf.leafCommitment,
                  ],
                  readonly: false,
                });
              }
              const nextVersion = input.candidate.version + 1;
              yield* transaction.execute({
                label: "megapot-cutoff.transition.freeze",
                text: `INSERT INTO megapot_pool_drawing_transitions (
                         pool_leg_id, drawing_id, target_version, event_type, event
                       ) VALUES ($1,$2,$3,'cutoff',$4::jsonb)`,
                values: [
                  input.candidate.poolLegId,
                  input.candidate.drawingId.toString(),
                  nextVersion,
                  JSON.stringify({
                    type: "cutoff",
                    snapshot_hash: input.snapshot.published.snapshotHash,
                    fallback,
                    share_count: shareCount,
                  }),
                ],
                readonly: false,
              });
              const updated = yield* transaction.execute<Row>({
                label: "megapot-cutoff.drawing.freeze",
                text: `UPDATE megapot_pool_drawings
                          SET status='cutoff_frozen', version=$3,
                              reserved_ticket_cost_atomic=$4,
                              frozen_share_count=$5, fallback_beneficiary=$6,
                              snapshot_id=$7, cutoff_frozen_at=$8::timestamptz,
                              updated_at=clock_timestamp()
                        WHERE pool_leg_id=$1 AND drawing_id=$2
                          AND status='entry_open' AND version=$3-1
                    RETURNING pool_leg_id, drawing_id, version, status,
                              frozen_share_count, fallback_beneficiary,
                              reserved_ticket_cost_atomic, snapshot_id,
                              $9::text AS snapshot_hash, terminal_reason`,
                values: [
                  input.candidate.poolLegId,
                  input.candidate.drawingId.toString(),
                  nextVersion,
                  reserveAtomic.toString(),
                  shareCount,
                  fallback,
                  targetSnapshotId,
                  input.frozenAt,
                  input.snapshot.published.snapshotHash,
                ],
                readonly: false,
              });
              if (updated.rows.length !== 1) return yield* rejected("cutoff-conflict");
              return yield* Effect.try({
                try: () => resultFromRow(updated.rows[0] as Row),
                catch: () => storage("invalid-row"),
              });
            }),
          );
        }),
      ),
  };
}

export const makeControlPlaneMegapotCutoffStore = (
  layer: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): MegapotCutoffStore => {
  const repository = makeControlPlaneMegapotCutoffRepository();
  const provide = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    mapped(Effect.provide(layer)(effect));
  return {
    loadDue: (input) => provide(repository.loadDue(input)),
    freeze: (input) => provide(repository.freeze(input)),
  };
};
