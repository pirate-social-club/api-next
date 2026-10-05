import { Client } from "pg";
import { normalizePostgresConnectionString } from "../postgres-connection-string.ts";
import { setRewardOperationsControl } from "../reward-operations-control.ts";
import { REWARD_SHUTDOWN_PREDICATES } from "../rewards-binding-deploy-preflight.ts";
import { validateIsolatedDatabaseIdentity } from "./bootstrap-database.ts";

export function isolatedDatabase(identity, adminUrl, runtimeUrl) {
  validateIsolatedDatabaseIdentity(adminUrl, identity);
  validateIsolatedDatabaseIdentity(runtimeUrl, {
    ...identity,
    usernameSha256: identity.runtimeUsernameSha256,
  });
  if (identity.branchId !== "l8mhyb0fxy54") throw Error("Runner branch differs");
  async function use(url, readonly, task) {
    const db = new Client({
      connectionString: normalizePostgresConnectionString(url),
      connectionTimeoutMillis: 10000,
      statement_timeout: 10000,
    });
    try {
      await db.connect();
      await db.query(
        readonly ? "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN",
      );
      await db.query("SET LOCAL search_path TO api_next, public");
      const result = await task(db);
      await db.query("COMMIT");
      return result;
    } catch (error) {
      await db.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      await db.end().catch(() => {});
    }
  }
  return {
    read: async (text, values = []) =>
      use(runtimeUrl, true, async (db) => (await db.query(text, values)).rows),
    control: async (paused, expectedRevision, reason) =>
      use(adminUrl, false, (db) =>
        setRewardOperationsControl(db, { paused, expectedRevision, reason }),
      ),
  };
}
export const fundingQuery = `SELECT o.offer_id, o.community_id, o.post_id, o.audio_revision::text,
  o.created_by_account_id AS creator, o.status AS offer_status, o.created_at AS offer_created_at,
  l.leg_id, l.kind, l.status AS leg_status, l.created_at AS leg_created_at,
  l.funder_account_id AS leg_funder, l.chain_id::text AS leg_chain_id, l.token_address AS leg_token,
  l.funded_atomic::text, l.participation_starts_drawing_id::text AS drawing_id,
  l.tickets_per_drawing, l.max_ticket_price_atomic::text, l.entry_cutoff_seconds,
  f.funding_effect_id, f.funder_account_id, f.chain_id::text, f.token_address,
  f.sender_address, f.recipient_address, f.expected_amount_atomic::text, f.confirmed_amount_atomic::text,
  f.required_confirmations, f.state, f.transaction_hash, f.log_index, f.block_number::text,
  f.block_hash, f.observation_hash, f.failure_reason, f.created_at, f.confirmed_at,
  a.status AS attestation_status, a.attestation_id, a.environment, a.chain_id::text AS attestation_chain_id, a.usdc_address, a.custody_address,
  c.paused, c.revision::text AS control_revision,
  (SELECT count(*)::text FROM api_next.song_reward_offers x WHERE x.created_by_account_id=o.created_by_account_id AND x.created_at >= $3::timestamptz) AS window_offer_count,
  (SELECT count(*)::text FROM api_next.song_reward_offer_legs x WHERE x.offer_id=o.offer_id) AS leg_count,
  (SELECT count(*)::text FROM api_next.song_reward_leg_funding_effects x WHERE x.leg_id=l.leg_id) AS funding_count
  FROM api_next.song_reward_offers o
  JOIN api_next.song_reward_offer_legs l ON l.offer_id=o.offer_id
  JOIN api_next.song_reward_leg_funding_effects f ON f.leg_id=l.leg_id
  JOIN api_next.megapot_deployment_attestations a ON a.attestation_id=l.attestation_id
  CROSS JOIN api_next.reward_operations_control c
  WHERE o.offer_id=$1 AND l.leg_id=$2 AND c.singleton`;

export async function readRunInventory(db, legId) {
  return {
    legs: await db.read(
      "SELECT leg_id,status,funded_atomic::text,spent_atomic::text,fulfilled_atomic::text,refunded_atomic::text,reserved_atomic::text FROM song_reward_offer_legs WHERE leg_id=$1",
      [legId],
    ),
    drawings: await db.read(
      "SELECT pool_leg_id,drawing_id::text,status,frozen_share_count,gross_winnings_atomic::text,net_winnings_atomic::text,purchase_effect_id,claim_effect_id FROM megapot_pool_drawings WHERE pool_leg_id=$1",
      [legId],
    ),
    shares: await db.read(
      "SELECT share.account_id,share.persona_id,share.qualification_id,qualification.activity_key,qualification.score_bps FROM megapot_pool_shares share JOIN activity_qualifications qualification USING(qualification_id) WHERE pool_leg_id=$1 ORDER BY account_id",
      [legId],
    ),
    purchases: await db.read(
      "SELECT effect.effect_id,effect.state,effect.transaction_hash,effect.receipt_block_number::text,effect.receipt_block_hash,ticket.ticket_id::text,ticket.drawing_id::text,ticket.status AS ticket_status FROM megapot_ticket_purchase_effects purchase JOIN reward_chain_effects effect ON effect.effect_id=purchase.purchase_effect_id LEFT JOIN megapot_ticket_inventory ticket USING(purchase_effect_id) WHERE purchase.pool_leg_id=$1",
      [legId],
    ),
    credits: await db.read(
      "SELECT credit.credit_id,credit.account_id,credit.payout_persona_id,credit.state,credit.amount_atomic::text,credit.paid_atomic::text,credit.reserved_atomic::text FROM megapot_allocations allocation JOIN reward_ledger_credits credit USING(credit_id) JOIN megapot_allocation_batches batch USING(allocation_batch_id) WHERE batch.pool_leg_id=$1 ORDER BY credit.account_id",
      [legId],
    ),
    refunds: await db.read(
      "SELECT refund.refund_effect_id,refund.amount_atomic::text,effect.state,effect.transaction_hash FROM reward_refund_effects refund JOIN reward_chain_effects effect ON effect.effect_id=refund.refund_effect_id WHERE refund.leg_id=$1",
      [legId],
    ),
  };
}
export function assertNothingOwed(inventory) {
  if (
    inventory.legs.length !== 1 ||
    inventory.legs.some(
      (leg) =>
        BigInt(leg.reserved_atomic) !== 0n ||
        BigInt(leg.funded_atomic) !==
          BigInt(leg.spent_atomic) + BigInt(leg.fulfilled_atomic) + BigInt(leg.refunded_atomic),
    ) ||
    inventory.credits.some(
      (credit) =>
        credit.state !== "sent" ||
        BigInt(credit.reserved_atomic) !== 0n ||
        credit.paid_atomic !== credit.amount_atomic,
    ) ||
    inventory.purchases.some(
      (purchase) =>
        purchase.state !== "confirmed" || !["claimed", "no_win"].includes(purchase.ticket_status),
    ) ||
    inventory.refunds.some((refund) => refund.state !== "confirmed") ||
    inventory.drawings.some(
      (drawing) => !["credited", "no_win", "closed_no_entries"].includes(drawing.status),
    )
  )
    throw Error("Rewards obligations remain open");
  return { nothingOwed: true };
}

const shutdownPredicates = [
  ...REWARD_SHUTDOWN_PREDICATES,
  ["unresolved_winner_sends", "reward_winner_sends", "status <> 'confirmed'"],
];

/** All categories are read in one snapshot, including obligations from earlier runs. */
export async function readShutdownInventory(db) {
  const rows = await db.read(
    `SELECT ${shutdownPredicates
      .map(
        ([category, table, predicate]) =>
          `(SELECT count(*)::text FROM api_next.${table} WHERE ${predicate}) AS ${category}`,
      )
      .join(",")}`,
  );
  if (rows.length !== 1) throw Error("Shutdown inventory missing");
  return rows[0];
}

export function assertShutdownInventory(inventory) {
  for (const [category] of shutdownPredicates) {
    if (inventory?.[category] !== "0") throw Error(`Rewards shutdown refused: ${category}`);
  }
  return { nothingOwed: true };
}
