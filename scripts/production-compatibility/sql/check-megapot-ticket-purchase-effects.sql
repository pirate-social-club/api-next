-- megapot_ticket_purchase_effects: exact intermediate named ADD CHECK expressions, not only final333.
WITH projected AS (SELECT original.* FROM api_next.megapot_ticket_purchase_effects original)
SELECT 'megapot_ticket_purchase_effects' AS table_name,count(*) AS inspected_rows,
 jsonb_build_object(
 '0313:megapot_ticket_purchase_commitment_pair',count(*) FILTER(WHERE (
    (snapshot_id IS NULL) = (commitment_effect_id IS NULL)
  ) IS FALSE)
 ) AS check_false_counts
FROM projected;
