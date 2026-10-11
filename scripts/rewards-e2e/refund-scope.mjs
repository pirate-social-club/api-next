import { shutdownPredicates } from "./database-evidence.mjs";

/**
 * What may still be open while one sponsor funding is being refunded, and
 * nothing else. The categories and their predicates are the canonical shutdown
 * ones; this reads which rows each still holds, not just how many, so that
 * every open row can be tied to the pinned funding or refused.
 */
const rowKey = {
  unpaid_credits: "credit_id",
  leg_liabilities: "leg_id",
  sponsor_liabilities: "sponsor_account_id || ':' || chain_id || ':' || token_address",
  open_offers: "offer_id",
  open_legs: "leg_id",
  unresolved_drawings: "pool_leg_id || ':' || drawing_id",
  unresolved_funding: "funding_effect_id",
  unresolved_chain_effects: "effect_id",
  unresolved_gas_topups: "topup_id",
  unresolved_winner_sends: "send_id",
};

/** One snapshot of every category's open rows and the pinned leg's refunds. */
export function refundScopeQuery() {
  for (const [category] of shutdownPredicates)
    if (!rowKey[category]) throw Error(`Refund scope has no row key for ${category}`);
  const categories = shutdownPredicates.map(
    ([category, table, predicate]) =>
      `(SELECT coalesce(json_agg((${rowKey[category]})::text ORDER BY 1), '[]'::json)
         FROM api_next.${table} WHERE ${predicate}) AS ${category}`,
  );
  return `SELECT ${categories.join(",\n")},
    (SELECT coalesce(json_agg(json_build_object(
        'refund_effect_id', refund_effect_id, 'leg_id', leg_id,
        'funding_effect_id', funding_effect_id, 'destination_address', destination_address,
        'amount_atomic', amount_atomic::text) ORDER BY refund_effect_id), '[]'::json)
       FROM api_next.reward_refund_effects WHERE leg_id = $1 OR funding_effect_id = $2) AS refunds`;
}

export async function readRefundScope(db, pin) {
  const rows = await db.read(refundScopeQuery(), [pin.legId, pin.fundingEffectId]);
  if (rows.length !== 1) throw Error("Refund scope missing");
  return rows[0];
}

/**
 * Refuses anything open that is not the pinned offer, its leg, its funding or
 * the one refund of that funding to the sponsor for the whole principal. A
 * liability on another leg, a sponsor budget, an unrelated chain effect, a
 * credit, a drawing, a gas top-up or a winner send each stop the recovery.
 */
export function assertRefundScope(scope, pin) {
  const refused = [];
  const refunds = scope.refunds ?? [];
  if (refunds.length > 1) refused.push("more than one refund of the pinned leg");
  for (const refund of refunds) {
    if (
      refund.leg_id !== pin.legId ||
      refund.funding_effect_id !== pin.fundingEffectId ||
      refund.destination_address?.toLowerCase() !== pin.sponsor ||
      refund.amount_atomic !== pin.principalAtomic
    )
      refused.push(`refund ${refund.refund_effect_id} is not the pinned refund`);
  }
  const permitted = {
    open_offers: [pin.offerId],
    open_legs: [pin.legId],
    leg_liabilities: [pin.legId],
    unresolved_funding: [pin.fundingEffectId],
    // Only the pinned refund's own chain effect, and only once it is the pinned refund.
    unresolved_chain_effects: refused.length === 0 ? refunds.map((r) => r.refund_effect_id) : [],
  };
  for (const [category] of shutdownPredicates) {
    const open = scope[category];
    if (!Array.isArray(open)) {
      refused.push(`${category} unreadable`);
      continue;
    }
    const allowed = permitted[category] ?? [];
    for (const key of open)
      if (!allowed.includes(key)) refused.push(`${category}: ${key} is outside the pinned funding`);
  }
  if (refused.length > 0) throw Error(`Refund scope refused: ${refused.join("; ")}`);
  return { pinnedOnly: true };
}
