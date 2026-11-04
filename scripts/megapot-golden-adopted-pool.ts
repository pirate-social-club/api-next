import type { Client } from "pg";
import type { MultiGoldenInput } from "./megapot-golden-multi-input.ts";

/** The browser owns creation and signing; this query only checks the exact handoff. */
export const goldenAdoptedPoolSql = `SELECT o.community_id, o.post_id, o.audio_revision::int,
 o.created_by_account_id, o.status AS offer_status, o.starts_at, o.ends_at,
 l.kind, l.status AS leg_status, l.funder_account_id, l.chain_id::int,
 l.token_address, l.token_decimals::int, l.funded_atomic::text,
 l.max_ticket_price_atomic::text, l.entry_cutoff_seconds,
 l.eligible_activities, l.min_score_bps, l.empty_pool_policy,
 f.state AS funding_status, f.sender_address, f.recipient_address,
 f.expected_amount_atomic::text,
 f.confirmed_amount_atomic::text, f.transaction_hash,
 att.environment AS attestation_environment, att.status AS attestation_status,
 att.custody_address,
 p.account_id AS sponsor_account_id, w.address AS sponsor_wallet_address,
 (SELECT count(*)::int FROM song_reward_offer_legs other
  WHERE other.offer_id=o.offer_id AND other.kind='megapot_pool') AS pool_leg_count,
 (SELECT count(*)::int FROM song_reward_leg_funding_effects other
  WHERE other.leg_id=l.leg_id) AS funding_effect_count
 FROM song_reward_offers o
 JOIN song_reward_offer_legs l ON l.offer_id=o.offer_id
 JOIN song_reward_leg_funding_effects f ON f.leg_id=l.leg_id
 JOIN megapot_deployment_attestations att ON att.attestation_id=l.attestation_id
  AND att.chain_id=l.chain_id AND att.usdc_address=l.token_address
 JOIN personas p ON p.persona_id=$4 AND p.account_id=o.created_by_account_id
  AND p.status='active'
 JOIN persona_wallet_assignments w ON w.persona_id=p.persona_id
  AND w.account_id=p.account_id AND w.status='active'
 WHERE o.offer_id=$1 AND l.leg_id=$2 AND f.funding_effect_id=$3`;

type AdoptedPoolRow = Readonly<{
  community_id: string;
  post_id: string;
  audio_revision: number;
  created_by_account_id: string;
  offer_status: string;
  starts_at: Date;
  ends_at: Date;
  kind: string;
  leg_status: string;
  funder_account_id: string;
  chain_id: number;
  token_address: string;
  token_decimals: number;
  funded_atomic: string;
  max_ticket_price_atomic: string;
  entry_cutoff_seconds: number;
  eligible_activities: string[];
  min_score_bps: number;
  empty_pool_policy: string;
  funding_status: string;
  sender_address: string;
  recipient_address: string;
  expected_amount_atomic: string;
  confirmed_amount_atomic: string | null;
  transaction_hash: string | null;
  attestation_environment: string;
  attestation_status: string;
  custody_address: string;
  sponsor_account_id: string;
  sponsor_wallet_address: string;
  pool_leg_count: number;
  funding_effect_count: number;
}>;

export async function assertGoldenAdoptedPool(
  client: Pick<Client, "query">,
  input: MultiGoldenInput,
  expectedTokenAddress: string,
): Promise<void> {
  const adopted = input.app_funded_pool;
  if (!adopted) throw new Error("App-funded pool handoff required.");
  const result = await client.query<AdoptedPoolRow>(goldenAdoptedPoolSql, [
    adopted.offer_id,
    adopted.leg_id,
    adopted.funding_effect_id,
    input.persona_id,
  ]);
  if (result.rows.length !== 1) throw new Error("Exact app-funded pool handoff missing.");
  const row = result.rows[0];
  if (!row) throw new Error("Exact app-funded pool handoff missing.");
  if (
    row.community_id !== input.community_id ||
    row.post_id !== input.post_id ||
    row.audio_revision !== input.audio_revision ||
    row.created_by_account_id !== row.sponsor_account_id ||
    row.funder_account_id !== row.sponsor_account_id ||
    row.offer_status !== "active" ||
    row.leg_status !== "active" ||
    new Date(row.starts_at).toISOString() !== input.starts_at ||
    new Date(row.ends_at).toISOString() !== input.ends_at ||
    row.kind !== "megapot_pool" ||
    row.chain_id !== 84532 ||
    row.token_address !== expectedTokenAddress ||
    row.token_decimals !== 6 ||
    row.funded_atomic !== input.funding_amount_atomic ||
    row.max_ticket_price_atomic !== input.max_ticket_price_atomic ||
    row.entry_cutoff_seconds !== input.entry_cutoff_seconds ||
    row.eligible_activities.length !== 2 ||
    !row.eligible_activities.includes("study") ||
    !row.eligible_activities.includes("karaoke") ||
    row.min_score_bps !== 7000 ||
    row.empty_pool_policy !== "no_purchase" ||
    row.funding_status !== "confirmed" ||
    row.attestation_environment !== "staging" ||
    row.attestation_status !== "active" ||
    row.sender_address !== adopted.sender_address ||
    row.sponsor_wallet_address !== adopted.sender_address ||
    row.recipient_address !== row.custody_address ||
    row.expected_amount_atomic !== input.funding_amount_atomic ||
    row.confirmed_amount_atomic !== input.funding_amount_atomic ||
    row.transaction_hash !== adopted.transaction_hash ||
    row.pool_leg_count !== 1 ||
    row.funding_effect_count !== 1
  ) {
    throw new Error("App-funded pool does not match the exact approved handoff.");
  }
}
