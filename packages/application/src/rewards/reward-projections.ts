import { Data, type Effect } from "effect";

export class RewardProjectionStorageFailed extends Data.TaggedError(
  "RewardProjectionStorageFailed",
)<{
  readonly reason: "invalid-row" | "outcome-unknown" | "unavailable";
}> {}

export class RewardProjectionRejected extends Data.TaggedError("RewardProjectionRejected")<{
  readonly reason: "invalid-cursor" | "not-found";
}> {}

export type RewardProjectionFailure = RewardProjectionRejected | RewardProjectionStorageFailed;

export type MegapotDrawingLifecycleStatus =
  | "entry_open"
  | "cutoff_frozen"
  | "committed"
  | "purchase_pending"
  | "tickets_confirmed"
  | "drawing_pending"
  | "no_win"
  | "winnings_detected"
  | "claim_pending"
  | "claimed"
  | "allocated"
  | "credited"
  | "closed_no_entries"
  | "closed_unfunded"
  | "closed_fallback_ineligible"
  | "closed_fallback_unavailable"
  | "closed_fallback_ceiling"
  | "operational_hold";

export type MegapotPoolProjectionState =
  | "funding"
  | "awaiting_drawing"
  | "entry_open"
  | "entry_closed"
  | "committed"
  | "ticket_purchased"
  | "drawing_pending"
  | "no_win"
  | "won"
  | "operational_hold";

export type PublicMegapotDrawingProjection = Readonly<{
  drawingId: bigint;
  lifecycleStatus: MegapotDrawingLifecycleStatus;
  state: MegapotPoolProjectionState;
  entryCutoffAt: string;
  beneficiaryCount: number;
  ticketPriceCeilingAtomic: bigint;
  actualTicketCostAtomic: bigint;
  netWinningsAtomic: bigint;
  commitmentReference: string | null;
  snapshotHash: string | null;
  ticketId: bigint | null;
  purchaseTransactionHash: string | null;
  claimTransactionHash: string | null;
}>;

export type PublicSongMegapotPoolProjection = Readonly<{
  offerId: string;
  legId: string;
  communityId: string;
  postId: string;
  offerStatus: "active" | "paused" | "exhausted" | "expired" | "ended" | "operational_hold";
  legStatus: "funding" | "active" | "paused" | "exhausted" | "ended" | "operational_hold";
  chainId: number;
  tokenAddress: string;
  tokenDecimals: number;
  fundedAtomic: bigint;
  availableBudgetAtomic: bigint;
  maxTicketPriceAtomic: bigint;
  entryCutoffSeconds: number;
  eligibleActivities: readonly ("study" | "karaoke")[];
  minScoreBps: number;
  emptyPoolPolicy: "no_purchase" | "funder_fallback";
  fundingSource: "leg_budget" | "shared_sponsor_budget";
  drawing: PublicMegapotDrawingProjection | null;
}>;

export type MegapotParticipantStandingState =
  | "entry_open"
  | "entry_closed"
  | "your_share_held"
  | "committed"
  | "ticket_purchased"
  | "drawing_pending"
  | "no_win"
  | "won"
  | "payout_pending"
  | "sent"
  | "operational_hold";

export type MegapotSponsorFallbackState =
  | "fallback_active"
  | "fallback_displaced"
  | "fallback_won"
  | "fallback_unavailable"
  | "fallback_ceiling"
  | "payout_pending"
  | "sent";

export type RewardCreditState =
  | "credited"
  | "payout_reserved"
  | "payout_pending"
  | "sent"
  | "reconciliation_required";

export type MegapotPoolStanding = Readonly<{
  legId: string;
  drawingId: bigint | null;
  participantState: MegapotParticipantStandingState;
  shareHeld: boolean;
  shareAmountAtomic: bigint | null;
  sponsorFallbackState: MegapotSponsorFallbackState | null;
  sponsorFallbackAmountAtomic: bigint | null;
  rewardCreditId: string | null;
  rewardCreditState: RewardCreditState | null;
  beneficiaryCount: number;
}>;

export type RewardCredit = Readonly<{
  creditId: string;
  payoutPersonaId: string;
  chainId: number;
  tokenAddress: string;
  tokenDecimals: number;
  amountAtomic: bigint;
  reservedAtomic: bigint;
  paidAtomic: bigint;
  sourceKind: "megapot_allocation" | "asset_bonus" | "external_fallback";
  state: RewardCreditState;
  createdAt: string;
  updatedAt: string;
  settledAt: string | null;
}>;

export interface RewardProjectionStore {
  readonly findPublicSongPool: (input: {
    readonly communityId: string;
    readonly postId: string;
  }) => Effect.Effect<PublicSongMegapotPoolProjection | null, RewardProjectionFailure>;
  readonly findStanding: (input: {
    readonly accountId: string;
    readonly legId: string;
  }) => Effect.Effect<MegapotPoolStanding | null, RewardProjectionFailure>;
  readonly listCredits: (input: {
    readonly accountId: string;
    readonly cursor: string | null;
    readonly limit: number;
  }) => Effect.Effect<
    Readonly<{ items: readonly RewardCredit[]; nextCursor: string | null }>,
    RewardProjectionFailure
  >;
}
