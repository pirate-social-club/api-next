-- megapot_pool_commitment_effects: exact intermediate named ADD CHECK expressions, not only final333.
WITH projected AS (SELECT original.* FROM api_next.megapot_pool_commitment_effects original)
SELECT 'megapot_pool_commitment_effects' AS table_name,count(*) AS inspected_rows,
 jsonb_build_object(
 '0313:megapot_pool_commitment_effects_signature_check',count(*) FILTER(WHERE (
    (signing_key_id = 'unsigned_owner_safe_v1' AND signature IS NULL)
    OR (signing_key_id <> 'unsigned_owner_safe_v1' AND signature IS NOT NULL
      AND btrim(signature) <> '')
  ) IS FALSE)
 ) AS check_false_counts
FROM projected;
