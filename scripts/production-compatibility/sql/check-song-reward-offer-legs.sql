-- song_reward_offer_legs: exact intermediate named ADD CHECK expressions, not only final333.
WITH projected AS (SELECT original.*,'numeric'::text AS qualification_family_v2,NULL::jsonb AS shared_song_terms_v2,'commit_first'::text AS purchase_order FROM api_next.song_reward_offer_legs original)
SELECT 'song_reward_offer_legs' AS table_name,count(*) AS inspected_rows,
 jsonb_build_object(
 '0284:shared_song_leg_family_v2',count(*) FILTER(WHERE ((
 (qualification_family_v2='numeric' AND shared_song_terms_v2 IS NULL)
 OR (qualification_family_v2='shared_song' AND kind='megapot_pool' AND min_score_bps IS NULL
   AND empty_pool_policy='no_purchase' AND funding_source='leg_budget'
   AND eligible_activities=ARRAY['study','karaoke','dance']::TEXT[]
   AND jsonb_typeof(shared_song_terms_v2)='object'
   AND shared_song_terms_v2->>'version'='shared-song-megapot-v2'
   AND shared_song_terms_v2->>'terms_hash'=substring(leg_terms_hash FROM 3))) IS TRUE) IS FALSE),
 '0284:song_reward_leg_qualification_shape',count(*) FILTER(WHERE (
 qualification_policies IS NULL OR (jsonb_typeof(qualification_policies)='array'
   AND ((qualification_family_v2='numeric' AND jsonb_array_length(qualification_policies) BETWEEN 1 AND 2)
        OR (qualification_family_v2='shared_song' AND jsonb_array_length(qualification_policies)=3)))) IS FALSE),
 '0313:song_reward_leg_purchase_order_shape',count(*) FILTER(WHERE (
    purchase_order = 'commit_first'
    OR (kind = 'megapot_pool' AND funding_source = 'leg_budget'
      AND empty_pool_policy = 'no_purchase')
  ) IS FALSE),
 '0325:song_reward_pool_fallback_shape',count(*) FILTER(WHERE (
    kind <> 'megapot_pool'
    OR (empty_pool_policy = 'no_purchase'
      AND funding_source = 'leg_budget'
      AND fallback_beneficiary_account_id IS NULL
      AND fallback_payout_persona_id IS NULL
      AND referral_allocation_version IS NULL
      AND referral_policy_hash IS NULL
      AND referral_disclosed_at IS NULL)
    OR (empty_pool_policy = 'funder_fallback'
      AND fallback_beneficiary_account_id IS NOT NULL
      AND ((funding_source = 'leg_budget'
          AND fallback_beneficiary_account_id = funder_account_id
          AND fallback_payout_persona_id IS NOT NULL
          AND min_score_bps = 7000
          AND referral_allocation_version IS NOT NULL
          AND btrim(referral_allocation_version) <> ''
          AND referral_policy_hash ~ '^[0-9a-f]{64}$'
          AND referral_disclosed_at IS NOT NULL)
        OR (funding_source = 'shared_sponsor_budget'
          AND fallback_payout_persona_id IS NULL
          AND funded_atomic = 0 AND reserved_atomic = 0 AND spent_atomic = 0
          AND fulfilled_atomic = 0 AND refunded_atomic = 0)))

    OR (purchase_order='ticket_first_v1' AND qualification_family_v2='shared_song'
      AND shared_song_terms_v2->>'empty_behavior'='single_funder_ticket_first_v1'
      AND empty_pool_policy='funder_fallback' AND funding_source='leg_budget'
      AND fallback_beneficiary_account_id=funder_account_id AND fallback_payout_persona_id IS NOT NULL
      AND min_score_bps IS NULL AND referral_allocation_version='net_to_single_funder_v1'
      AND referral_policy_hash=shared_song_terms_v2->>'terms_hash' AND referral_disclosed_at IS NOT NULL)
) IS FALSE),
 '0325:shared_song_leg_family_v2',count(*) FILTER(WHERE ((
 (qualification_family_v2='numeric' AND shared_song_terms_v2 IS NULL)
 OR (qualification_family_v2='shared_song' AND kind='megapot_pool' AND min_score_bps IS NULL
   AND funding_source='leg_budget' AND eligible_activities=ARRAY['study','karaoke','dance']::TEXT[]
   AND jsonb_typeof(shared_song_terms_v2)='object'
   AND shared_song_terms_v2->>'version'='shared-song-megapot-v2'
   AND shared_song_terms_v2->>'terms_hash'=substring(leg_terms_hash FROM 3)
   AND ((empty_pool_policy='no_purchase' AND shared_song_terms_v2->>'empty_behavior'='no_purchase')
     OR (purchase_order='ticket_first_v1' AND empty_pool_policy='funder_fallback'
       AND shared_song_terms_v2->>'empty_behavior'='single_funder_ticket_first_v1')))) IS TRUE) IS FALSE),
 '0325:song_reward_leg_purchase_order_shape',count(*) FILTER(WHERE (
  purchase_order='commit_first' OR (kind='megapot_pool' AND funding_source='leg_budget'
    AND (empty_pool_policy='no_purchase' OR (empty_pool_policy='funder_fallback'
      AND shared_song_terms_v2->>'empty_behavior'='single_funder_ticket_first_v1')))) IS FALSE)
 ) AS check_false_counts
FROM projected;
