-- Prospective Safe treasury disposition. Historical terms and credits are unchanged.
CREATE TABLE reward_safe_treasury_allocations_v1 (
  allocation_batch_id TEXT PRIMARY KEY REFERENCES megapot_allocation_batches,
  pool_leg_id TEXT NOT NULL, drawing_id NUMERIC(78,0) NOT NULL,
  claim_effect_id TEXT NOT NULL UNIQUE REFERENCES megapot_claim_effects,
  chain_id BIGINT NOT NULL, token_address TEXT NOT NULL CHECK(token_address ~ '^0x[a-f0-9]{40}$'),
  treasury_address TEXT NOT NULL CHECK(treasury_address ~ '^0x[a-f0-9]{40}$'),
  amount_atomic NUMERIC(78,0) NOT NULL CHECK(amount_atomic>0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(pool_leg_id,drawing_id),
  FOREIGN KEY(pool_leg_id,drawing_id) REFERENCES megapot_pool_drawings
);
CREATE TRIGGER reward_safe_treasury_allocations_v1_append_only BEFORE UPDATE OR DELETE
 ON reward_safe_treasury_allocations_v1 FOR EACH ROW EXECUTE FUNCTION reject_reward_contribution_history_v2();
CREATE TRIGGER reward_safe_treasury_allocations_v1_no_truncate BEFORE TRUNCATE
 ON reward_safe_treasury_allocations_v1 EXECUTE FUNCTION reject_reward_contribution_history_v2();

-- Widen only the structural shapes. The zero-participant cases below remain
-- restricted to new, explicitly frozen treasury terms by relational triggers.
DO $constraints$
DECLARE item RECORD; prior TEXT; amended TEXT;
BEGIN
 FOR item IN SELECT * FROM (VALUES
  ('song_reward_offer_legs','shared_song_leg_family_v2',
   '(shared_song_terms_v2 ->> ''empty_behavior''::text) = ''no_purchase''::text',
   '(shared_song_terms_v2 ->> ''empty_behavior''::text) IN (''no_purchase''::text,''safe_treasury_ticket_first_v1''::text)'),
  ('megapot_pool_drawings','megapot_pool_drawing_freeze_shape','frozen_share_count > 0','frozen_share_count >= 0'),
  ('megapot_pool_beneficiary_snapshots','megapot_pool_beneficiary_snapshots_leaf_count_check','leaf_count > 0','leaf_count >= 0'),
  ('megapot_allocation_batches','megapot_allocation_batches_allocation_count_check','allocation_count > 0','allocation_count >= 0')
 ) AS edits(table_name,constraint_name,old_text,new_text) LOOP
  SELECT pg_get_constraintdef(oid) INTO STRICT prior FROM pg_constraint
   WHERE conrelid=to_regclass(item.table_name) AND conname=item.constraint_name;
  amended:=replace(prior,item.old_text,item.new_text);
  IF amended=prior THEN RAISE EXCEPTION 'treasury constraint predecessor mismatch: %',item.constraint_name; END IF;
  EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I',item.table_name,item.constraint_name);
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I %s',item.table_name,item.constraint_name,amended);
 END LOOP;
END $constraints$;

CREATE FUNCTION guard_safe_treasury_terms_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a megapot_deployment_attestations;
BEGIN
 IF NEW.shared_song_terms_v2->>'empty_behavior'='safe_treasury_ticket_first_v1' THEN
  SELECT * INTO STRICT a FROM megapot_deployment_attestations WHERE attestation_id=NEW.attestation_id;
  IF NEW.purchase_order<>'ticket_first_v1' OR NEW.empty_pool_policy<>'no_purchase'
   OR NEW.shared_song_terms_v2->>'empty_winnings_recipient' IS DISTINCT FROM a.custody_address
   OR NOT EXISTS(SELECT 1 FROM reward_signer_nonces s WHERE s.chain_id=a.chain_id
      AND s.signer_address=a.custody_address AND s.nonce_authority='safe_owner_v1') THEN
   RAISE EXCEPTION 'treasury terms require their immutable Safe recipient'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER zz_shared_song_treasury_terms_guard BEFORE INSERT ON song_reward_offer_legs
 FOR EACH ROW EXECUTE FUNCTION guard_safe_treasury_terms_v1();

CREATE FUNCTION guard_safe_treasury_freeze_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.purchase_order='ticket_first_v1' AND NEW.frozen_share_count=0
  AND NEW.fallback_beneficiary IS FALSE
  AND NEW.status NOT IN ('ticket_pending','entry_open','closed_purchase_unavailable','operational_hold')
  AND NOT EXISTS(SELECT 1 FROM song_reward_offer_legs l WHERE l.leg_id=NEW.pool_leg_id
    AND l.shared_song_terms_v2->>'empty_behavior'='safe_treasury_ticket_first_v1') THEN
  RAISE EXCEPTION 'empty participant snapshot requires frozen treasury terms'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER safe_treasury_freeze_guard BEFORE UPDATE ON megapot_pool_drawings
 FOR EACH ROW EXECUTE FUNCTION guard_safe_treasury_freeze_v1();

-- Amend the existing validators without weakening any non-treasury path. Exact
-- predecessor matches make an unexpected earlier definition a migration failure.
DO $functions$
DECLARE prior TEXT; amended TEXT; needle TEXT;
BEGIN
 SELECT pg_get_functiondef('bind_initial_shared_song_pot_v2(jsonb,text,jsonb)'::regprocedure) INTO prior;
 needle:=' IF terms->>''empty_behavior''=''single_funder_ticket_first_v1'' THEN';
 amended:=replace(prior,needle,$edit$
 IF terms->>'empty_behavior'='safe_treasury_ticket_first_v1' AND (
   terms->>'empty_winnings_recipient' IS DISTINCT FROM prospectus->>'empty_winnings_recipient'
   OR terms->>'empty_winnings_recipient' IS DISTINCT FROM (SELECT custody_address
     FROM megapot_deployment_attestations WHERE attestation_id=r->'instruction'->>'attestation_id')) THEN
   RAISE EXCEPTION 'treasury recipient differs from accepted prospective terms'; END IF;
$edit$||needle);
 IF amended=prior THEN RAISE EXCEPTION 'treasury binding predecessor mismatch'; END IF;
 EXECUTE amended;

 SELECT pg_get_functiondef('validate_megapot_beneficiary_snapshot()'::regprocedure) INTO prior;
 amended:=replace(prior,'SELECT count(*), jsonb_agg(leaf_commitment ORDER BY ordinal)',
   'SELECT count(*), coalesce(jsonb_agg(leaf_commitment ORDER BY ordinal),''[]''::jsonb)');
 IF amended=prior THEN RAISE EXCEPTION 'treasury snapshot aggregate predecessor mismatch'; END IF;
 prior:=amended;
 needle:='  IF snapshot_record.fallback THEN';
 amended:=replace(prior,needle,$edit$
  IF snapshot_record.leaf_count=0 AND (
    leg_record.shared_song_terms_v2->>'empty_behavior' IS DISTINCT FROM 'safe_treasury_ticket_first_v1'
    OR snapshot_record.fallback OR drawing_record.purchase_order<>'ticket_first_v1'
  ) THEN RAISE EXCEPTION 'zero-leaf snapshot requires treasury terms'; END IF;
$edit$||needle);
 IF amended=prior THEN RAISE EXCEPTION 'treasury snapshot validator predecessor mismatch'; END IF;
 EXECUTE amended;

 SELECT pg_get_functiondef('validate_megapot_allocation_batch()'::regprocedure) INTO prior;
 needle:='  base_amount := trunc(batch_record.net_winnings_atomic / snapshot_record.leaf_count);';
 amended:=replace(prior,needle,$edit$
  IF snapshot_record.leaf_count=0 THEN
    IF leg_record.shared_song_terms_v2->>'empty_behavior' IS DISTINCT FROM 'safe_treasury_ticket_first_v1'
     OR drawing_record.status<>'credited' OR batch_record.state<>'credited'
     OR batch_record.allocation_count<>0 OR drawing_record.snapshot_id<>batch_record.snapshot_id
     OR drawing_record.claim_effect_id<>batch_record.claim_effect_id
     OR drawing_record.allocation_batch_id<>batch_record.allocation_batch_id
     OR drawing_record.net_winnings_atomic<>batch_record.net_winnings_atomic
     OR EXISTS(SELECT 1 FROM megapot_allocations WHERE allocation_batch_id=target_batch_id)
     OR NOT EXISTS(SELECT 1 FROM reward_safe_treasury_allocations_v1 t
        WHERE t.allocation_batch_id=target_batch_id AND t.pool_leg_id=batch_record.pool_leg_id
          AND t.drawing_id=batch_record.drawing_id AND t.claim_effect_id=batch_record.claim_effect_id
          AND t.amount_atomic=batch_record.net_winnings_atomic) THEN
      RAISE EXCEPTION 'treasury batch does not conserve exact claimed winnings'; END IF;
    RETURN NULL;
  END IF;
$edit$||needle);
 IF amended=prior THEN RAISE EXCEPTION 'treasury allocation validator predecessor mismatch'; END IF;
 EXECUTE amended;
END $functions$;

CREATE FUNCTION validate_safe_treasury_allocation_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d megapot_pool_drawings; l song_reward_offer_legs; a megapot_deployment_attestations;
 c megapot_claim_effects; b megapot_allocation_batches;
BEGIN
 SELECT * INTO STRICT d FROM megapot_pool_drawings WHERE pool_leg_id=NEW.pool_leg_id AND drawing_id=NEW.drawing_id;
 SELECT * INTO STRICT l FROM song_reward_offer_legs WHERE leg_id=NEW.pool_leg_id;
 SELECT * INTO STRICT a FROM megapot_deployment_attestations WHERE attestation_id=l.attestation_id;
 SELECT * INTO STRICT c FROM megapot_claim_effects WHERE claim_effect_id=NEW.claim_effect_id;
 SELECT * INTO STRICT b FROM megapot_allocation_batches WHERE allocation_batch_id=NEW.allocation_batch_id;
 IF l.shared_song_terms_v2->>'empty_behavior' IS DISTINCT FROM 'safe_treasury_ticket_first_v1'
  OR l.shared_song_terms_v2->>'empty_winnings_recipient' IS DISTINCT FROM NEW.treasury_address
  OR NEW.treasury_address<>a.custody_address OR NEW.chain_id<>a.chain_id OR NEW.token_address<>a.usdc_address
  OR d.purchase_order<>'ticket_first_v1' OR d.frozen_share_count<>0 OR d.fallback_beneficiary IS DISTINCT FROM FALSE
  OR d.status<>'credited' OR d.net_winnings_atomic<>NEW.amount_atomic OR d.claim_effect_id<>NEW.claim_effect_id
  OR d.allocation_batch_id<>NEW.allocation_batch_id OR b.state<>'credited' OR b.allocation_count<>0
  OR c.received_atomic IS DISTINCT FROM NEW.amount_atomic OR c.pool_leg_id<>NEW.pool_leg_id OR c.drawing_id<>NEW.drawing_id
  OR NOT EXISTS(SELECT 1 FROM reward_chain_effects e WHERE e.effect_id=c.claim_effect_id
     AND e.state='confirmed' AND e.execution_mode='safe_owner_v1' AND e.signer_address=NEW.treasury_address)
  OR EXISTS(SELECT 1 FROM megapot_pool_shares WHERE pool_leg_id=NEW.pool_leg_id AND drawing_id=NEW.drawing_id)
  OR EXISTS(SELECT 1 FROM megapot_allocations WHERE allocation_batch_id=NEW.allocation_batch_id) THEN
  RAISE EXCEPTION 'Safe treasury credit lacks exact empty drawing and confirmed claim'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER safe_treasury_allocation_exact AFTER INSERT ON reward_safe_treasury_allocations_v1
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_safe_treasury_allocation_v1();

CREATE FUNCTION credit_empty_safe_treasury_v1(p_leg TEXT,p_drawing NUMERIC) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE d megapot_pool_drawings; l song_reward_offer_legs; a megapot_deployment_attestations;
 c megapot_claim_effects; batch TEXT; body_hash TEXT; credit_time TIMESTAMPTZ;
BEGIN
 IF (SELECT paused FROM reward_operations_control WHERE singleton FOR SHARE) IS DISTINCT FROM FALSE THEN
  RAISE EXCEPTION 'reward operations paused' USING ERRCODE='PR001'; END IF;
 PERFORM require_reward_run_authority_v1();
 SELECT * INTO d FROM megapot_pool_drawings WHERE pool_leg_id=p_leg AND drawing_id=p_drawing FOR UPDATE;
 IF NOT FOUND THEN RETURN FALSE; END IF;
 SELECT * INTO STRICT l FROM song_reward_offer_legs WHERE leg_id=p_leg;
 IF l.shared_song_terms_v2->>'empty_behavior' IS DISTINCT FROM 'safe_treasury_ticket_first_v1'
   OR d.frozen_share_count IS DISTINCT FROM 0 THEN RETURN FALSE; END IF;
 IF d.status='credited' AND EXISTS(SELECT 1 FROM reward_safe_treasury_allocations_v1
   WHERE pool_leg_id=p_leg AND drawing_id=p_drawing) THEN RETURN TRUE; END IF;
 IF d.status<>'claimed' THEN RETURN FALSE; END IF;
 SELECT * INTO STRICT a FROM megapot_deployment_attestations WHERE attestation_id=l.attestation_id;
 SELECT * INTO STRICT c FROM megapot_claim_effects WHERE claim_effect_id=d.claim_effect_id;
 IF l.shared_song_terms_v2->>'empty_winnings_recipient' IS DISTINCT FROM a.custody_address
  OR c.received_atomic IS DISTINCT FROM d.net_winnings_atomic OR d.net_winnings_atomic<=0 THEN
  RAISE EXCEPTION 'Safe treasury claim or recipient conflict'; END IF;
 body_hash:=encode(sha256(convert_to(concat_ws(':','pirate.safe-treasury.v1',p_leg,p_drawing,
   d.claim_effect_id,a.chain_id,a.custody_address,a.usdc_address,d.net_winnings_atomic),'UTF8')),'hex');
 batch:='treasury-batch:'||body_hash;
 INSERT INTO megapot_allocation_batches(allocation_batch_id,pool_leg_id,drawing_id,snapshot_id,
   claim_effect_id,algorithm_version,net_winnings_atomic,allocation_count,allocation_hash,state)
 VALUES(batch,p_leg,p_drawing,d.snapshot_id,d.claim_effect_id,'equal_v1',d.net_winnings_atomic,0,body_hash,'prepared');
 INSERT INTO reward_safe_treasury_allocations_v1(allocation_batch_id,pool_leg_id,drawing_id,claim_effect_id,
   chain_id,token_address,treasury_address,amount_atomic)
 VALUES(batch,p_leg,p_drawing,d.claim_effect_id,a.chain_id,a.usdc_address,a.custody_address,d.net_winnings_atomic);
 INSERT INTO megapot_pool_drawing_transitions(pool_leg_id,drawing_id,target_version,event_type,event)
 VALUES(p_leg,p_drawing,d.version+1,'allocated',jsonb_build_object('allocation_batch_id',batch,'allocation_hash',body_hash));
 UPDATE megapot_pool_drawings SET status='allocated',version=d.version+1,allocation_batch_id=batch,
   updated_at=clock_timestamp() WHERE pool_leg_id=p_leg AND drawing_id=p_drawing;
 credit_time:=clock_timestamp();
 UPDATE megapot_allocation_batches SET state='credited',credited_at=credit_time
 WHERE allocation_batch_id=batch;
 INSERT INTO megapot_pool_drawing_transitions(pool_leg_id,drawing_id,target_version,event_type,event)
 VALUES(p_leg,p_drawing,d.version+2,'credited',jsonb_build_object('allocation_batch_id',batch));
 UPDATE megapot_pool_drawings SET status='credited',version=d.version+2,updated_at=clock_timestamp(),terminal_at=credit_time
 WHERE pool_leg_id=p_leg AND drawing_id=p_drawing;
 RETURN TRUE;
END $$;

-- New authority is function-only, including under hostile default grants.
DO $acl$
DECLARE owned_table REGCLASS; grant_row RECORD; name TEXT;
BEGIN
 owned_table:='reward_safe_treasury_allocations_v1'::REGCLASS;
 EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC',owned_table);
 FOR grant_row IN SELECT DISTINCT acl.grantee FROM pg_class c
  CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl
  WHERE c.oid=owned_table AND acl.grantee<>0 AND acl.grantee<>c.relowner LOOP
  EXECUTE format('REVOKE ALL ON TABLE %s FROM %I',owned_table,pg_get_userbyid(grant_row.grantee));
 END LOOP;
 FOREACH name IN ARRAY ARRAY['guard_safe_treasury_terms_v1()','guard_safe_treasury_freeze_v1()',
   'validate_safe_treasury_allocation_v1()','credit_empty_safe_treasury_v1(text,numeric)'] LOOP
  EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog,%I,pg_temp',name,current_schema());
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',name);
  FOR grant_row IN SELECT DISTINCT a.grantee FROM pg_proc p
   CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   WHERE p.oid=name::regprocedure AND a.grantee<>0 AND a.grantee<>p.proowner LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',name,pg_get_userbyid(grant_row.grantee));
  END LOOP;
 END LOOP;
END $acl$;
