import {
  ControlPlaneDb,
  type ControlPlaneError,
  type MegapotDrawingLifecycleStatus,
  type MegapotParticipantStandingState,
  type MegapotPoolProjectionState,
  type MegapotPoolStanding,
  type MegapotSponsorFallbackState,
  type PublicMegapotDrawingProjection,
  type PublicSongAssetBonusProjection,
  type PublicSongMegapotPoolProjection,
  type RewardCredit,
  type RewardCreditState,
  RewardProjectionRejected,
  RewardProjectionStorageFailed,
  type RewardProjectionStore,
} from "@pirate/application";
import { Effect, type Layer } from "effect";

type Row = Readonly<Record<string, unknown>>;
type InternalMegapotDrawingLifecycleStatus =
  | MegapotDrawingLifecycleStatus
  | "closed_purchase_unavailable";

const storage = (reason: RewardProjectionStorageFailed["reason"]) =>
  new RewardProjectionStorageFailed({ reason });
const rejected = (reason: RewardProjectionRejected["reason"]) =>
  new RewardProjectionRejected({ reason });

function mapError(error: ControlPlaneError): RewardProjectionStorageFailed {
  if (error._tag === "ControlPlaneTransactionOutcomeUnknown") return storage("outcome-unknown");
  if (error._tag === "ControlPlaneOperationTimedOut" && error.outcomeCertainty === "unknown") {
    return storage("outcome-unknown");
  }
  return storage("unavailable");
}

const mapped = <A, E, R>(effect: Effect.Effect<A, E | ControlPlaneError, R>) =>
  effect.pipe(
    Effect.mapError((error) =>
      typeof error === "object" && error !== null && "_tag" in error
        ? error._tag === "ControlPlaneAcquireFailed" ||
          error._tag === "ControlPlaneOperationTimedOut" ||
          error._tag === "ControlPlaneStatementFailed" ||
          error._tag === "ControlPlaneTransactionOutcomeUnknown"
          ? mapError(error as ControlPlaneError)
          : (error as E)
        : (error as E),
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
  return text(row, field);
}

function integer(row: Row, field: string): number {
  const value = Number(row[field]);
  if (!Number.isSafeInteger(value)) throw new Error(`invalid ${field}`);
  return value;
}

function bigint(row: Row, field: string): bigint {
  const value = String(row[field]);
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new Error(`invalid ${field}`);
  return BigInt(value);
}

function nullableBigint(row: Row, field: string): bigint | null {
  return row[field] === null || row[field] === undefined ? null : bigint(row, field);
}

function bool(row: Row, field: string): boolean {
  const value = row[field];
  if (typeof value !== "boolean") throw new Error(`invalid ${field}`);
  return value;
}

function iso(row: Row, field: string): string {
  const value = row[field];
  const instant = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(instant.getTime())) throw new Error(`invalid ${field}`);
  return instant.toISOString();
}

function nullableIso(row: Row, field: string): string | null {
  return row[field] === null || row[field] === undefined ? null : iso(row, field);
}

const drawingStatuses = new Set<InternalMegapotDrawingLifecycleStatus>([
  "entry_open",
  "cutoff_frozen",
  "committed",
  "purchase_pending",
  "tickets_confirmed",
  "drawing_pending",
  "no_win",
  "winnings_detected",
  "claim_pending",
  "claimed",
  "allocated",
  "credited",
  "closed_no_entries",
  "closed_unfunded",
  "closed_fallback_ineligible",
  "closed_fallback_unavailable",
  "closed_fallback_ceiling",
  "closed_purchase_unavailable",
  "operational_hold",
]);

const creditStates = new Set<RewardCreditState>([
  "credited",
  "payout_reserved",
  "payout_pending",
  "sent",
  "reconciliation_required",
]);

function drawingStatus(row: Row): InternalMegapotDrawingLifecycleStatus {
  const value = text(row, "drawing_status") as InternalMegapotDrawingLifecycleStatus;
  if (!drawingStatuses.has(value)) throw new Error("invalid drawing status");
  return value;
}

function creditState(row: Row): RewardCreditState | null {
  const value = nullableText(row, "credit_state") as RewardCreditState | null;
  if (value !== null && !creditStates.has(value)) throw new Error("invalid credit state");
  return value;
}

function publicState(status: InternalMegapotDrawingLifecycleStatus): MegapotPoolProjectionState {
  if (status === "entry_open") return "entry_open";
  if (
    status === "cutoff_frozen" ||
    status === "closed_no_entries" ||
    status === "closed_unfunded" ||
    status === "closed_fallback_ineligible" ||
    status === "closed_fallback_unavailable" ||
    status === "closed_fallback_ceiling" ||
    status === "closed_purchase_unavailable"
  ) {
    return "entry_closed";
  }
  if (status === "committed" || status === "purchase_pending") return "committed";
  if (status === "tickets_confirmed") return "ticket_purchased";
  if (status === "drawing_pending") return "drawing_pending";
  if (status === "no_win") return "no_win";
  if (
    status === "winnings_detected" ||
    status === "claim_pending" ||
    status === "claimed" ||
    status === "allocated" ||
    status === "credited"
  ) {
    return "won";
  }
  return "operational_hold";
}

function drawingFromRow(row: Row): PublicMegapotDrawingProjection | null {
  if (row.drawing_id === null || row.drawing_id === undefined) return null;
  const lifecycleStatus = drawingStatus(row);
  const grossPrizePoolAtomic = nullableBigint(row, "gross_prize_pool_atomic");
  const globalTicketsBought = nullableBigint(row, "global_tickets_bought");
  const prizePoolObservedAt = nullableIso(row, "prize_pool_observed_at");
  if (
    (grossPrizePoolAtomic === null) !== (globalTicketsBought === null) ||
    (grossPrizePoolAtomic === null) !== (prizePoolObservedAt === null)
  ) {
    throw new Error("invalid prize pool projection tuple");
  }
  return {
    drawingId: bigint(row, "drawing_id"),
    lifecycleStatus:
      lifecycleStatus === "closed_purchase_unavailable" ? "operational_hold" : lifecycleStatus,
    state: publicState(lifecycleStatus),
    entryCutoffAt: iso(row, "entry_cutoff_at"),
    beneficiaryCount: integer(row, "beneficiary_count"),
    ticketPriceCeilingAtomic: bigint(row, "ticket_price_ceiling_atomic"),
    actualTicketCostAtomic: bigint(row, "actual_ticket_cost_atomic"),
    grossPrizePoolAtomic,
    globalTicketsBought,
    prizePoolObservedAt,
    prizePoolBasis: "gross_observed_before_referral_win_share_terminal_last_observed_pre_rollover",
    globalTicketsBasis: "drawing_wide_all_megapot_buyers",
    netWinningsAtomic: bigint(row, "net_winnings_atomic"),
    commitmentReference: nullableText(row, "commitment_reference"),
    snapshotHash: nullableText(row, "snapshot_hash"),
    ticketId: nullableBigint(row, "ticket_id"),
    purchaseTransactionHash: nullableText(row, "purchase_transaction_hash"),
    claimTransactionHash: nullableText(row, "claim_transaction_hash"),
  };
}

function publicPoolFromRow(row: Row): PublicSongMegapotPoolProjection {
  const offerStatus = text(row, "offer_status");
  const legStatus = text(row, "leg_status");
  const activities = row.eligible_activities;
  const emptyPoolPolicy = text(row, "empty_pool_policy");
  const fundingSource = text(row, "funding_source");
  if (
    !["active", "paused", "exhausted", "expired", "ended", "operational_hold"].includes(
      offerStatus,
    ) ||
    !["funding", "active", "paused", "exhausted", "ended", "operational_hold"].includes(
      legStatus,
    ) ||
    !Array.isArray(activities) ||
    activities.length === 0 ||
    !activities.every((activity) => activity === "study" || activity === "karaoke") ||
    (emptyPoolPolicy !== "no_purchase" && emptyPoolPolicy !== "funder_fallback") ||
    (fundingSource !== "leg_budget" && fundingSource !== "shared_sponsor_budget")
  ) {
    throw new Error("invalid public pool row");
  }
  return {
    offerId: text(row, "offer_id"),
    legId: text(row, "leg_id"),
    communityId: text(row, "community_id"),
    postId: text(row, "post_id"),
    offerStatus: offerStatus as PublicSongMegapotPoolProjection["offerStatus"],
    legStatus: legStatus as PublicSongMegapotPoolProjection["legStatus"],
    chainId: integer(row, "chain_id"),
    tokenAddress: text(row, "token_address"),
    tokenDecimals: integer(row, "token_decimals"),
    fundedAtomic: bigint(row, "funded_atomic"),
    availableBudgetAtomic: bigint(row, "available_budget_atomic"),
    maxTicketPriceAtomic: bigint(row, "max_ticket_price_atomic"),
    entryCutoffSeconds: integer(row, "entry_cutoff_seconds"),
    eligibleActivities: activities,
    minScoreBps: integer(row, "min_score_bps"),
    emptyPoolPolicy,
    fundingSource,
    drawing: drawingFromRow(row),
  };
}

function participantState(input: {
  readonly lifecycleStatus: InternalMegapotDrawingLifecycleStatus | null;
  readonly shareHeld: boolean;
  readonly allocationAmountAtomic: bigint | null;
  readonly creditState: RewardCreditState | null;
}): MegapotParticipantStandingState {
  if (input.lifecycleStatus === "operational_hold") return "operational_hold";
  if (input.creditState === "sent") return "sent";
  if (
    input.creditState === "payout_reserved" ||
    input.creditState === "payout_pending" ||
    input.creditState === "reconciliation_required"
  ) {
    return "payout_pending";
  }
  if (input.allocationAmountAtomic !== null || input.creditState === "credited") return "won";
  if (input.lifecycleStatus === null) return "entry_closed";
  if (input.lifecycleStatus === "entry_open") {
    return input.shareHeld ? "your_share_held" : "entry_open";
  }
  if (!input.shareHeld) return "entry_closed";
  if (input.lifecycleStatus === "cutoff_frozen" || input.lifecycleStatus === "committed") {
    return "committed";
  }
  if (input.lifecycleStatus === "purchase_pending") return "committed";
  if (input.lifecycleStatus === "tickets_confirmed") return "ticket_purchased";
  if (input.lifecycleStatus === "drawing_pending") return "drawing_pending";
  if (input.lifecycleStatus === "no_win") return "no_win";
  if (
    input.lifecycleStatus === "winnings_detected" ||
    input.lifecycleStatus === "claim_pending" ||
    input.lifecycleStatus === "claimed" ||
    input.lifecycleStatus === "allocated" ||
    input.lifecycleStatus === "credited"
  ) {
    return "won";
  }
  return "entry_closed";
}

function sponsorState(input: {
  readonly sponsor: boolean;
  readonly lifecycleStatus: InternalMegapotDrawingLifecycleStatus | null;
  readonly beneficiaryCount: number;
  readonly fallbackBeneficiary: boolean | null;
  readonly allocationAmountAtomic: bigint | null;
  readonly creditState: RewardCreditState | null;
}): MegapotSponsorFallbackState | null {
  if (!input.sponsor) return null;
  if (input.creditState === "sent") return "sent";
  if (
    input.creditState === "payout_reserved" ||
    input.creditState === "payout_pending" ||
    input.creditState === "reconciliation_required"
  ) {
    return "payout_pending";
  }
  if (input.allocationAmountAtomic !== null || input.creditState === "credited") {
    return "fallback_won";
  }
  if (input.lifecycleStatus === "closed_fallback_ceiling") return "fallback_ceiling";
  if (
    input.lifecycleStatus === "closed_fallback_ineligible" ||
    input.lifecycleStatus === "closed_fallback_unavailable" ||
    input.lifecycleStatus === "closed_purchase_unavailable" ||
    input.lifecycleStatus === "operational_hold"
  ) {
    return "fallback_unavailable";
  }
  if (
    input.beneficiaryCount > 0 &&
    (input.lifecycleStatus === "entry_open" || input.fallbackBeneficiary === false)
  ) {
    return "fallback_displaced";
  }
  if (input.fallbackBeneficiary === false) return "fallback_displaced";
  return "fallback_active";
}

function standingFromRow(row: Row): MegapotPoolStanding {
  const lifecycleStatus =
    row.drawing_id === null || row.drawing_id === undefined ? null : drawingStatus(row);
  const shareHeld = bool(row, "share_held");
  const allocationAmountAtomic = nullableBigint(row, "allocation_amount_atomic");
  const currentCreditState = creditState(row);
  const beneficiaryCount = integer(row, "beneficiary_count");
  const sponsor = bool(row, "fallback_sponsor");
  const fallbackBeneficiary =
    row.fallback_beneficiary === null || row.fallback_beneficiary === undefined
      ? null
      : bool(row, "fallback_beneficiary");
  return {
    legId: text(row, "leg_id"),
    drawingId: nullableBigint(row, "drawing_id"),
    participantState: participantState({
      lifecycleStatus,
      shareHeld,
      allocationAmountAtomic,
      creditState: currentCreditState,
    }),
    shareHeld,
    shareAmountAtomic: shareHeld ? allocationAmountAtomic : null,
    sponsorFallbackState: sponsorState({
      sponsor,
      lifecycleStatus,
      beneficiaryCount,
      fallbackBeneficiary,
      allocationAmountAtomic,
      creditState: currentCreditState,
    }),
    sponsorFallbackAmountAtomic: sponsor && fallbackBeneficiary ? allocationAmountAtomic : null,
    rewardCreditId: nullableText(row, "credit_id"),
    rewardCreditState: currentCreditState,
    beneficiaryCount,
  };
}

function rewardCreditFromRow(row: Row): RewardCredit {
  const state = text(row, "state") as RewardCreditState;
  const sourceKind = text(row, "source_kind");
  if (
    !creditStates.has(state) ||
    !["megapot_allocation", "asset_bonus", "external_fallback"].includes(sourceKind)
  ) {
    throw new Error("invalid reward credit row");
  }
  return {
    creditId: text(row, "credit_id"),
    payoutPersonaId: text(row, "payout_persona_id"),
    chainId: integer(row, "chain_id"),
    tokenAddress: text(row, "token_address"),
    tokenDecimals: integer(row, "token_decimals"),
    amountAtomic: bigint(row, "amount_atomic"),
    reservedAtomic: bigint(row, "reserved_atomic"),
    paidAtomic: bigint(row, "paid_atomic"),
    sourceKind: sourceKind as RewardCredit["sourceKind"],
    state,
    createdAt: iso(row, "created_at"),
    updatedAt: iso(row, "updated_at"),
    settledAt: nullableIso(row, "settled_at"),
  };
}

function assetBonusFromRow(row: Row): PublicSongAssetBonusProjection {
  const offerStatus = text(row, "offer_status");
  const legStatus = text(row, "leg_status");
  const viewerState = nullableText(row, "viewer_state");
  const viewerCreditState = nullableText(row, "viewer_credit_state");
  if (
    !["active", "paused", "exhausted", "expired", "ended", "operational_hold"].includes(
      offerStatus,
    ) ||
    !["funding", "active", "paused", "exhausted", "ended", "operational_hold"].includes(
      legStatus,
    ) ||
    (viewerState !== null &&
      !["claimable", "already_claimed", "unavailable"].includes(viewerState)) ||
    (viewerCreditState !== null && !creditStates.has(viewerCreditState as RewardCreditState))
  ) {
    throw new Error("invalid asset bonus projection row");
  }
  return {
    offerId: text(row, "offer_id"),
    legId: text(row, "leg_id"),
    communityId: text(row, "community_id"),
    postId: text(row, "post_id"),
    offerStatus: offerStatus as PublicSongAssetBonusProjection["offerStatus"],
    legStatus: legStatus as PublicSongAssetBonusProjection["legStatus"],
    chainId: integer(row, "chain_id"),
    tokenAddress: text(row, "token_address"),
    tokenDecimals: integer(row, "token_decimals"),
    tokenSymbol: text(row, "token_symbol"),
    assetPolicyVersion: text(row, "asset_policy_version"),
    amountPerClaimAtomic: bigint(row, "amount_per_claim_atomic"),
    maxClaims: integer(row, "max_claims"),
    claimedCount: integer(row, "claimed_count"),
    availableInventoryAtomic: bigint(row, "available_inventory_atomic"),
    viewerState: viewerState as PublicSongAssetBonusProjection["viewerState"],
    viewerCreditId: nullableText(row, "viewer_credit_id"),
    viewerCreditState: viewerCreditState as RewardCreditState | null,
  };
}

export function makeControlPlaneRewardProjectionRepository() {
  return {
    findPublicSongPool: (input: Parameters<RewardProjectionStore["findPublicSongPool"]>[0]) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          const result = yield* db.execute<Row>({
            label: "reward-projection.public-pool.read",
            text: `SELECT offer.offer_id, offer.community_id, offer.post_id,
                          offer.status AS offer_status, leg.leg_id, leg.status AS leg_status,
                          leg.chain_id, leg.token_address, leg.token_decimals,
                          leg.funded_atomic,
                          leg.funded_atomic-leg.reserved_atomic-leg.spent_atomic-
                            leg.fulfilled_atomic-leg.refunded_atomic AS available_budget_atomic,
                          leg.max_ticket_price_atomic, leg.entry_cutoff_seconds,
                          leg.eligible_activities, leg.min_score_bps, leg.empty_pool_policy,
                          leg.funding_source, drawing.drawing_id,
                          drawing.status AS drawing_status, drawing.entry_cutoff_at,
                          CASE
                            WHEN drawing.drawing_id IS NULL THEN 0
                            WHEN drawing.status='entry_open' THEN share_count.value
                            WHEN drawing.fallback_beneficiary THEN 0
                            ELSE coalesce(drawing.frozen_share_count,0)
                          END AS beneficiary_count,
                          drawing.ticket_price_ceiling_atomic,
                          drawing.actual_ticket_cost_atomic, drawing.net_winnings_atomic,
                          CASE
                            WHEN latest_observation.gross_prize_pool_atomic IS NOT NULL
                              AND (
                                drawing.terminal_at IS NOT NULL
                                OR latest_observation.expires_at > clock_timestamp()
                              )
                            THEN latest_observation.gross_prize_pool_atomic
                          END AS gross_prize_pool_atomic,
                          CASE
                            WHEN latest_observation.global_tickets_bought IS NOT NULL
                              AND (
                                drawing.terminal_at IS NOT NULL
                                OR latest_observation.expires_at > clock_timestamp()
                              )
                            THEN latest_observation.global_tickets_bought
                          END AS global_tickets_bought,
                          CASE
                            WHEN latest_observation.gross_prize_pool_atomic IS NOT NULL
                              AND (
                                drawing.terminal_at IS NOT NULL
                                OR latest_observation.expires_at > clock_timestamp()
                              )
                            THEN latest_observation.observed_at
                          END AS prize_pool_observed_at,
                          commitment.public_reference AS commitment_reference,
                          snapshot.snapshot_hash, ticket.ticket_id,
                          ticket.minted_transaction_hash AS purchase_transaction_hash,
                          ticket.claimed_transaction_hash AS claim_transaction_hash
                     FROM song_reward_offers offer
                     JOIN posts post ON post.community_id=offer.community_id
                       AND post.post_id=offer.post_id AND post.post_type='song'
                       AND post.status='published' AND post.visibility='public'
                     JOIN song_reward_offer_legs leg ON leg.offer_id=offer.offer_id
                       AND leg.kind='megapot_pool'
                     JOIN megapot_deployment_attestations attestation
                       ON attestation.attestation_id=leg.attestation_id
                     LEFT JOIN LATERAL (
                       SELECT candidate.* FROM megapot_pool_drawings candidate
                        WHERE candidate.pool_leg_id=leg.leg_id
                        ORDER BY candidate.drawing_id DESC LIMIT 1
                     ) drawing ON true
                     LEFT JOIN LATERAL (
                       SELECT observation.gross_prize_pool_atomic,
                              observation.global_tickets_bought,
                              observation.observed_at, observation.expires_at
                         FROM megapot_drawing_observations observation
                        WHERE observation.attestation_id=leg.attestation_id
                          AND observation.drawing_id=drawing.drawing_id
                        ORDER BY observation.block_number DESC,
                                 observation.observed_at DESC,
                                 observation.observation_id
                        LIMIT 1
                     ) latest_observation ON true
                     LEFT JOIN LATERAL (
                       SELECT count(*)::integer AS value FROM megapot_pool_shares share
                        WHERE share.pool_leg_id=leg.leg_id
                          AND share.drawing_id=drawing.drawing_id
                     ) share_count ON true
                     LEFT JOIN megapot_pool_beneficiary_snapshots snapshot
                       ON snapshot.snapshot_id=drawing.snapshot_id
                     LEFT JOIN megapot_pool_commitment_effects commitment
                       ON commitment.commitment_effect_id=drawing.commitment_effect_id
                      AND commitment.state='published'
                     LEFT JOIN megapot_ticket_inventory ticket
                       ON ticket.pool_leg_id=leg.leg_id AND ticket.drawing_id=drawing.drawing_id
                    WHERE offer.community_id=$1 AND offer.post_id=$2
                      AND offer.status <> 'draft'
                    ORDER BY (offer.status IN ('active','paused','operational_hold')) DESC,
                             (leg.status IN ('funding','active','paused','operational_hold')) DESC,
                             leg.created_at DESC, leg.leg_id DESC
                    LIMIT 1`,
            values: [input.communityId, input.postId],
            readonly: true,
          });
          if (result.rows.length === 0) return null;
          if (result.rows.length !== 1) return yield* Effect.fail(storage("invalid-row"));
          return yield* Effect.try({
            try: () => publicPoolFromRow(result.rows[0] as Row),
            catch: () => storage("invalid-row"),
          });
        }),
      ),

    listPublicSongAssetBonuses: (
      input: Parameters<RewardProjectionStore["listPublicSongAssetBonuses"]>[0],
    ) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          const result = yield* db.execute<Row>({
            label: "reward-projection.public-asset-bonuses.read",
            text: `SELECT offer.offer_id, offer.community_id, offer.post_id,
                          offer.status AS offer_status, leg.leg_id,
                          leg.status AS leg_status, leg.chain_id, leg.token_address,
                          leg.token_decimals, leg.token_symbol, leg.asset_policy_version,
                          leg.amount_per_claim_atomic, leg.max_claims,
                          leg.fulfilled_atomic / leg.amount_per_claim_atomic AS claimed_count,
                          leg.funded_atomic-leg.reserved_atomic-leg.spent_atomic-
                            leg.fulfilled_atomic-leg.refunded_atomic
                            AS available_inventory_atomic,
                          CASE
                            WHEN $1::text IS NULL THEN NULL
                            WHEN claim.account_id IS NOT NULL THEN 'already_claimed'
                            WHEN offer.status='active' AND leg.status='active'
                              AND clock_timestamp() >= offer.starts_at
                              AND clock_timestamp() < offer.ends_at
                              AND leg.fulfilled_atomic / leg.amount_per_claim_atomic < leg.max_claims
                              AND leg.funded_atomic-leg.reserved_atomic-leg.spent_atomic-
                                leg.fulfilled_atomic-leg.refunded_atomic
                                >= leg.amount_per_claim_atomic
                            THEN 'claimable' ELSE 'unavailable'
                          END AS viewer_state,
                          claim_leg.credit_id AS viewer_credit_id,
                          credit.state AS viewer_credit_state
                     FROM song_reward_offers offer
                     JOIN posts post ON post.community_id=offer.community_id
                       AND post.post_id=offer.post_id AND post.post_type='song'
                       AND post.status='published' AND post.visibility='public'
                     JOIN song_reward_offer_legs leg ON leg.offer_id=offer.offer_id
                       AND leg.kind='asset_bonus' AND leg.status <> 'draft'
                     LEFT JOIN song_reward_bundle_claims claim
                       ON claim.account_id=$1 AND claim.offer_id=offer.offer_id
                     LEFT JOIN song_reward_bundle_claim_legs claim_leg
                       ON claim_leg.account_id=claim.account_id
                      AND claim_leg.offer_id=claim.offer_id AND claim_leg.leg_id=leg.leg_id
                     LEFT JOIN reward_ledger_credits credit
                       ON credit.credit_id=claim_leg.credit_id
                    WHERE offer.community_id=$2 AND offer.post_id=$3
                      AND offer.status <> 'draft'
                    ORDER BY (offer.status IN ('active','paused','operational_hold')) DESC,
                             offer.created_at DESC, leg.created_at, leg.leg_id`,
            values: [input.accountId, input.communityId, input.postId],
            readonly: true,
          });
          return yield* Effect.try({
            try: () => result.rows.map((row) => assetBonusFromRow(row as Row)),
            catch: () => storage("invalid-row"),
          });
        }),
      ),

    findStanding: (input: Parameters<RewardProjectionStore["findStanding"]>[0]) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          const result = yield* db.execute<Row>({
            label: "reward-projection.standing.read",
            text: `SELECT leg.leg_id, drawing.drawing_id, drawing.status AS drawing_status,
                          CASE
                            WHEN drawing.status='entry_open' THEN live_share.account_id IS NOT NULL
                            WHEN coalesce(drawing.fallback_beneficiary,false) THEN false
                            ELSE frozen_share.account_id IS NOT NULL
                          END AS share_held,
                          allocation.amount_atomic AS allocation_amount_atomic,
                          allocation.credit_id, credit.state AS credit_state,
                          CASE
                            WHEN drawing.drawing_id IS NULL THEN 0
                            WHEN drawing.status='entry_open' THEN share_count.value
                            WHEN drawing.fallback_beneficiary THEN 0
                            ELSE coalesce(drawing.frozen_share_count,0)
                          END AS beneficiary_count,
                          drawing.fallback_beneficiary,
                          (leg.empty_pool_policy='funder_fallback'
                            AND leg.funding_source='leg_budget'
                            AND leg.funder_account_id=$1) AS fallback_sponsor
                     FROM song_reward_offer_legs leg
                     JOIN song_reward_offers offer ON offer.offer_id=leg.offer_id
                     LEFT JOIN LATERAL (
                       SELECT candidate.* FROM megapot_pool_drawings candidate
                        WHERE candidate.pool_leg_id=leg.leg_id
                        ORDER BY candidate.drawing_id DESC LIMIT 1
                     ) drawing ON true
                     LEFT JOIN megapot_pool_shares live_share
                       ON live_share.pool_leg_id=leg.leg_id
                      AND live_share.drawing_id=drawing.drawing_id
                      AND live_share.account_id=$1
                     LEFT JOIN megapot_pool_snapshot_private_leaves frozen_share
                       ON frozen_share.snapshot_id=drawing.snapshot_id
                      AND frozen_share.account_id=$1
                     LEFT JOIN LATERAL (
                       SELECT count(*)::integer AS value FROM megapot_pool_shares candidate
                        WHERE candidate.pool_leg_id=leg.leg_id
                          AND candidate.drawing_id=drawing.drawing_id
                     ) share_count ON true
                     LEFT JOIN megapot_allocations allocation
                       ON allocation.allocation_batch_id=drawing.allocation_batch_id
                      AND allocation.account_id=$1
                     LEFT JOIN reward_ledger_credits credit
                       ON credit.credit_id=allocation.credit_id AND credit.account_id=$1
                    WHERE leg.leg_id=$2 AND leg.kind='megapot_pool'
                      AND (
                        leg.funder_account_id=$1
                        OR EXISTS (
                          SELECT 1 FROM community_memberships membership
                           WHERE membership.community_id=offer.community_id
                             AND membership.user_id=$1 AND membership.status='member'
                        )
                        OR EXISTS (
                          SELECT 1 FROM megapot_pool_shares historical_share
                           WHERE historical_share.pool_leg_id=leg.leg_id
                             AND historical_share.account_id=$1
                        )
                      )`,
            values: [input.accountId, input.legId],
            readonly: true,
          });
          if (result.rows.length === 0) return null;
          if (result.rows.length !== 1) return yield* Effect.fail(storage("invalid-row"));
          return yield* Effect.try({
            try: () => standingFromRow(result.rows[0] as Row),
            catch: () => storage("invalid-row"),
          });
        }),
      ),

    listCredits: (input: Parameters<RewardProjectionStore["listCredits"]>[0]) =>
      mapped(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          let cursorCreatedAt: string | null = null;
          if (input.cursor !== null) {
            const cursor = yield* db.execute<Row>({
              label: "reward-projection.credit-cursor.read",
              text: `SELECT created_at FROM reward_ledger_credits
                      WHERE account_id=$1 AND credit_id=$2`,
              values: [input.accountId, input.cursor],
              readonly: true,
            });
            if (cursor.rows.length !== 1) return yield* rejected("invalid-cursor");
            cursorCreatedAt = iso(cursor.rows[0] as Row, "created_at");
          }
          const result = yield* db.execute<Row>({
            label: "reward-projection.credits.read",
            text: `SELECT credit.credit_id, credit.payout_persona_id, credit.chain_id,
                          credit.token_address, asset.decimals AS token_decimals,
                          credit.amount_atomic, credit.reserved_atomic, credit.paid_atomic,
                          credit.source_kind, credit.state, credit.created_at,
                          credit.updated_at, credit.settled_at
                     FROM reward_ledger_credits credit
                     JOIN reward_asset_whitelist asset
                       ON asset.chain_id=credit.chain_id
                      AND asset.token_address=credit.token_address
                    WHERE credit.account_id=$1
                      AND ($2::timestamptz IS NULL OR
                        (credit.created_at,credit.credit_id) < ($2::timestamptz,$3::text))
                    ORDER BY credit.created_at DESC, credit.credit_id DESC
                    LIMIT $4`,
            values: [input.accountId, cursorCreatedAt, input.cursor, input.limit + 1],
            readonly: true,
          });
          const decoded = yield* Effect.try({
            try: () => result.rows.map((row) => rewardCreditFromRow(row as Row)),
            catch: () => storage("invalid-row"),
          });
          const items = decoded.slice(0, input.limit);
          return {
            items,
            nextCursor: decoded.length > input.limit ? (items.at(-1)?.creditId ?? null) : null,
          };
        }),
      ),
  };
}

export function makeControlPlaneRewardProjectionStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): RewardProjectionStore {
  const repository = makeControlPlaneRewardProjectionRepository();
  const provide = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    mapped(Effect.provide(runtime)(effect));
  return {
    findPublicSongPool: (input) => provide(repository.findPublicSongPool(input)),
    listPublicSongAssetBonuses: (input) => provide(repository.listPublicSongAssetBonuses(input)),
    findStanding: (input) => provide(repository.findStanding(input)),
    listCredits: (input) => provide(repository.listCredits(input)),
  };
}
