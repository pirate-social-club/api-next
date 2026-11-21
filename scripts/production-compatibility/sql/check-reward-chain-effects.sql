-- reward_chain_effects: exact intermediate named ADD CHECK expressions, not only final333.
WITH projected AS (SELECT original.*,'eoa'::text AS execution_mode,NULL::numeric AS safe_nonce,NULL::text AS safe_transaction_hash,NULL::text AS safe_executor_address,NULL::text AS safe_execution_outcome,NULL::integer AS safe_execution_log_index,NULL::bigint AS safe_prepared_block_number FROM api_next.reward_chain_effects original)
SELECT 'reward_chain_effects' AS table_name,count(*) AS inspected_rows,
 jsonb_build_object(
 '0311:reward_chain_effect_prepared_shape',count(*) FILTER(WHERE (
    (execution_mode = 'eoa'
      AND safe_nonce IS NULL AND safe_transaction_hash IS NULL
      AND safe_executor_address IS NULL AND safe_execution_outcome IS NULL
      AND safe_execution_log_index IS NULL AND safe_prepared_block_number IS NULL
      AND (
        (state = 'planned' AND nonce IS NULL AND calldata IS NULL AND calldata_hash IS NULL
          AND signed_transaction IS NULL AND signed_transaction_hash IS NULL
          AND transaction_hash IS NULL AND prepared_at IS NULL)
        OR (state = 'nonce_reserved' AND nonce IS NOT NULL AND calldata IS NULL
          AND calldata_hash IS NULL AND signed_transaction IS NULL
          AND signed_transaction_hash IS NULL AND transaction_hash IS NULL
          AND prepared_at IS NULL)
        OR (state IN ('prepared', 'broadcast_pending', 'confirming', 'confirmed', 'reverted',
            'replaced', 'reconciliation_required')
          AND nonce IS NOT NULL AND calldata ~ '^0x([0-9a-f]{2})*$'
          AND calldata_hash ~ '^[0-9a-f]{64}$'
          AND signed_transaction ~ '^0x([0-9a-f]{2})+$'
          AND signed_transaction_hash ~ '^0x[0-9a-f]{64}$'
          AND prepared_at IS NOT NULL)
        OR (state IN ('reclaimable_failed', 'terminal_failed')
          AND ((nonce IS NULL AND calldata IS NULL AND calldata_hash IS NULL
              AND signed_transaction IS NULL AND signed_transaction_hash IS NULL
              AND prepared_at IS NULL)
            OR (nonce IS NOT NULL AND calldata IS NULL AND calldata_hash IS NULL
              AND signed_transaction IS NULL AND signed_transaction_hash IS NULL
              AND prepared_at IS NULL)
            OR (nonce IS NOT NULL AND calldata ~ '^0x([0-9a-f]{2})*$'
              AND calldata_hash ~ '^[0-9a-f]{64}$'
              AND signed_transaction ~ '^0x([0-9a-f]{2})+$'
              AND signed_transaction_hash ~ '^0x[0-9a-f]{64}$'
              AND prepared_at IS NOT NULL)))))
    OR (execution_mode = 'safe_owner_v1'
      AND nonce IS NULL AND signed_transaction IS NULL AND signed_transaction_hash IS NULL
      AND (
        (state IN ('planned', 'terminal_failed')
          AND calldata IS NULL AND calldata_hash IS NULL AND prepared_at IS NULL
          AND safe_prepared_block_number IS NULL
          AND safe_nonce IS NULL AND safe_transaction_hash IS NULL
          AND safe_executor_address IS NULL AND safe_execution_outcome IS NULL
          AND safe_execution_log_index IS NULL)
        OR (state = 'prepared'
          AND calldata IS NOT NULL AND calldata ~ '^0x[0-9a-f]{8}([0-9a-f]{2})*$'
          AND calldata_hash IS NOT NULL AND calldata_hash ~ '^[0-9a-f]{64}$'
          AND prepared_at IS NOT NULL AND safe_prepared_block_number IS NOT NULL
          AND safe_nonce IS NULL AND safe_transaction_hash IS NULL
          AND safe_executor_address IS NULL AND safe_execution_outcome IS NULL
          AND safe_execution_log_index IS NULL)
        OR (state IN ('confirming', 'confirmed', 'reverted', 'reconciliation_required')
          AND calldata IS NOT NULL AND calldata ~ '^0x[0-9a-f]{8}([0-9a-f]{2})*$'
          AND calldata_hash IS NOT NULL AND calldata_hash ~ '^[0-9a-f]{64}$'
          AND prepared_at IS NOT NULL AND safe_prepared_block_number IS NOT NULL
          AND safe_nonce IS NOT NULL AND safe_transaction_hash IS NOT NULL
          AND safe_executor_address IS NOT NULL AND safe_execution_outcome IS NOT NULL
          AND safe_execution_log_index IS NOT NULL)))
  ) IS FALSE),
 '0311:reward_chain_effect_receipt_shape',count(*) FILTER(WHERE (
    (state NOT IN ('confirmed', 'reverted') AND receipt_status IS NULL
      AND receipt_block_number IS NULL AND receipt_block_hash IS NULL
      AND receipt_hash IS NULL AND confirmations IS NULL AND confirmed_at IS NULL)
    OR (state = 'confirmed' AND receipt_status = 'success'
      AND receipt_block_number IS NOT NULL AND receipt_block_hash IS NOT NULL
      AND receipt_hash IS NOT NULL AND confirmations IS NOT NULL AND confirmed_at IS NOT NULL
      AND settled_amount_atomic IS NOT NULL
      AND (execution_mode = 'eoa' OR safe_execution_outcome = 'success'))
    OR (state = 'reverted' AND execution_mode = 'eoa' AND receipt_status = 'reverted'
      AND receipt_block_number IS NOT NULL AND receipt_block_hash IS NOT NULL
      AND receipt_hash IS NOT NULL AND confirmations IS NOT NULL AND confirmed_at IS NOT NULL
      AND settled_amount_atomic IS NULL)
    OR (state = 'reverted' AND execution_mode = 'safe_owner_v1'
      AND receipt_status = 'success' AND safe_execution_outcome = 'failure'
      AND receipt_block_number IS NOT NULL AND receipt_block_hash IS NOT NULL
      AND receipt_hash IS NOT NULL AND confirmations IS NOT NULL AND confirmed_at IS NOT NULL
      AND settled_amount_atomic IS NULL)
  ) IS FALSE)
 ) AS check_false_counts
FROM projected;
