/** Target-drawing admission and payouts, with whole-leg one-ticket/effect/refund bounds.
 * A second drawing buying a ticket breaches this one-ticket rehearsal, even if it settles.
 * Caller must execute in a read-only transaction. */
export const goldenObservationSql = `
WITH target AS (
 SELECT l.*,o.community_id,o.post_id,o.audio_revision,o.starts_at,d.drawing_id,d.status AS drawing_status,
 d.entry_cutoff_at,d.net_winnings_atomic,d.snapshot_id,d.allocation_batch_id,d.claim_effect_id
 FROM song_reward_offer_legs l JOIN song_reward_offers o ON o.offer_id=l.offer_id
 JOIN megapot_pool_drawings d ON d.pool_leg_id=l.leg_id
 WHERE l.leg_id=$1 AND d.drawing_id=$2::numeric
), effect_ids AS (
 SELECT purchase_effect_id AS id FROM megapot_ticket_purchase_effects WHERE pool_leg_id=$1
 UNION SELECT claim_effect_id FROM megapot_claim_effects WHERE pool_leg_id=$1
 UNION SELECT refund_effect_id FROM reward_refund_effects WHERE leg_id=$1
 UNION SELECT p.payout_effect_id FROM reward_payout_effects p
 JOIN megapot_allocations a USING (credit_id)
 JOIN megapot_allocation_batches b USING (allocation_batch_id) WHERE b.pool_leg_id=$1
)
SELECT jsonb_build_object(
 'leg_id',t.leg_id,'drawing_id',t.drawing_id::text,
 'observed_at',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'community_id',t.community_id,'post_id',t.post_id,'audio_revision',t.audio_revision,
 'drawing_status',t.drawing_status,
 'entry_cutoff_at',to_char(t.entry_cutoff_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'funded_atomic',t.funded_atomic::text,'spent_atomic',t.spent_atomic::text,
 'refunded_atomic',t.refunded_atomic::text,'reserved_atomic',t.reserved_atomic::text,
 'net_winnings_atomic',t.net_winnings_atomic::text,
 'ticket_count',(SELECT count(*)::int FROM megapot_ticket_inventory WHERE pool_leg_id=$1),
 'purchase_receipt_count',(SELECT count(*)::int FROM megapot_purchase_receipt_evidence r
   JOIN megapot_ticket_purchase_effects p USING (purchase_effect_id) WHERE p.pool_leg_id=$1 AND p.drawing_id=$2::numeric),
 'unresolved_effect_count',(SELECT count(*)::int FROM reward_chain_effects e JOIN effect_ids i ON i.id=e.effect_id WHERE e.state <> 'confirmed'),
 'other_unresolved_drawings',(SELECT count(*)::int FROM megapot_pool_drawings WHERE pool_leg_id=$1 AND drawing_id<>$2::numeric
   AND status NOT IN ('no_win','credited','closed_no_entries','closed_unfunded','closed_fallback_ineligible','closed_fallback_unavailable','closed_fallback_ceiling')),
 'refund_receipt_atomic',(SELECT COALESCE(sum(r.amount_atomic),0)::text FROM reward_refund_effects f
   JOIN reward_chain_effects e ON e.effect_id=f.refund_effect_id AND e.state='confirmed'
   JOIN reward_erc20_transfer_receipt_evidence r ON r.effect_id=e.effect_id AND r.transfer_purpose='reward_refund'
    AND r.recipient_address=f.destination_address AND r.amount_atomic=f.amount_atomic WHERE f.leg_id=$1),
 'claim_receipt_atomic',(SELECT COALESCE(sum(net_winnings_atomic),0)::text FROM megapot_claim_receipt_evidence WHERE claim_effect_id=t.claim_effect_id),
 'shares',COALESCE((SELECT jsonb_agg(jsonb_build_object('account_id',account_id,'persona_id',persona_id) ORDER BY account_id)
   FROM megapot_pool_shares WHERE pool_leg_id=$1 AND drawing_id=$2::numeric),'[]'::jsonb),
 'qualifications',COALESCE((SELECT jsonb_agg(jsonb_build_object('account_id',account_id,'persona_id',persona_id,'activity_key',activity_key))
   FROM activity_qualifications WHERE community_id=t.community_id AND post_id=t.post_id
     AND audio_revision=t.audio_revision AND qualified_at>=t.starts_at AND qualified_at<t.entry_cutoff_at),'[]'::jsonb),
 'beneficiaries',COALESCE((SELECT jsonb_agg(jsonb_build_object('ordinal',ordinal,'account_id',account_id,'persona_id',persona_id) ORDER BY ordinal)
   FROM megapot_pool_snapshot_private_leaves WHERE snapshot_id=t.snapshot_id),'[]'::jsonb),
 'decisions',COALESCE((SELECT jsonb_agg(jsonb_build_object('account_id',d.account_id,'persona_id',d.persona_id,
    'activity_key',q.activity_key,'outcome',d.outcome,'reason',d.reason))
   FROM reward_eligibility_decisions d JOIN activity_qualifications q USING (qualification_id)
   WHERE d.leg_id=$1 AND d.drawing_id=$2::numeric AND d.purpose='pool_share'),'[]'::jsonb),
 'credits',COALESCE((SELECT jsonb_agg(jsonb_build_object('account_id',a.account_id,'persona_id',a.persona_id,
   'ordinal',a.ordinal,'amount_atomic',a.amount_atomic::text,'paid_atomic',c.paid_atomic::text,
   'reserved_atomic',c.reserved_atomic::text,'state',c.state,
   'receipt_confirmed',COALESCE(e.state='confirmed' AND r.transfer_purpose='reward_payout'
      AND r.amount_atomic=a.amount_atomic AND r.recipient_address=p.destination_address
      AND p.payout_persona_id=a.persona_id AND p.account_id=a.account_id,false)) ORDER BY a.ordinal)
   FROM megapot_allocations a JOIN reward_ledger_credits c USING (credit_id)
   LEFT JOIN reward_payout_effects p USING (credit_id)
   LEFT JOIN reward_chain_effects e ON e.effect_id=p.payout_effect_id
   LEFT JOIN reward_erc20_transfer_receipt_evidence r ON r.effect_id=e.effect_id
   WHERE a.allocation_batch_id=t.allocation_batch_id),'[]'::jsonb)
) AS observation FROM target t`;
