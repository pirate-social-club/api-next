-- megapot_ticket_inventory: exact intermediate named ADD CHECK expressions, not only final333.
WITH projected AS (SELECT original.* FROM api_next.megapot_ticket_inventory original)
SELECT 'megapot_ticket_inventory' AS table_name,count(*) AS inspected_rows,
 jsonb_build_object(
 '0316:megapot_ticket_inventory_status_check',count(*) FILTER(WHERE (
    status IN ('custodied', 'claim_pending', 'claimed', 'no_win', 'needs_review', 'held_late')
  ) IS FALSE),
 '0316:megapot_ticket_inventory_terminal_shape',count(*) FILTER(WHERE (
    (status IN ('custodied', 'claim_pending', 'held_late')
      AND claimed_transaction_hash IS NULL AND terminal_at IS NULL)
    OR (status = 'claimed' AND claimed_transaction_hash IS NOT NULL AND terminal_at IS NOT NULL)
    OR (status IN ('no_win', 'needs_review')
      AND claimed_transaction_hash IS NULL AND terminal_at IS NOT NULL)
  ) IS FALSE)
 ) AS check_false_counts
FROM projected;
