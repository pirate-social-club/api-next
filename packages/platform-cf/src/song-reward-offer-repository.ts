import {
  type AssetBonusLeg,
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
  type MegapotPoolLeg,
  type SongRewardOffer,
  SongRewardOfferRejected,
  SongRewardOfferStorageFailed,
  type SongRewardOfferStore,
} from "@pirate/application";
import { VERY_WEB_ISSUER, VERY_WEB_METHOD, VERY_WEB_RP_SCOPE } from "@pirate/domain";
import { Effect, type Layer } from "effect";

type Row = Readonly<Record<string, unknown>>;

const storage = (reason: SongRewardOfferStorageFailed["reason"]) =>
  new SongRewardOfferStorageFailed({ reason });
const rejected = (reason: SongRewardOfferRejected["reason"]) =>
  new SongRewardOfferRejected({ reason });

function mapError(error: ControlPlaneError): SongRewardOfferStorageFailed {
  if (error._tag === "ControlPlaneTransactionOutcomeUnknown") return storage("outcome-unknown");
  if (error._tag === "ControlPlaneOperationTimedOut" && error.outcomeCertainty === "unknown") {
    return storage("outcome-unknown");
  }
  if (error._tag === "ControlPlaneStatementFailed" && error.sqlState === "23505") {
    return storage("conflict");
  }
  if (error._tag === "ControlPlaneStatementFailed" && error.sqlState !== null) {
    return storage("constraint");
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
  const value = row[field];
  if (!/^[0-9]+$/u.test(String(value))) throw new Error(`invalid ${field}`);
  return BigInt(String(value));
}

function timestamp(row: Row, field: string): string {
  const value = row[field];
  const instant = value instanceof Date ? value.toISOString() : String(value);
  if (!Number.isFinite(Date.parse(instant))) throw new Error(`invalid ${field}`);
  return new Date(instant).toISOString();
}

const OFFER_SELECT = `
  SELECT offer_id, community_id, post_id, audio_revision, created_by_account_id,
         status, starts_at, ends_at, terms_hash
    FROM song_reward_offers`;

function offerFromRow(row: Row): SongRewardOffer {
  const status = text(row, "status");
  if (
    !["draft", "active", "paused", "exhausted", "expired", "ended", "operational_hold"].includes(
      status,
    )
  )
    throw new Error("invalid offer status");
  return {
    offerId: text(row, "offer_id"),
    communityId: text(row, "community_id"),
    postId: text(row, "post_id"),
    audioRevision: integer(row, "audio_revision"),
    createdByAccountId: text(row, "created_by_account_id"),
    status: status as SongRewardOffer["status"],
    startsAt: timestamp(row, "starts_at"),
    endsAt: timestamp(row, "ends_at"),
    termsHash: text(row, "terms_hash"),
  };
}

const LEG_SELECT = `
  SELECT leg.leg_id, leg.offer_id, leg.status, leg.funder_account_id,
         leg.chain_id, leg.token_address, leg.token_decimals,
         attestation.custody_address, leg.max_ticket_price_atomic,
         leg.entry_cutoff_seconds, leg.participation_starts_drawing_id,
         leg.eligible_activities, leg.min_score_bps, leg.empty_pool_policy,
         leg.fallback_payout_persona_id, leg.funded_atomic, leg.leg_terms_hash
    FROM song_reward_offer_legs leg
    JOIN megapot_deployment_attestations attestation
      ON attestation.attestation_id=leg.attestation_id`;

const ASSET_LEG_SELECT = `
  SELECT leg.leg_id, leg.offer_id, leg.status, leg.funder_account_id,
         leg.chain_id, leg.token_address, leg.token_decimals, leg.token_symbol,
         leg.asset_policy_version, attestation.custody_address,
         leg.amount_per_claim_atomic, leg.max_claims, leg.funded_atomic,
         leg.fulfilled_atomic, leg.leg_terms_hash
    FROM song_reward_offer_legs leg
    JOIN reward_asset_whitelist asset
      ON asset.chain_id=leg.chain_id AND asset.token_address=leg.token_address
    JOIN megapot_deployment_attestations attestation
      ON attestation.chain_id=leg.chain_id AND attestation.environment=asset.environment
     AND attestation.status='active'`;

function legFromRow(row: Row): MegapotPoolLeg {
  const status = text(row, "status");
  const emptyPoolPolicy = text(row, "empty_pool_policy");
  const activities = row.eligible_activities;
  if (
    !["draft", "funding", "active", "paused", "exhausted", "ended", "operational_hold"].includes(
      status,
    ) ||
    (emptyPoolPolicy !== "no_purchase" && emptyPoolPolicy !== "funder_fallback") ||
    !Array.isArray(activities) ||
    !activities.every((value) => value === "study" || value === "karaoke")
  )
    throw new Error("invalid pool leg");
  return {
    legId: text(row, "leg_id"),
    offerId: text(row, "offer_id"),
    status: status as MegapotPoolLeg["status"],
    funderAccountId: text(row, "funder_account_id"),
    chainId: integer(row, "chain_id"),
    tokenAddress: text(row, "token_address"),
    tokenDecimals: integer(row, "token_decimals"),
    custodyAddress: text(row, "custody_address"),
    maxTicketPriceAtomic: bigint(row, "max_ticket_price_atomic"),
    entryCutoffSeconds: integer(row, "entry_cutoff_seconds"),
    participationStartsDrawingId: bigint(row, "participation_starts_drawing_id"),
    eligibleActivities: activities,
    minScoreBps: integer(row, "min_score_bps"),
    emptyPoolPolicy,
    fallbackPayoutPersonaId: nullableText(row, "fallback_payout_persona_id"),
    fundedAtomic: bigint(row, "funded_atomic"),
    legTermsHash: text(row, "leg_terms_hash"),
  };
}

function assetLegFromRow(row: Row): AssetBonusLeg {
  const status = text(row, "status");
  if (
    !["draft", "funding", "active", "paused", "exhausted", "ended", "operational_hold"].includes(
      status,
    )
  ) {
    throw new Error("invalid asset bonus leg");
  }
  return {
    legId: text(row, "leg_id"),
    offerId: text(row, "offer_id"),
    status: status as AssetBonusLeg["status"],
    funderAccountId: text(row, "funder_account_id"),
    chainId: integer(row, "chain_id"),
    tokenAddress: text(row, "token_address"),
    tokenDecimals: integer(row, "token_decimals"),
    tokenSymbol: text(row, "token_symbol"),
    assetPolicyVersion: text(row, "asset_policy_version"),
    custodyAddress: text(row, "custody_address"),
    amountPerClaimAtomic: bigint(row, "amount_per_claim_atomic"),
    maxClaims: integer(row, "max_claims"),
    fundedAtomic: bigint(row, "funded_atomic"),
    fulfilledAtomic: bigint(row, "fulfilled_atomic"),
    legTermsHash: text(row, "leg_terms_hash"),
  };
}

const readOffer = (db: ControlPlaneTransaction, offerId: string) =>
  Effect.gen(function* () {
    const result = yield* db.execute<Row>({
      label: "song-reward-offer.read",
      text: `${OFFER_SELECT} WHERE offer_id=$1`,
      values: [offerId],
      readonly: true,
    });
    if (result.rows.length !== 1) return yield* storage("invalid-row");
    return yield* Effect.try({
      try: () => offerFromRow(result.rows[0] as Row),
      catch: () => storage("invalid-row"),
    });
  });

const readLeg = (db: ControlPlaneTransaction, legId: string) =>
  Effect.gen(function* () {
    const result = yield* db.execute<Row>({
      label: "song-reward-offer.leg.read",
      text: `${LEG_SELECT} WHERE leg.leg_id=$1`,
      values: [legId],
      readonly: true,
    });
    if (result.rows.length !== 1) return yield* storage("invalid-row");
    return yield* Effect.try({
      try: () => legFromRow(result.rows[0] as Row),
      catch: () => storage("invalid-row"),
    });
  });

const readAssetLeg = (db: ControlPlaneTransaction, legId: string) =>
  Effect.gen(function* () {
    const result = yield* db.execute<Row>({
      label: "song-reward-offer.asset-leg.read",
      text: `${ASSET_LEG_SELECT} WHERE leg.leg_id=$1 AND leg.kind='asset_bonus'`,
      values: [legId],
      readonly: true,
    });
    if (result.rows.length !== 1) return yield* storage("invalid-row");
    return yield* Effect.try({
      try: () => assetLegFromRow(result.rows[0] as Row),
      catch: () => storage("invalid-row"),
    });
  });

const lockAction = (
  db: ControlPlaneTransaction,
  input: {
    readonly accountId: string;
    readonly personaId: string;
    readonly endpoint: string;
    readonly idempotencyKey: string;
  },
) =>
  db.execute({
    label: "song-reward-offer.action.lock",
    text: "SELECT pg_advisory_xact_lock(hashtextextended($1, 53000001))",
    values: [
      JSON.stringify([input.accountId, input.personaId, input.endpoint, input.idempotencyKey]),
    ],
    readonly: false,
  });

export function makeControlPlaneSongRewardOfferRepository() {
  return {
    openOffer: (input: Parameters<SongRewardOfferStore["openOffer"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const endpoint = "/communities/:communityId/posts/:postId/reward-offers";
            yield* lockAction(transaction, { ...input, endpoint });
            const replay = yield* transaction.execute<Row>({
              label: "song-reward-offer.open.replay",
              text: `SELECT request_hash, offer_id FROM song_reward_offer_actions
                      WHERE account_id=$1 AND persona_id=$2 AND endpoint_template=$3
                        AND idempotency_key=$4`,
              values: [input.accountId, input.personaId, endpoint, input.idempotencyKey],
              readonly: false,
            });
            if (replay.rows.length === 1) {
              const row = replay.rows[0] as Row;
              if (text(row, "request_hash") !== input.requestHash) {
                return yield* rejected("idempotency-conflict");
              }
              return {
                offer: yield* readOffer(transaction, text(row, "offer_id")),
                replayed: true,
              };
            }
            const authority = yield* transaction.execute<Row>({
              label: "song-reward-offer.open.authority",
              text: `SELECT publication.audio_revision
                       FROM communities community
                       JOIN community_memberships membership
                         ON membership.community_id=community.community_id
                        AND membership.user_id=$2 AND membership.status='member'
                       JOIN personas persona ON persona.account_id=$2 AND persona.persona_id=$3
                         AND persona.status='active'
                       JOIN posts post ON post.community_id=community.community_id
                         AND post.post_id=$4 AND post.post_type='song' AND post.status='published'
                       JOIN media_publication_projections publication
                         ON publication.community_id=post.community_id
                        AND publication.post_id=post.post_id
                      WHERE community.community_id=$1 AND community.status='active'`,
              values: [input.communityId, input.accountId, input.personaId, input.postId],
              readonly: false,
            });
            if (authority.rows.length !== 1) return yield* rejected("song-unavailable");
            const rewardPolicyVersionId = `reward_policy_${input.offerId}`;
            const rewardPolicyKey = `song_reward_offer:${input.offerId}`;
            yield* transaction.execute({
              label: "song-reward-offer.open.uniqueness-authority",
              text: `INSERT INTO reward_uniqueness_authorities (
                       campaign_id,issuer,method,scope_kind,issuer_rp_scope,created_at
                     ) VALUES ($1,$2,$3,'issuer_rp_scope',$4,$5::timestamptz)`,
              values: [
                input.offerId,
                VERY_WEB_ISSUER,
                VERY_WEB_METHOD,
                VERY_WEB_RP_SCOPE,
                input.createdAt,
              ],
              readonly: false,
            });
            yield* transaction.execute({
              label: "song-reward-offer.open.reward-policy",
              text: `INSERT INTO policy_versions (
                       policy_version_id,community_id,policy_key,revision,policy_hash,
                       policy,compiled_plan,compiler_version,uniqueness_model,
                       created_by_user_id,published_at,policy_purpose,uniqueness_authority_id
                     ) VALUES (
                       $1,$2,$3,1,$4,$5::jsonb,$6::jsonb,'scarce_reward_policy_v1',
                       $7::jsonb,$8,$9::timestamptz,'reward',$10
                     )`,
              values: [
                rewardPolicyVersionId,
                input.communityId,
                rewardPolicyKey,
                input.rewardPolicyHash,
                JSON.stringify(input.rewardPolicy),
                JSON.stringify({
                  evaluator: "scarce_reward_eligibility_v1",
                  provider: "very.web",
                  evidence_scope: "issuer_rp_scope",
                  legal_eligibility: "test_staging_empty_v1",
                }),
                JSON.stringify({ kind: "single_authority", authority_id: input.offerId }),
                input.accountId,
                input.createdAt,
                input.offerId,
              ],
              readonly: false,
            });
            yield* transaction.execute({
              label: "song-reward-offer.open.create",
              text: `INSERT INTO song_reward_offers (
                       offer_id,community_id,post_id,audio_revision,created_by_account_id,status,
                       starts_at,ends_at,owner_policy_snapshot,terms_hash,reward_policy_version_id,
                       created_at,updated_at
                     ) VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,
                       '{"third_party_legs":"allowed","source":"platform_default_v1"}'::jsonb,
                       $8,$9,$10,$10)`,
              values: [
                input.offerId,
                input.communityId,
                input.postId,
                integer(authority.rows[0] as Row, "audio_revision"),
                input.accountId,
                input.startsAt,
                input.endsAt,
                input.termsHash,
                rewardPolicyVersionId,
                input.createdAt,
              ],
              readonly: false,
            });
            yield* transaction.execute({
              label: "song-reward-offer.open.action",
              text: `INSERT INTO song_reward_offer_actions (
                       action_id,account_id,persona_id,endpoint_template,idempotency_key,
                       request_hash,offer_id,created_at
                     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
              values: [
                input.actionId,
                input.accountId,
                input.personaId,
                endpoint,
                input.idempotencyKey,
                input.requestHash,
                input.offerId,
                input.createdAt,
              ],
              readonly: false,
            });
            return { offer: yield* readOffer(transaction, input.offerId), replayed: false };
          }),
        );
      }).pipe(mapped),

    addMegapotPoolLeg: (input: Parameters<SongRewardOfferStore["addMegapotPoolLeg"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const endpoint = "/reward-offers/:offerId/megapot-pool-legs";
            yield* lockAction(transaction, { ...input, endpoint });
            const replay = yield* transaction.execute<Row>({
              label: "song-reward-offer.leg.replay",
              text: `SELECT request_hash, leg_id FROM song_reward_offer_actions
                      WHERE account_id=$1 AND persona_id=$2 AND endpoint_template=$3
                        AND idempotency_key=$4`,
              values: [input.accountId, input.personaId, endpoint, input.idempotencyKey],
              readonly: false,
            });
            if (replay.rows.length === 1) {
              const row = replay.rows[0] as Row;
              if (text(row, "request_hash") !== input.requestHash) {
                return yield* rejected("idempotency-conflict");
              }
              return { leg: yield* readLeg(transaction, text(row, "leg_id")), replayed: true };
            }
            const authority = yield* transaction.execute<Row>({
              label: "song-reward-offer.leg.authority",
              text: `SELECT offer.status AS offer_status, offer.ends_at,
                            offer.owner_policy_snapshot->>'third_party_legs' AS third_party_legs,
                            publication.actor_user_id AS song_owner_account_id,
                            attestation.attestation_id, attestation.environment,
                            attestation.chain_id, attestation.usdc_address,
                            asset.decimals AS token_decimals, observation.drawing_id
                       FROM song_reward_offers offer
                       JOIN communities community ON community.community_id=offer.community_id
                         AND community.status='active'
                       JOIN community_memberships membership
                         ON membership.community_id=offer.community_id
                        AND membership.user_id=$2 AND membership.status='member'
                       JOIN personas persona ON persona.account_id=$2 AND persona.persona_id=$3
                         AND persona.status='active'
                       JOIN media_publication_projections publication
                         ON publication.community_id=offer.community_id
                        AND publication.post_id=offer.post_id
                        AND publication.audio_revision=offer.audio_revision
                       JOIN megapot_deployment_attestations attestation ON attestation.status='active'
                       JOIN reward_asset_whitelist asset
                         ON asset.chain_id=attestation.chain_id
                        AND asset.token_address=attestation.usdc_address
                        AND asset.status='active' AND asset.asset_kind='settlement_usdc'
                       JOIN LATERAL (
                         SELECT drawing_id FROM megapot_drawing_observations observed
                          WHERE observed.attestation_id=attestation.attestation_id
                            AND NOT observed.drawing_locked
                            AND observed.expires_at > clock_timestamp()
                          ORDER BY observed.block_number DESC, observed.observation_id DESC LIMIT 1
                       ) observation ON true
                      WHERE offer.offer_id=$1 AND offer.status IN ('draft','active')
                        AND offer.ends_at > clock_timestamp()`,
              values: [input.offerId, input.accountId, input.personaId],
              readonly: false,
            });
            if (authority.rows.length !== 1) return yield* rejected("not-found");
            const row = authority.rows[0] as Row;
            if (text(row, "environment") === "production") {
              return yield* rejected("fallback-policy-unavailable");
            }
            if (
              text(row, "third_party_legs") === "owner_only" &&
              text(row, "song_owner_account_id") !== input.accountId
            ) {
              return yield* rejected("owner-only");
            }
            if (
              input.fallbackPayoutPersonaId !== null &&
              input.fallbackPayoutPersonaId !== input.personaId
            ) {
              return yield* rejected("persona-ineligible");
            }
            yield* transaction.execute({
              label: "song-reward-offer.leg.create",
              text: `INSERT INTO song_reward_offer_legs (
                       leg_id,offer_id,kind,status,funder_account_id,refund_policy,leg_terms_hash,
                       participation_starts_at,chain_id,token_address,token_decimals,
                       tickets_per_drawing,max_ticket_price_atomic,entry_cutoff_seconds,
                       beneficiary_algorithm_version,ticket_selection_version,attestation_id,
                       participation_starts_drawing_id,eligible_activities,min_score_bps,
                       empty_pool_policy,funding_source,fallback_beneficiary_account_id,
                       fallback_payout_persona_id,referral_allocation_version,referral_policy_hash,
                       referral_disclosed_at,legal_activation_gate,created_at,updated_at
                     ) VALUES ($1,$2,'megapot_pool','draft',$3,'refund_to_funders_pro_rata',$4,
                       $5,$6,$7,$8,1,$9,$10,'equal_v1','keccak_packed_v1',$11,$12,$13,$14,
                       $15,'leg_budget',$16,$17,$18,$19,$20,'test_only',$5,$5)`,
              values: [
                input.legId,
                input.offerId,
                input.accountId,
                input.legTermsHash,
                input.createdAt,
                integer(row, "chain_id"),
                text(row, "usdc_address"),
                integer(row, "token_decimals"),
                input.maxTicketPriceAtomic.toString(),
                input.entryCutoffSeconds,
                text(row, "attestation_id"),
                (bigint(row, "drawing_id") + 1n).toString(),
                input.eligibleActivities,
                input.minScoreBps,
                input.emptyPoolPolicy,
                input.emptyPoolPolicy === "funder_fallback" ? input.accountId : null,
                input.fallbackPayoutPersonaId,
                input.referralAllocationVersion,
                input.referralPolicyHash,
                input.referralDisclosedAt,
              ],
              readonly: false,
            });
            if (text(row, "offer_status") === "draft") {
              yield* transaction.execute({
                label: "song-reward-offer.leg.activate-offer",
                text: `UPDATE song_reward_offers SET status='active',activated_at=$2,updated_at=$2
                        WHERE offer_id=$1 AND status='draft'`,
                values: [input.offerId, input.createdAt],
                readonly: false,
              });
            }
            yield* transaction.execute({
              label: "song-reward-offer.leg.begin-funding",
              text: `UPDATE song_reward_offer_legs SET status='funding',updated_at=$2
                      WHERE leg_id=$1 AND status='draft'`,
              values: [input.legId, input.createdAt],
              readonly: false,
            });
            yield* transaction.execute({
              label: "song-reward-offer.leg.action",
              text: `INSERT INTO song_reward_offer_actions (
                       action_id,account_id,persona_id,endpoint_template,idempotency_key,
                       request_hash,offer_id,leg_id,created_at
                     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
              values: [
                input.actionId,
                input.accountId,
                input.personaId,
                endpoint,
                input.idempotencyKey,
                input.requestHash,
                input.offerId,
                input.legId,
                input.createdAt,
              ],
              readonly: false,
            });
            return { leg: yield* readLeg(transaction, input.legId), replayed: false };
          }),
        );
      }).pipe(mapped),

    addAssetBonusLeg: (input: Parameters<SongRewardOfferStore["addAssetBonusLeg"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const endpoint = "/reward-offers/:offerId/asset-bonus-legs";
            yield* lockAction(transaction, { ...input, endpoint });
            const replay = yield* transaction.execute<Row>({
              label: "song-reward-offer.asset-leg.replay",
              text: `SELECT request_hash, leg_id FROM song_reward_offer_actions
                      WHERE account_id=$1 AND persona_id=$2 AND endpoint_template=$3
                        AND idempotency_key=$4`,
              values: [input.accountId, input.personaId, endpoint, input.idempotencyKey],
              readonly: false,
            });
            if (replay.rows.length === 1) {
              const row = replay.rows[0] as Row;
              if (text(row, "request_hash") !== input.requestHash) {
                return yield* rejected("idempotency-conflict");
              }
              return {
                leg: yield* readAssetLeg(transaction, text(row, "leg_id")),
                replayed: true,
              };
            }
            const authority = yield* transaction.execute<Row>({
              label: "song-reward-offer.asset-leg.authority",
              text: `SELECT offer.status AS offer_status,
                            offer.owner_policy_snapshot->>'third_party_legs' AS third_party_legs,
                            publication.actor_user_id AS song_owner_account_id,
                            asset.chain_id, asset.token_address, asset.decimals,
                            asset.symbol, asset.policy_version, attestation.custody_address
                       FROM song_reward_offers offer
                       JOIN communities community ON community.community_id=offer.community_id
                         AND community.status='active'
                       JOIN community_memberships membership
                         ON membership.community_id=offer.community_id
                        AND membership.user_id=$2 AND membership.status='member'
                       JOIN personas persona ON persona.account_id=$2 AND persona.persona_id=$3
                         AND persona.status='active'
                       JOIN media_publication_projections publication
                         ON publication.community_id=offer.community_id
                        AND publication.post_id=offer.post_id
                        AND publication.audio_revision=offer.audio_revision
                       JOIN reward_asset_whitelist asset
                         ON asset.chain_id=$4 AND asset.token_address=$5
                        AND asset.decimals=$6 AND asset.symbol=$7 AND asset.policy_version=$8
                        AND asset.asset_kind='bonus_asset' AND asset.status='active'
                        AND asset.environment IN ('test','staging')
                       JOIN megapot_deployment_attestations attestation
                         ON attestation.chain_id=asset.chain_id
                        AND attestation.environment=asset.environment
                        AND attestation.status='active'
                      WHERE offer.offer_id=$1 AND offer.status IN ('draft','active')
                        AND offer.ends_at > clock_timestamp()`,
              values: [
                input.offerId,
                input.accountId,
                input.personaId,
                input.chainId,
                input.tokenAddress,
                input.tokenDecimals,
                input.tokenSymbol,
                input.assetPolicyVersion,
              ],
              readonly: false,
            });
            if (authority.rows.length !== 1) return yield* rejected("not-found");
            const row = authority.rows[0] as Row;
            if (
              text(row, "third_party_legs") === "owner_only" &&
              text(row, "song_owner_account_id") !== input.accountId
            ) {
              return yield* rejected("owner-only");
            }
            yield* transaction.execute({
              label: "song-reward-offer.asset-leg.create",
              text: `INSERT INTO song_reward_offer_legs (
                       leg_id,offer_id,kind,status,funder_account_id,refund_policy,leg_terms_hash,
                       participation_starts_at,chain_id,token_address,token_decimals,
                       token_symbol,asset_policy_version,amount_per_claim_atomic,max_claims,
                       legal_activation_gate,created_at,updated_at
                     ) VALUES ($1,$2,'asset_bonus','draft',$3,'refund_to_funders_pro_rata',$4,
                       $5,$6,$7,$8,$9,$10,$11,$12,'test_only',$5,$5)`,
              values: [
                input.legId,
                input.offerId,
                input.accountId,
                input.legTermsHash,
                input.createdAt,
                input.chainId,
                input.tokenAddress,
                input.tokenDecimals,
                input.tokenSymbol,
                input.assetPolicyVersion,
                input.amountPerClaimAtomic.toString(),
                input.maxClaims,
              ],
              readonly: false,
            });
            if (text(row, "offer_status") === "draft") {
              yield* transaction.execute({
                label: "song-reward-offer.asset-leg.activate-offer",
                text: `UPDATE song_reward_offers SET status='active',activated_at=$2,updated_at=$2
                        WHERE offer_id=$1 AND status='draft'`,
                values: [input.offerId, input.createdAt],
                readonly: false,
              });
            }
            yield* transaction.execute({
              label: "song-reward-offer.asset-leg.begin-funding",
              text: `UPDATE song_reward_offer_legs SET status='funding',updated_at=$2
                      WHERE leg_id=$1 AND status='draft'`,
              values: [input.legId, input.createdAt],
              readonly: false,
            });
            yield* transaction.execute({
              label: "song-reward-offer.asset-leg.action",
              text: `INSERT INTO song_reward_offer_actions (
                       action_id,account_id,persona_id,endpoint_template,idempotency_key,
                       request_hash,offer_id,leg_id,created_at
                     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
              values: [
                input.actionId,
                input.accountId,
                input.personaId,
                endpoint,
                input.idempotencyKey,
                input.requestHash,
                input.offerId,
                input.legId,
                input.createdAt,
              ],
              readonly: false,
            });
            return { leg: yield* readAssetLeg(transaction, input.legId), replayed: false };
          }),
        );
      }).pipe(mapped),

    recordFundingObservation: (
      input: Parameters<SongRewardOfferStore["recordFundingObservation"]>[0],
    ) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            const endpoint =
              input.legKind === "asset_bonus"
                ? "/asset-bonus-legs/:legId/funding/:fundingEffectId/observations"
                : "/reward-offer-legs/:legId/funding/:fundingEffectId/observations";
            yield* lockAction(transaction, { ...input, endpoint });
            const replay = yield* transaction.execute<Row>({
              label: "song-reward-offer.funding-observation.replay",
              text: `SELECT request_hash,leg_id,funding_effect_id
                       FROM song_reward_offer_actions
                      WHERE account_id=$1 AND persona_id=$2 AND endpoint_template=$3
                        AND idempotency_key=$4`,
              values: [input.accountId, input.personaId, endpoint, input.idempotencyKey],
              readonly: false,
            });
            if (replay.rows.length === 1) {
              const row = replay.rows[0] as Row;
              if (
                text(row, "request_hash") !== input.requestHash ||
                text(row, "leg_id") !== input.legId ||
                text(row, "funding_effect_id") !== input.fundingEffectId
              ) {
                return yield* rejected("idempotency-conflict");
              }
              return { replayed: true };
            }
            const inserted = yield* transaction.execute({
              label: "song-reward-offer.funding-observation.action",
              text: `INSERT INTO song_reward_offer_actions (
                       action_id,account_id,persona_id,endpoint_template,idempotency_key,
                       request_hash,offer_id,leg_id,funding_effect_id,created_at
                     )
                     SELECT $1,$2,$3,$4,$5,$6,leg.offer_id,leg.leg_id,
                            funding.funding_effect_id,$9
                       FROM song_reward_leg_funding_effects funding
                       JOIN song_reward_offer_legs leg ON leg.leg_id=funding.leg_id
                       JOIN personas persona ON persona.account_id=$2 AND persona.persona_id=$3
                         AND persona.status='active'
                      WHERE leg.leg_id=$7 AND funding.funding_effect_id=$8
                        AND funding.funder_account_id=$2 AND leg.kind=$10`,
              values: [
                input.actionId,
                input.accountId,
                input.personaId,
                endpoint,
                input.idempotencyKey,
                input.requestHash,
                input.legId,
                input.fundingEffectId,
                input.createdAt,
                input.legKind,
              ],
              readonly: false,
            });
            if (inserted.rowCount !== 1) return yield* rejected("not-found");
            return { replayed: false };
          }),
        );
      }).pipe(mapped),
  };
}

export const makeControlPlaneSongRewardOfferStore = (
  layer: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): SongRewardOfferStore => {
  const repository = makeControlPlaneSongRewardOfferRepository();
  const provide = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    mapped(Effect.provide(layer)(effect));
  return {
    openOffer: (input) => provide(repository.openOffer(input)),
    addMegapotPoolLeg: (input) => provide(repository.addMegapotPoolLeg(input)),
    addAssetBonusLeg: (input) => provide(repository.addAssetBonusLeg(input)),
    recordFundingObservation: (input) => provide(repository.recordFundingObservation(input)),
  };
};
