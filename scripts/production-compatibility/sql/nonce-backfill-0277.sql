-- Source-bound proposal only. Execute inside the reviewed owner's READ ONLY
-- transaction at exact ledger275. No nonce, account or wallet value is returned.
WITH projected AS MATERIALIZED (
 SELECT 'winner:'||a.send_id||':'||a.attempt AS lease_id,
        a.send_id AS owner_id,a.attempt AS owner_revision,
        a.account_id,s.persona_id,s.wallet_assignment_id,s.chain_id,
        s.sender_address,a.nonce,a.send_id AS winner_send_id,
        a.attempt AS winner_attempt,a.created_at
 FROM api_next.reward_winner_send_attempts a
 JOIN api_next.reward_winner_sends s USING(send_id)
 WHERE a.account_id=s.account_id
), facts AS (
 SELECT
  (SELECT count(*) FROM api_next.reward_winner_send_attempts) AS attempt_count,
  count(*) AS projected_count,
  count(*) FILTER(WHERE lease_id IS NULL OR owner_id IS NULL OR owner_revision IS NULL
    OR account_id IS NULL OR persona_id IS NULL OR wallet_assignment_id IS NULL
    OR chain_id IS NULL OR sender_address IS NULL OR nonce IS NULL OR created_at IS NULL) AS not_null_failures,
  count(*) FILTER(WHERE (btrim(lease_id)<>'' AND octet_length(lease_id)<=256) IS FALSE) AS lease_check_failures,
  count(*) FILTER(WHERE (btrim(owner_id)<>'' AND octet_length(owner_id)<=128) IS FALSE) AS owner_check_failures,
  count(*) FILTER(WHERE (owner_revision>0) IS FALSE) AS revision_check_failures,
  count(*) FILTER(WHERE (chain_id>0 AND chain_id<=9007199254740991) IS FALSE) AS chain_check_failures,
  count(*) FILTER(WHERE (sender_address ~ '^0x[0-9a-f]{40}$') IS FALSE) AS sender_check_failures,
  count(*) FILTER(WHERE (nonce>=0) IS FALSE) AS nonce_check_failures,
  count(*) FILTER(WHERE NOT EXISTS(SELECT 1 FROM api_next.users u WHERE u.user_id=projected.account_id)) AS user_fk_failures,
  count(*) FILTER(WHERE NOT EXISTS(SELECT 1 FROM api_next.personas p
    WHERE p.account_id=projected.account_id AND p.persona_id=projected.persona_id)) AS persona_fk_failures,
  encode(sha256(convert_to(coalesce(string_agg(
   encode(sha256(convert_to(jsonb_build_array(lease_id,owner_id,owner_revision,account_id,persona_id,
     wallet_assignment_id,chain_id,sender_address,nonce,winner_send_id,winner_attempt,created_at)::text,'UTF8')),'hex'),
   E'\n' ORDER BY lease_id),''),'UTF8')),'hex') AS projected_rows_sha256
 FROM projected
)
SELECT facts.*,
 attempt_count-projected_count AS missing_or_foreign_account_provenance_count,
 (SELECT count(*) FROM (SELECT lease_id FROM projected GROUP BY lease_id HAVING count(*)>1) duplicates) AS lease_id_duplicate_groups,
 (SELECT count(*) FROM (SELECT chain_id,sender_address,nonce FROM projected
   GROUP BY chain_id,sender_address,nonce HAVING count(*)>1) duplicates) AS sender_nonce_duplicate_groups,
 (SELECT count(*) FROM (SELECT owner_id,owner_revision FROM projected
   GROUP BY owner_id,owner_revision HAVING count(*)>1) duplicates) AS owner_revision_duplicate_groups,
 (SELECT count(*) FROM projected l LEFT JOIN api_next.persona_wallet_assignments w
   ON w.assignment_id=l.wallet_assignment_id
   WHERE w.assignment_id IS NULL OR w.account_id<>l.account_id OR w.persona_id<>l.persona_id
     OR w.address IS DISTINCT FROM l.sender_address OR w.chain_account_kind<>'evm') AS exact_migration_wallet_provenance_failures
FROM facts;
