/** Deployment-only ownership projection. Missing and mixed provenance stays unknown. */
export function rewardOwnerCtes(schema: string): string {
  return `WITH leg_owners AS (
    SELECT leg.leg_id,leg.offer_id, CASE
      WHEN leg.kind <> 'megapot_pool' THEN 'legacy'
      WHEN leg.purchase_order='ticket_first_v1' AND signer.nonce_authority='safe_owner_v1' THEN 'safe'
      WHEN leg.purchase_order='commit_first' AND signer.nonce_authority='eoa_pending_nonce' THEN 'legacy'
      ELSE NULL END AS engine
    FROM "${schema}".song_reward_offer_legs leg
    LEFT JOIN "${schema}".megapot_deployment_attestations a USING(attestation_id)
    LEFT JOIN "${schema}".reward_signer_nonces signer ON signer.chain_id=a.chain_id AND signer.signer_address=a.custody_address
  ), offer_owners AS (
    SELECT offer_id, CASE WHEN bool_and(engine='safe') AND count(engine)=count(*) THEN 'safe'
      WHEN bool_and(engine='legacy') AND count(engine)=count(*) THEN 'legacy' ELSE NULL END AS engine
    FROM leg_owners GROUP BY offer_id
  ), credit_owners AS (
    SELECT credit.credit_id, CASE WHEN credit.source_kind IN ('megapot_allocation','external_fallback') THEN (
      SELECT leg.engine FROM "${schema}".megapot_allocations allocation
      JOIN "${schema}".megapot_allocation_batches batch USING(allocation_batch_id)
      JOIN leg_owners leg ON leg.leg_id=batch.pool_leg_id WHERE allocation.credit_id=credit.credit_id
    ) WHEN credit.source_kind='asset_bonus' THEN 'legacy' ELSE NULL END AS engine
    FROM "${schema}".reward_ledger_credits credit
  )`;
}

export function rewardObligationOwner(table: string, schema: string): string {
  const leg = (key: string) => `SELECT engine FROM leg_owners WHERE leg_id=obligation.${key}`;
  switch (table) {
    case "song_reward_offer_legs":
      return leg("leg_id");
    case "megapot_pool_drawings":
    case "song_megapot_contributions_v2":
    case "reward_safe_refunds_v1":
      return leg("pool_leg_id");
    case "song_reward_leg_funding_effects":
      return leg("leg_id");
    case "song_reward_offers":
      return `SELECT engine FROM offer_owners WHERE offer_id=obligation.offer_id`;
    case "reward_ledger_credits":
    case "reward_gas_topups":
      return `SELECT engine FROM credit_owners WHERE credit_id=obligation.credit_id`;
    case "reward_chain_effects":
      return `SELECT CASE obligation.execution_mode WHEN 'safe_owner_v1' THEN 'safe' WHEN 'eoa' THEN 'legacy' END`;
    case "platform_sponsorship_budgets":
      return `SELECT 'legacy'`;
    case "reward_late_principal_liabilities_v2":
      return `SELECT leg.engine FROM "${schema}".song_megapot_contributions_v2 c JOIN leg_owners leg ON leg.leg_id=c.pool_leg_id WHERE c.contribution_id=obligation.contribution_id`;
    default:
      throw Error("unattributed reward inventory table");
  }
}
