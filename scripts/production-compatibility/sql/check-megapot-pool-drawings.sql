-- megapot_pool_drawings: exact intermediate named ADD CHECK expressions, not only final333.
WITH projected AS (SELECT original.*,'commit_first'::text AS purchase_order FROM api_next.megapot_pool_drawings original)
SELECT 'megapot_pool_drawings' AS table_name,count(*) AS inspected_rows,
 jsonb_build_object(
 '0313:megapot_pool_drawings_status_check',count(*) FILTER(WHERE (
    status = ANY (ARRAY['entry_open'::text, 'cutoff_frozen'::text, 'committed'::text, 'purchase_pending'::text, 'tickets_confirmed'::text, 'drawing_pending'::text, 'no_win'::text, 'winnings_detected'::text, 'claim_pending'::text, 'claimed'::text, 'allocated'::text, 'credited'::text, 'closed_no_entries'::text, 'closed_unfunded'::text, 'closed_fallback_ineligible'::text, 'closed_fallback_unavailable'::text, 'closed_fallback_ceiling'::text, 'closed_purchase_unavailable'::text, 'operational_hold'::text, 'ticket_pending'::text])
  ) IS FALSE),
 '0313:megapot_pool_drawing_effect_shape',count(*) FILTER(WHERE (
    (purchase_order = 'commit_first' AND (((status = 'operational_hold'::text) OR ((status = ANY (ARRAY['entry_open'::text, 'cutoff_frozen'::text, 'closed_no_entries'::text, 'closed_unfunded'::text, 'closed_fallback_ineligible'::text, 'closed_fallback_unavailable'::text, 'closed_fallback_ceiling'::text])) AND (commitment_effect_id IS NULL) AND (purchase_effect_id IS NULL) AND (claim_effect_id IS NULL) AND (allocation_batch_id IS NULL)) OR ((status = 'committed'::text) AND (commitment_effect_id IS NOT NULL) AND (purchase_effect_id IS NULL) AND (claim_effect_id IS NULL) AND (allocation_batch_id IS NULL)) OR ((status = 'closed_purchase_unavailable'::text) AND (commitment_effect_id IS NOT NULL) AND (claim_effect_id IS NULL) AND (allocation_batch_id IS NULL)) OR ((status = ANY (ARRAY['purchase_pending'::text, 'tickets_confirmed'::text, 'drawing_pending'::text, 'no_win'::text, 'winnings_detected'::text])) AND (commitment_effect_id IS NOT NULL) AND (purchase_effect_id IS NOT NULL) AND (claim_effect_id IS NULL) AND (allocation_batch_id IS NULL)) OR ((status = ANY (ARRAY['claim_pending'::text, 'claimed'::text])) AND (commitment_effect_id IS NOT NULL) AND (purchase_effect_id IS NOT NULL) AND (claim_effect_id IS NOT NULL) AND (allocation_batch_id IS NULL)) OR ((status = ANY (ARRAY['allocated'::text, 'credited'::text])) AND (commitment_effect_id IS NOT NULL) AND (purchase_effect_id IS NOT NULL) AND (claim_effect_id IS NOT NULL) AND (allocation_batch_id IS NOT NULL)))))
    OR (purchase_order = 'ticket_first_v1' AND (
      status = 'operational_hold'
      OR (status IN ('ticket_pending', 'entry_open', 'cutoff_frozen', 'closed_purchase_unavailable')
        AND commitment_effect_id IS NULL AND purchase_effect_id IS NOT NULL
        AND claim_effect_id IS NULL AND allocation_batch_id IS NULL)
      OR (status IN ('committed', 'drawing_pending', 'no_win', 'winnings_detected')
        AND commitment_effect_id IS NOT NULL AND purchase_effect_id IS NOT NULL
        AND claim_effect_id IS NULL AND allocation_batch_id IS NULL)
      OR (status IN ('claim_pending', 'claimed')
        AND commitment_effect_id IS NOT NULL AND purchase_effect_id IS NOT NULL
        AND claim_effect_id IS NOT NULL AND allocation_batch_id IS NULL)
      OR (status IN ('allocated', 'credited')
        AND commitment_effect_id IS NOT NULL AND purchase_effect_id IS NOT NULL
        AND claim_effect_id IS NOT NULL AND allocation_batch_id IS NOT NULL)
    ))
  ) IS FALSE),
 '0313:megapot_pool_drawing_purchase_amount_shape',count(*) FILTER(WHERE (
    (purchase_order = 'commit_first' AND (((status = 'operational_hold'::text) OR ((status = ANY (ARRAY['entry_open'::text, 'closed_no_entries'::text, 'closed_unfunded'::text, 'closed_fallback_ineligible'::text, 'closed_fallback_unavailable'::text, 'closed_fallback_ceiling'::text])) AND (reserved_ticket_cost_atomic = (0)::numeric) AND (actual_ticket_cost_atomic = (0)::numeric)) OR ((status = ANY (ARRAY['cutoff_frozen'::text, 'committed'::text, 'purchase_pending'::text, 'closed_purchase_unavailable'::text])) AND (reserved_ticket_cost_atomic > (0)::numeric) AND (actual_ticket_cost_atomic = (0)::numeric)) OR ((status = ANY (ARRAY['tickets_confirmed'::text, 'drawing_pending'::text, 'no_win'::text, 'winnings_detected'::text, 'claim_pending'::text, 'claimed'::text, 'allocated'::text, 'credited'::text])) AND (reserved_ticket_cost_atomic > (0)::numeric) AND (actual_ticket_cost_atomic > (0)::numeric)))))
    OR (purchase_order = 'ticket_first_v1' AND (
      status = 'operational_hold'
      OR (status IN ('ticket_pending', 'closed_purchase_unavailable')
        AND reserved_ticket_cost_atomic > 0 AND actual_ticket_cost_atomic = 0)
      OR (status IN ('entry_open', 'cutoff_frozen', 'committed', 'drawing_pending', 'no_win',
          'winnings_detected', 'claim_pending', 'claimed', 'allocated', 'credited')
        AND reserved_ticket_cost_atomic > 0 AND actual_ticket_cost_atomic > 0)
    ))
  ) IS FALSE),
 '0313:megapot_pool_drawing_snapshot_shape',count(*) FILTER(WHERE (
    (purchase_order = 'commit_first' AND (((status = 'operational_hold'::text) OR ((status = ANY (ARRAY['entry_open'::text, 'closed_no_entries'::text, 'closed_unfunded'::text, 'closed_fallback_ineligible'::text, 'closed_fallback_unavailable'::text, 'closed_fallback_ceiling'::text])) AND (snapshot_id IS NULL)) OR ((status = ANY (ARRAY['cutoff_frozen'::text, 'committed'::text, 'purchase_pending'::text, 'tickets_confirmed'::text, 'drawing_pending'::text, 'no_win'::text, 'winnings_detected'::text, 'claim_pending'::text, 'claimed'::text, 'allocated'::text, 'credited'::text, 'closed_purchase_unavailable'::text])) AND (snapshot_id IS NOT NULL)))))
    OR (purchase_order = 'ticket_first_v1' AND (
      status = 'operational_hold'
      OR (status IN ('ticket_pending', 'entry_open', 'closed_purchase_unavailable')
        AND snapshot_id IS NULL)
      OR (status IN ('cutoff_frozen', 'committed', 'drawing_pending', 'no_win',
          'winnings_detected', 'claim_pending', 'claimed', 'allocated', 'credited')
        AND snapshot_id IS NOT NULL)
    ))
  ) IS FALSE),
 '0313:megapot_pool_drawing_freeze_shape',count(*) FILTER(WHERE (
    (purchase_order = 'commit_first' AND ((((status = 'entry_open'::text) AND (frozen_share_count IS NULL) AND (fallback_beneficiary IS NULL) AND (snapshot_id IS NULL) AND (cutoff_frozen_at IS NULL)) OR (status = 'operational_hold'::text) OR ((status <> ALL (ARRAY['entry_open'::text, 'operational_hold'::text])) AND (frozen_share_count IS NOT NULL) AND (frozen_share_count >= 0) AND (fallback_beneficiary IS NOT NULL) AND (cutoff_frozen_at IS NOT NULL)))))
    OR (purchase_order = 'ticket_first_v1' AND (
      status = 'operational_hold'
      OR (status IN ('ticket_pending', 'entry_open', 'closed_purchase_unavailable')
        AND frozen_share_count IS NULL AND fallback_beneficiary IS NULL
        AND snapshot_id IS NULL AND cutoff_frozen_at IS NULL)
      OR (status NOT IN ('ticket_pending', 'entry_open', 'closed_purchase_unavailable',
          'operational_hold')
        AND frozen_share_count IS NOT NULL AND frozen_share_count > 0
        AND fallback_beneficiary = false AND cutoff_frozen_at IS NOT NULL)
    ))
  ) IS FALSE),
 '0325:megapot_pool_drawing_freeze_shape',count(*) FILTER(WHERE (
    (purchase_order = 'commit_first' AND ((((status = 'entry_open'::text) AND (frozen_share_count IS NULL) AND (fallback_beneficiary IS NULL) AND (snapshot_id IS NULL) AND (cutoff_frozen_at IS NULL)) OR (status = 'operational_hold'::text) OR ((status <> ALL (ARRAY['entry_open'::text, 'operational_hold'::text])) AND (frozen_share_count IS NOT NULL) AND (frozen_share_count >= 0) AND (fallback_beneficiary IS NOT NULL) AND (cutoff_frozen_at IS NOT NULL)))))
    OR (purchase_order = 'ticket_first_v1' AND (
      status = 'operational_hold'
      OR (status IN ('ticket_pending', 'entry_open', 'closed_purchase_unavailable')
        AND frozen_share_count IS NULL AND fallback_beneficiary IS NULL
        AND snapshot_id IS NULL AND cutoff_frozen_at IS NULL)
      OR (status NOT IN ('ticket_pending', 'entry_open', 'closed_purchase_unavailable',
          'operational_hold')
        AND frozen_share_count IS NOT NULL AND ((frozen_share_count > 0 AND fallback_beneficiary = false)
          OR (frozen_share_count = 0 AND fallback_beneficiary = true)) AND cutoff_frozen_at IS NOT NULL)
    ))
  ) IS FALSE)
 ) AS check_false_counts
FROM projected;
