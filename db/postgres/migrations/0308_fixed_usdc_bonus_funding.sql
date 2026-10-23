-- Independent, private Safe budget accounting. This dispatches no payment,
-- activates no participant reward and consumes no lottery attestation.
CREATE FUNCTION fixed_usdc_bonus_preimage_v1(p JSONB) RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE keys TEXT[]; ids TEXT[]; numbers TEXT[]; atomics TEXT[]; hashes TEXT[]; key TEXT;
BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'invalid fixed bonus document' USING ERRCODE='FUB00'; END IF;
 CASE p->>'version'
 WHEN 'fixed-usdc-bonus-custody-v1' THEN
  keys:=ARRAY['version','custody_id','chain_id','token_address','token_decimals','asset_policy_version','safe_address','safe_binding_hash','funded_cap_atomic','maximum_budget_count','minimum_confirmations','maximum_observation_age_ms','valid_from_ms','valid_until_ms','accepted_by','acceptance_ref','acceptance_hash'];
  ids:=ARRAY['custody_id','accepted_by','acceptance_ref'];
  numbers:=ARRAY['chain_id','token_decimals','maximum_budget_count','minimum_confirmations','maximum_observation_age_ms','valid_from_ms','valid_until_ms'];
  atomics:=ARRAY['funded_cap_atomic']; hashes:=ARRAY['safe_binding_hash','acceptance_hash'];
 WHEN 'fixed-usdc-bonus-solvency-v1' THEN
  keys:=ARRAY['version','observation_id','custody_id','chain_id','token_address','token_decimals','safe_address','safe_binding_hash','block_number','block_hash','head_block_number','block_timestamp_ms','observed_at_ms','balance_atomic'];
  ids:=ARRAY['custody_id','observation_id']; numbers:=ARRAY['chain_id','token_decimals','block_timestamp_ms','observed_at_ms'];
  atomics:=ARRAY['block_number','head_block_number','balance_atomic']; hashes:=ARRAY['safe_binding_hash'];
 WHEN 'fixed-usdc-bonus-budget-v1' THEN
  keys:=ARRAY['version','idempotency_key','budget_id','custody_id','community_id','song_post_id','audio_revision','amount_per_account_atomic','maximum_accounts','starts_at_ms','ends_at_ms'];
  ids:=ARRAY['idempotency_key','budget_id','custody_id','community_id','song_post_id'];
  numbers:=ARRAY['audio_revision','maximum_accounts','starts_at_ms','ends_at_ms'];
  atomics:=ARRAY['amount_per_account_atomic']; hashes:=ARRAY[]::TEXT[];
 ELSE RAISE EXCEPTION 'invalid fixed bonus document' USING ERRCODE='FUB00';
 END CASE;
 IF p-keys<>'{}'::JSONB OR NOT p ?& keys THEN RAISE EXCEPTION 'invalid fixed bonus fields' USING ERRCODE='FUB00'; END IF;
 FOREACH key IN ARRAY ids LOOP
  IF (jsonb_typeof(p->key)='string' AND p->>key~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$') IS NOT TRUE THEN RAISE EXCEPTION 'invalid fixed bonus identity' USING ERRCODE='FUB00'; END IF;
 END LOOP;
 FOREACH key IN ARRAY numbers LOOP
  IF (jsonb_typeof(p->key)='number' AND p->>key~'^[0-9]+$') IS NOT TRUE THEN RAISE EXCEPTION 'invalid fixed bonus number' USING ERRCODE='FUB00'; END IF;
  IF (p->>key)::NUMERIC>9007199254740991 THEN RAISE EXCEPTION 'unsafe fixed bonus number' USING ERRCODE='FUB00'; END IF;
 END LOOP;
 FOREACH key IN ARRAY atomics LOOP
  IF (jsonb_typeof(p->key)='string' AND p->>key~'^(0|[1-9][0-9]{0,77})$') IS NOT TRUE THEN RAISE EXCEPTION 'invalid fixed bonus amount' USING ERRCODE='FUB00'; END IF;
  IF (p->>key)::NUMERIC>=115792089237316195423570985008687907853269984665640564039457584007913129639936 THEN RAISE EXCEPTION 'fixed bonus amount overflow' USING ERRCODE='FUB00'; END IF;
 END LOOP;
 FOREACH key IN ARRAY hashes LOOP
  IF (jsonb_typeof(p->key)='string' AND p->>key~'^[a-f0-9]{64}$') IS NOT TRUE THEN RAISE EXCEPTION 'invalid fixed bonus hash' USING ERRCODE='FUB00'; END IF;
 END LOOP;
 IF p->>'version'<>'fixed-usdc-bonus-budget-v1' THEN
  IF (p->'chain_id'='8453'::JSONB AND p->>'token_address'='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' AND p->'token_decimals'='6'::JSONB
   AND jsonb_typeof(p->'safe_address')='string' AND p->>'safe_address'~'^0x[0-9a-f]{40}$'
   AND p->>'safe_address'<>('0x'||repeat('0',40)) AND p->>'safe_address'<>p->>'token_address') IS NOT TRUE THEN RAISE EXCEPTION 'fixed bonus custody mismatch' USING ERRCODE='FUB00'; END IF;
 END IF;
 CASE p->>'version'
 WHEN 'fixed-usdc-bonus-custody-v1' THEN
  IF (p->>'asset_policy_version'='base-native-usdc-fixed-bonus-v1' AND (p->>'funded_cap_atomic')::NUMERIC>0
   AND (p->>'maximum_budget_count')::BIGINT BETWEEN 1 AND 10000 AND (p->>'minimum_confirmations')::BIGINT>0
   AND (p->>'maximum_observation_age_ms')::BIGINT>0 AND (p->>'valid_until_ms')::BIGINT>(p->>'valid_from_ms')::BIGINT) IS NOT TRUE THEN RAISE EXCEPTION 'invalid fixed bonus policy' USING ERRCODE='FUB00'; END IF;
 WHEN 'fixed-usdc-bonus-solvency-v1' THEN
  IF (p->>'block_hash'~'^0x[a-f0-9]{64}$' AND jsonb_typeof(p->'block_hash')='string'
   AND (p->>'head_block_number')::NUMERIC>=(p->>'block_number')::NUMERIC AND (p->>'block_timestamp_ms')::BIGINT<=(p->>'observed_at_ms')::BIGINT) IS NOT TRUE THEN RAISE EXCEPTION 'invalid fixed bonus observation' USING ERRCODE='FUB00'; END IF;
 WHEN 'fixed-usdc-bonus-budget-v1' THEN
  IF ((p->>'audio_revision')::BIGINT>0 AND (p->>'maximum_accounts')::BIGINT>0 AND (p->>'amount_per_account_atomic')::NUMERIC>0
   AND (p->>'maximum_accounts')::NUMERIC*(p->>'amount_per_account_atomic')::NUMERIC<115792089237316195423570985008687907853269984665640564039457584007913129639936
   AND (p->>'ends_at_ms')::BIGINT>(p->>'starts_at_ms')::BIGINT) IS NOT TRUE THEN RAISE EXCEPTION 'invalid fixed bonus budget' USING ERRCODE='FUB00'; END IF;
 END CASE;
 RETURN (SELECT jsonb_agg(p->field ORDER BY position) FROM unnest(keys) WITH ORDINALITY AS ordered(field,position));
END $$;

CREATE TABLE fixed_usdc_bonus_custodies_v1 (
 custody_id TEXT PRIMARY KEY,
 safe_address TEXT NOT NULL UNIQUE,
 policy_document JSONB NOT NULL,
 policy_hash TEXT NOT NULL CHECK(policy_hash~'^[a-f0-9]{64}$'),
 funded_cap_atomic reward_funding_atomic_v2 NOT NULL CHECK(funded_cap_atomic>0),
 maximum_budget_count INTEGER NOT NULL CHECK(maximum_budget_count BETWEEN 1 AND 10000),
 maximum_observation_age_ms BIGINT NOT NULL CHECK(maximum_observation_age_ms>0),
 minimum_confirmations BIGINT NOT NULL CHECK(minimum_confirmations>0),
 valid_from_ms BIGINT NOT NULL CHECK(valid_from_ms>=0),
 valid_until_ms BIGINT NOT NULL CHECK(valid_until_ms>valid_from_ms),
 held BOOLEAN NOT NULL DEFAULT FALSE,
 receipt JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE fixed_usdc_bonus_observations_v1 (
 custody_id TEXT NOT NULL REFERENCES fixed_usdc_bonus_custodies_v1(custody_id),
 observation_id TEXT NOT NULL,
 observation_sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
 observation_document JSONB NOT NULL,
 observation_hash TEXT NOT NULL CHECK(observation_hash~'^[a-f0-9]{64}$'),
 block_number reward_funding_atomic_v2 NOT NULL,
 block_hash TEXT NOT NULL CHECK(block_hash~'^0x[a-f0-9]{64}$'),
 observed_at_ms BIGINT NOT NULL CHECK(observed_at_ms>=0),
 balance_atomic reward_funding_atomic_v2 NOT NULL,
 solvent BOOLEAN NOT NULL,
 receipt JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(custody_id,observation_id)
);
CREATE INDEX fixed_usdc_bonus_observations_latest_idx ON fixed_usdc_bonus_observations_v1(custody_id,observation_sequence DESC);
CREATE INDEX fixed_usdc_bonus_observations_block_idx ON fixed_usdc_bonus_observations_v1(custody_id,block_number,block_hash);
CREATE TABLE fixed_usdc_bonus_budgets_v1 (
 budget_id TEXT PRIMARY KEY,
 custody_id TEXT NOT NULL REFERENCES fixed_usdc_bonus_custodies_v1(custody_id),
 idempotency_key TEXT NOT NULL,
 community_id TEXT NOT NULL,
 song_post_id TEXT NOT NULL,
 audio_revision BIGINT NOT NULL CHECK(audio_revision>0),
 command_document JSONB NOT NULL,
 request_hash TEXT NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
 amount_per_account_atomic reward_funding_atomic_v2 NOT NULL CHECK(amount_per_account_atomic>0),
 maximum_accounts BIGINT NOT NULL CHECK(maximum_accounts BETWEEN 1 AND 9007199254740991),
 total_atomic reward_funding_atomic_v2 NOT NULL CHECK(total_atomic=amount_per_account_atomic*maximum_accounts),
 funded_at_ms BIGINT NOT NULL CHECK(funded_at_ms>=0),
 participation_starts_at_ms BIGINT NOT NULL CHECK(participation_starts_at_ms>=funded_at_ms),
 ends_at_ms BIGINT NOT NULL CHECK(ends_at_ms>participation_starts_at_ms),
 receipt JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(custody_id,idempotency_key),
 FOREIGN KEY(community_id,song_post_id) REFERENCES posts(community_id,post_id)
);
CREATE INDEX fixed_usdc_bonus_budgets_custody_idx ON fixed_usdc_bonus_budgets_v1(custody_id);
CREATE INDEX fixed_usdc_bonus_budgets_song_idx ON fixed_usdc_bonus_budgets_v1(community_id,song_post_id);

CREATE FUNCTION guard_fixed_usdc_bonus_history_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='fixed_usdc_bonus_custodies_v1' AND TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-'held')=(to_jsonb(OLD)-'held') AND (NOT OLD.held OR NEW.held) THEN RETURN NEW; END IF;
 END IF;
 RAISE EXCEPTION 'fixed bonus history is immutable' USING ERRCODE='FUB01';
END $$;
CREATE TRIGGER fixed_usdc_bonus_custodies_history_guard BEFORE UPDATE OR DELETE ON fixed_usdc_bonus_custodies_v1 FOR EACH ROW EXECUTE FUNCTION guard_fixed_usdc_bonus_history_v1();
CREATE TRIGGER fixed_usdc_bonus_observations_history_guard BEFORE UPDATE OR DELETE ON fixed_usdc_bonus_observations_v1 FOR EACH ROW EXECUTE FUNCTION guard_fixed_usdc_bonus_history_v1();
CREATE TRIGGER fixed_usdc_bonus_budgets_history_guard BEFORE UPDATE OR DELETE ON fixed_usdc_bonus_budgets_v1 FOR EACH ROW EXECUTE FUNCTION guard_fixed_usdc_bonus_history_v1();

CREATE FUNCTION admit_fixed_usdc_bonus_custody_v1(p_policy JSONB,p_hash TEXT) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE preimage JSONB; prior fixed_usdc_bonus_custodies_v1; at_ms BIGINT; result JSONB;
BEGIN
 preimage:=fixed_usdc_bonus_preimage_v1(p_policy);
 IF p_policy->>'version'<>'fixed-usdc-bonus-custody-v1' OR p_hash IS DISTINCT FROM encode(sha256(convert_to(canonical_reward_funding_array_v2(preimage),'UTF8')),'hex') THEN RAISE EXCEPTION 'fixed bonus policy hash mismatch' USING ERRCODE='FUB00'; END IF;
 -- Serialize both the custody identity and the actual Safe. Different Safe
 -- inputs cannot race the same custody ID into a generic unique violation.
 PERFORM pg_advisory_xact_lock(hashtextextended('fixed-usdc-bonus-id:'||(p_policy->>'custody_id'),0));
 PERFORM pg_advisory_xact_lock(hashtextextended('fixed-usdc-bonus:'||(p_policy->>'safe_address'),0));
 SELECT * INTO prior FROM fixed_usdc_bonus_custodies_v1 WHERE custody_id=p_policy->>'custody_id';
 IF FOUND THEN
  IF prior.policy_hash IS DISTINCT FROM p_hash OR prior.policy_document IS DISTINCT FROM p_policy THEN RAISE EXCEPTION 'fixed bonus custody conflict' USING ERRCODE='FUB01'; END IF;
  RETURN prior.receipt;
 END IF;
 IF EXISTS(SELECT 1 FROM fixed_usdc_bonus_custodies_v1 WHERE safe_address=p_policy->>'safe_address') THEN RAISE EXCEPTION 'fixed bonus Safe already assigned' USING ERRCODE='FUB01'; END IF;
 at_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::BIGINT;
 IF at_ms<(p_policy->>'valid_from_ms')::BIGINT OR at_ms>=(p_policy->>'valid_until_ms')::BIGINT THEN RAISE EXCEPTION 'fixed bonus custody unavailable' USING ERRCODE='FUB03'; END IF;
 result:=jsonb_build_object('version','fixed-usdc-bonus-custody-receipt-v1','custody_id',p_policy->>'custody_id','policy_hash',p_hash,'admitted_at_ms',at_ms);
 INSERT INTO fixed_usdc_bonus_custodies_v1(custody_id,safe_address,policy_document,policy_hash,funded_cap_atomic,maximum_budget_count,maximum_observation_age_ms,minimum_confirmations,valid_from_ms,valid_until_ms,receipt)
 VALUES(p_policy->>'custody_id',p_policy->>'safe_address',p_policy,p_hash,(p_policy->>'funded_cap_atomic')::NUMERIC,(p_policy->>'maximum_budget_count')::INTEGER,(p_policy->>'maximum_observation_age_ms')::BIGINT,(p_policy->>'minimum_confirmations')::BIGINT,(p_policy->>'valid_from_ms')::BIGINT,(p_policy->>'valid_until_ms')::BIGINT,result);
 RETURN result;
END $$;

CREATE FUNCTION observe_fixed_usdc_bonus_solvency_v1(p_observation JSONB,p_hash TEXT) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE preimage JSONB; custody fixed_usdc_bonus_custodies_v1; prior fixed_usdc_bonus_observations_v1; latest fixed_usdc_bonus_observations_v1; at_ms BIGINT; enough BOOLEAN; result JSONB;
BEGIN
 preimage:=fixed_usdc_bonus_preimage_v1(p_observation);
 IF p_observation->>'version'<>'fixed-usdc-bonus-solvency-v1' OR p_hash IS DISTINCT FROM encode(sha256(convert_to(canonical_reward_funding_array_v2(preimage),'UTF8')),'hex') THEN RAISE EXCEPTION 'fixed bonus observation hash mismatch' USING ERRCODE='FUB00'; END IF;
 SELECT * INTO custody FROM fixed_usdc_bonus_custodies_v1 WHERE custody_id=p_observation->>'custody_id' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'fixed bonus custody unavailable' USING ERRCODE='FUB03'; END IF;
 SELECT * INTO prior FROM fixed_usdc_bonus_observations_v1 WHERE custody_id=custody.custody_id AND observation_id=p_observation->>'observation_id';
 IF FOUND THEN
  IF prior.observation_hash IS DISTINCT FROM p_hash OR prior.observation_document IS DISTINCT FROM p_observation THEN RAISE EXCEPTION 'fixed bonus observation conflict' USING ERRCODE='FUB01'; END IF;
  RETURN prior.receipt;
 END IF;
 at_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::BIGINT;
 IF p_observation->>'safe_address' IS DISTINCT FROM custody.safe_address OR p_observation->>'safe_binding_hash' IS DISTINCT FROM custody.policy_document->>'safe_binding_hash'
  OR (p_observation->>'observed_at_ms')::BIGINT>at_ms OR at_ms-(p_observation->>'observed_at_ms')::BIGINT>custody.maximum_observation_age_ms
  OR (p_observation->>'head_block_number')::NUMERIC-(p_observation->>'block_number')::NUMERIC+1<custody.minimum_confirmations THEN RAISE EXCEPTION 'fixed bonus observation unavailable' USING ERRCODE='FUB03'; END IF;
 SELECT * INTO latest FROM fixed_usdc_bonus_observations_v1 WHERE custody_id=custody.custody_id ORDER BY observation_sequence DESC LIMIT 1;
 IF FOUND AND ((p_observation->>'block_number')::NUMERIC<latest.block_number OR (p_observation->>'observed_at_ms')::BIGINT<latest.observed_at_ms) THEN RAISE EXCEPTION 'fixed bonus observation regressed' USING ERRCODE='FUB03'; END IF;
 IF EXISTS(SELECT 1 FROM fixed_usdc_bonus_observations_v1 WHERE custody_id=custody.custody_id AND block_number=(p_observation->>'block_number')::NUMERIC AND block_hash<>p_observation->>'block_hash') THEN
  -- Persist the negative result, rather than rolling back the hold and leaving
  -- a previously positive observation available for another allocation.
  UPDATE fixed_usdc_bonus_custodies_v1 SET held=TRUE WHERE custody_id=custody.custody_id;
  custody.held:=TRUE;
 END IF;
 enough:=NOT custody.held AND (p_observation->>'balance_atomic')::NUMERIC>=custody.funded_cap_atomic;
 result:=jsonb_build_object('version','fixed-usdc-bonus-observation-receipt-v1','custody_id',custody.custody_id,'observation_id',p_observation->>'observation_id','observation_hash',p_hash,'solvent',enough,'recorded_at_ms',at_ms);
 INSERT INTO fixed_usdc_bonus_observations_v1(custody_id,observation_id,observation_document,observation_hash,block_number,block_hash,observed_at_ms,balance_atomic,solvent,receipt)
 VALUES(custody.custody_id,p_observation->>'observation_id',p_observation,p_hash,(p_observation->>'block_number')::NUMERIC,p_observation->>'block_hash',(p_observation->>'observed_at_ms')::BIGINT,(p_observation->>'balance_atomic')::NUMERIC,enough,result);
 RETURN result;
END $$;

CREATE FUNCTION allocate_fixed_usdc_bonus_budget_v1(p_command JSONB,p_hash TEXT) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE preimage JSONB; custody fixed_usdc_bonus_custodies_v1; prior fixed_usdc_bonus_budgets_v1; observation fixed_usdc_bonus_observations_v1; at_ms BIGINT; starts_ms BIGINT; committed NUMERIC; budget_count BIGINT; total NUMERIC; result JSONB;
BEGIN
 preimage:=fixed_usdc_bonus_preimage_v1(p_command);
 IF p_command->>'version'<>'fixed-usdc-bonus-budget-v1' OR p_hash IS DISTINCT FROM encode(sha256(convert_to(canonical_reward_funding_array_v2(preimage),'UTF8')),'hex') THEN RAISE EXCEPTION 'fixed bonus budget hash mismatch' USING ERRCODE='FUB00'; END IF;
 SELECT * INTO custody FROM fixed_usdc_bonus_custodies_v1 WHERE custody_id=p_command->>'custody_id' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'fixed bonus custody unavailable' USING ERRCODE='FUB03'; END IF;
 SELECT * INTO prior FROM fixed_usdc_bonus_budgets_v1 WHERE custody_id=custody.custody_id AND idempotency_key=p_command->>'idempotency_key';
 IF FOUND THEN
  IF prior.request_hash IS DISTINCT FROM p_hash OR prior.command_document IS DISTINCT FROM p_command THEN RAISE EXCEPTION 'fixed bonus budget conflict' USING ERRCODE='FUB01'; END IF;
  RETURN prior.receipt;
 END IF;
 IF EXISTS(SELECT 1 FROM fixed_usdc_bonus_budgets_v1 WHERE budget_id=p_command->>'budget_id') THEN RAISE EXCEPTION 'fixed bonus budget identity reused' USING ERRCODE='FUB01'; END IF;
 -- Authority locks precede the final freshness check. A concurrent community
 -- or Post change must not outlive an earlier positive access observation.
 PERFORM 1 FROM communities WHERE community_id=p_command->>'community_id' AND status='active' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'fixed bonus song unavailable' USING ERRCODE='FUB04'; END IF;
 PERFORM 1 FROM posts p JOIN media_publication_projections m ON m.community_id=p.community_id AND m.post_id=p.post_id AND m.media_kind='song'
  WHERE p.community_id=p_command->>'community_id' AND p.post_id=p_command->>'song_post_id' AND p.post_type='song' AND p.status='published' AND p.visibility='public' AND m.audio_revision=(p_command->>'audio_revision')::BIGINT FOR SHARE OF p,m;
 IF NOT FOUND THEN RAISE EXCEPTION 'fixed bonus song unavailable' USING ERRCODE='FUB04'; END IF;
 -- Re-evaluate time after every potentially blocking authority lock.
 at_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::BIGINT;
 SELECT * INTO observation FROM fixed_usdc_bonus_observations_v1 WHERE custody_id=custody.custody_id ORDER BY observation_sequence DESC LIMIT 1;
 IF NOT FOUND OR custody.held OR NOT observation.solvent OR at_ms<custody.valid_from_ms OR at_ms>=custody.valid_until_ms
  OR at_ms-observation.observed_at_ms>custody.maximum_observation_age_ms THEN RAISE EXCEPTION 'fixed bonus custody unavailable' USING ERRCODE='FUB03'; END IF;
 starts_ms:=greatest((p_command->>'starts_at_ms')::BIGINT,at_ms);
 IF (p_command->>'ends_at_ms')::BIGINT<=starts_ms OR (p_command->>'ends_at_ms')::BIGINT>custody.valid_until_ms THEN RAISE EXCEPTION 'fixed bonus budget interval unavailable' USING ERRCODE='FUB03'; END IF;
 SELECT coalesce(sum(total_atomic),0),count(*) INTO committed,budget_count FROM fixed_usdc_bonus_budgets_v1 WHERE custody_id=custody.custody_id;
 total:=(p_command->>'amount_per_account_atomic')::NUMERIC*(p_command->>'maximum_accounts')::NUMERIC;
 IF committed+total>custody.funded_cap_atomic OR budget_count>=custody.maximum_budget_count THEN RAISE EXCEPTION 'fixed bonus funded capacity exceeded' USING ERRCODE='FUB02'; END IF;
 result:=jsonb_build_object('version','fixed-usdc-bonus-budget-receipt-v1','custody_id',custody.custody_id,'budget_id',p_command->>'budget_id','request_hash',p_hash,'amount_per_account_atomic',p_command->>'amount_per_account_atomic','maximum_accounts',(p_command->>'maximum_accounts')::BIGINT,'total_atomic',total::TEXT,'funded_at_ms',at_ms,'participation_starts_at_ms',starts_ms,'ends_at_ms',(p_command->>'ends_at_ms')::BIGINT);
 INSERT INTO fixed_usdc_bonus_budgets_v1(budget_id,custody_id,idempotency_key,community_id,song_post_id,audio_revision,command_document,request_hash,amount_per_account_atomic,maximum_accounts,total_atomic,funded_at_ms,participation_starts_at_ms,ends_at_ms,receipt)
 VALUES(p_command->>'budget_id',custody.custody_id,p_command->>'idempotency_key',p_command->>'community_id',p_command->>'song_post_id',(p_command->>'audio_revision')::BIGINT,p_command,p_hash,(p_command->>'amount_per_account_atomic')::NUMERIC,(p_command->>'maximum_accounts')::BIGINT,total,at_ms,starts_ms,(p_command->>'ends_at_ms')::BIGINT,result)
 ON CONFLICT DO NOTHING;
 IF NOT FOUND THEN RAISE EXCEPTION 'fixed bonus budget identity reused' USING ERRCODE='FUB01'; END IF;
 RETURN result;
END $$;

-- Only explicitly granted trusted operator purposes may invoke these functions.
-- No ordinary HTTP, qualification, Jobs or media role is granted access here.
DO $acl$ DECLARE f RECORD; trusted TEXT:=current_schema(); BEGIN
 FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname=trusted AND p.proname IN ('fixed_usdc_bonus_preimage_v1','guard_fixed_usdc_bonus_history_v1','admit_fixed_usdc_bonus_custody_v1','observe_fixed_usdc_bonus_solvency_v1','allocate_fixed_usdc_bonus_budget_v1') LOOP
  EXECUTE format('ALTER FUNCTION %s SET search_path=pg_catalog,%I,pg_temp',f.signature,trusted);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
 END LOOP;
END $acl$;
