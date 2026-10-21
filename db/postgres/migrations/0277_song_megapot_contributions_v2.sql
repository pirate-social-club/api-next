-- SOURCE ONLY. Provisional ordinal; registration, CP1/CP2, role mapping and
-- financial/profile acceptance remain separate integration gates. Never replay274.
CREATE DOMAIN reward_funding_atomic_v2 AS NUMERIC(78,0)
  CHECK (VALUE >= 0 AND VALUE < 115792089237316195423570985008687907853269984665640564039457584007913129639936);
REVOKE ALL ON DOMAIN reward_funding_atomic_v2 FROM PUBLIC CASCADE;

-- These are migration/accepted observer inputs, never allocated by a GET.
-- No production economic, freshness, gas, rate or recovery defaults.
CREATE TABLE reward_funding_profiles_v2 (
  profile_id TEXT PRIMARY KEY, profile_hash TEXT NOT NULL UNIQUE CHECK(profile_hash ~ '^[a-f0-9]{64}$'),
  accepted BOOLEAN NOT NULL, valid_until TIMESTAMPTZ NOT NULL,
  policy JSONB NOT NULL CHECK(jsonb_typeof(policy)='object'),
  capacity_profile JSONB NOT NULL CHECK(jsonb_typeof(capacity_profile)='object'),
  nonce_policy JSONB NOT NULL CHECK(jsonb_typeof(nonce_policy)='object'),
  recovery_policy JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  CHECK(policy ?& ARRAY['maxActiveAccount','maxActiveAccountLeg','maxLegLiabilities','maxAdmittedLeg','maxAdmittedAccountLeg','workPerInstruction','economicsPolicyHash','gasPolicyHash','custodyPolicyHash']),
  CHECK((policy->>'maxActiveAccount')::BIGINT>0 AND (policy->>'maxActiveAccountLeg')::BIGINT>0 AND (policy->>'maxLegLiabilities')::BIGINT>0 AND (policy->>'maxAdmittedLeg')::BIGINT>0 AND (policy->>'maxAdmittedAccountLeg')::BIGINT>0 AND (policy->>'workPerInstruction')::BIGINT>0),
  CHECK(nonce_policy ?& ARRAY['hash','maxAgeMs'] AND nonce_policy->>'hash' ~ '^[a-f0-9]{64}$' AND (nonce_policy->>'maxAgeMs')::BIGINT>0)
);
CREATE TABLE reward_funding_schedule_witnesses_v2 (
  witness_id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES reward_funding_profiles_v2,
  witness_hash TEXT NOT NULL CHECK(witness_hash ~ '^[a-f0-9]{64}$'),
  schedule JSONB NOT NULL CHECK(jsonb_typeof(schedule)='object'),
  nonce_witness JSONB NOT NULL CHECK(jsonb_typeof(nonce_witness)='object'),
  valid_until TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp()
);
CREATE TABLE reward_song_slots_v2 (
  slot_id TEXT PRIMARY KEY, community_id TEXT NOT NULL, post_id TEXT NOT NULL,
  generation BIGINT NOT NULL CHECK(generation>=0), target JSONB, terms JSONB,
  -- CP2 must supply actual admitted categorical policy/objective bindings.
  reward_policy_ready BOOLEAN NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('open','closing','sealed','incident')),
  admission_closed_at TIMESTAMPTZ,
  UNIQUE(community_id,post_id), CHECK((target IS NULL)=(terms IS NULL)),
  CHECK((status='open')=(admission_closed_at IS NULL)),
  CHECK(target IS NULL OR (target->>'kind'='committed' AND target->>'community_id'=community_id AND target->>'post_id'=post_id))
);
CREATE FUNCTION guard_reward_song_slot_v2() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF ROW(NEW.slot_id,NEW.community_id,NEW.post_id) IS DISTINCT FROM ROW(OLD.slot_id,OLD.community_id,OLD.post_id)
    OR (OLD.target IS NOT NULL AND ROW(NEW.target,NEW.terms,NEW.generation) IS DISTINCT FROM ROW(OLD.target,OLD.terms,OLD.generation))
    OR (OLD.admission_closed_at IS NOT NULL AND (NEW.admission_closed_at IS DISTINCT FROM OLD.admission_closed_at OR NEW.status='open'))
    OR NEW.admission_closed_at>clock_timestamp() THEN RAISE EXCEPTION 'immutable slot/terminal boundary' USING ERRCODE='PCV06'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reward_song_slot_guard_v2 BEFORE UPDATE ON reward_song_slots_v2 FOR EACH ROW EXECUTE FUNCTION guard_reward_song_slot_v2();
CREATE TABLE reward_funding_leg_snapshots_v2 (
  snapshot_id TEXT PRIMARY KEY, slot_id TEXT NOT NULL REFERENCES reward_song_slots_v2,
  profile_id TEXT NOT NULL REFERENCES reward_funding_profiles_v2,
  witness_id TEXT NOT NULL REFERENCES reward_funding_schedule_witnesses_v2,
  context_hash TEXT NOT NULL UNIQUE CHECK(context_hash ~ '^[a-f0-9]{64}$'),
  context JSONB NOT NULL CHECK(jsonb_typeof(context)='object'),
  -- Held outbound integration must prove these costs at this immutable revision.
  budget JSONB NOT NULL CHECK(jsonb_typeof(budget)='object'),
  costs_reconciled BOOLEAN NOT NULL, refusal TEXT,
  recovery_authority JSONB NOT NULL CHECK(jsonb_typeof(recovery_authority)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp()
);
CREATE TABLE song_megapot_contributions_v2 (
  contribution_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, community_id TEXT NOT NULL,
  post_id TEXT NOT NULL, pool_leg_id TEXT NOT NULL, funding_effect_id TEXT NOT NULL UNIQUE,
  nonce_lease_id TEXT NOT NULL UNIQUE REFERENCES reward_wallet_nonce_leases(lease_id),
  profile_id TEXT NOT NULL REFERENCES reward_funding_profiles_v2,
  snapshot_id TEXT NOT NULL REFERENCES reward_funding_leg_snapshots_v2,
  state JSONB NOT NULL CHECK(jsonb_typeof(state)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  CHECK(state->'owner'->>'account_id'=account_id),
  CHECK(state->'receipt'->>'contribution_id'=contribution_id),
  CHECK(state->'receipt'->>'funding_effect_id'=funding_effect_id),
  CHECK(state->'receipt'->'target'->>'community_id'=community_id),
  CHECK(state->'receipt'->'target'->>'post_id'=post_id),
  CHECK(state->'receipt'->'target'->>'pool_leg_id'=pool_leg_id),
  CHECK((state->>'revision')::BIGINT>=0),
  CHECK(state->>'fundingState' IN ('instruction_issued','submission_claimed','broadcast_unknown','confirming','expired_reconciling','pool_credited','late_principal_owed','nonce_closed_no_principal'))
);
CREATE INDEX song_megapot_contributions_v2_account ON song_megapot_contributions_v2(account_id,pool_leg_id);
CREATE TABLE song_megapot_contribution_commands_v2 (
  command_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  community_id TEXT NOT NULL, post_id TEXT NOT NULL,
  contribution_id TEXT NOT NULL REFERENCES song_megapot_contributions_v2 DEFERRABLE INITIALLY DEFERRED,
  receipt JSONB NOT NULL CHECK(jsonb_typeof(receipt)='object'),
  preparation_revision BIGINT, created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE(account_id,operation,idempotency_key), UNIQUE(contribution_id,preparation_revision),
  CHECK(operation IN ('CreateSongMegapotContributionV2','ClaimSongMegapotContributionSubmissionV2','ObserveSongMegapotContributionV2','RecoverSongMegapotContributionV2','PrepareSongMegapotContributionCancellationV2')),
  CHECK(receipt->>'command_id'=command_id AND receipt->>'request_hash'=request_hash AND receipt->>'contribution_id'=contribution_id)
);
CREATE TABLE reward_funding_submission_claims_v2 (
  contribution_id TEXT NOT NULL REFERENCES song_megapot_contributions_v2,
  purpose TEXT NOT NULL CHECK(purpose IN ('funding_transfer','nonce_cancellation')),
  command_id TEXT NOT NULL UNIQUE REFERENCES song_megapot_contribution_commands_v2 DEFERRABLE INITIALLY DEFERRED,
  grant_id TEXT NOT NULL UNIQUE, receipt JSONB NOT NULL,
  PRIMARY KEY(contribution_id,purpose),
  CHECK(receipt->>'contribution_id'=contribution_id AND receipt->>'purpose'=purpose AND receipt->>'command_id'=command_id AND receipt->>'grant_id'=grant_id)
);
CREATE TABLE reward_contribution_reservations_v2 (
  reservation_id TEXT PRIMARY KEY, contribution_id TEXT NOT NULL UNIQUE REFERENCES song_megapot_contributions_v2,
  pool_leg_id TEXT NOT NULL, amount_atomic reward_funding_atomic_v2 NOT NULL CHECK(amount_atomic>0),
  disposition TEXT NOT NULL CHECK(disposition IN ('held','converted','closed')),
  closure_proof_id TEXT, CHECK((disposition='held')=(closure_proof_id IS NULL))
);
CREATE TABLE reward_funding_account_counters_v2 (
  account_id TEXT NOT NULL, scope_leg TEXT NOT NULL,
  active BIGINT NOT NULL CHECK(active>=0), admitted BIGINT NOT NULL CHECK(admitted>=0),
  custody_liabilities BIGINT NOT NULL CHECK(custody_liabilities>=0),
  PRIMARY KEY(account_id,scope_leg)
);
CREATE TABLE reward_funding_work_envelopes_v2 (
  work_id TEXT PRIMARY KEY, scope TEXT NOT NULL CHECK(scope IN ('account','leg','global','instruction','reconciliation')),
  scope_key TEXT NOT NULL, profile_id TEXT NOT NULL REFERENCES reward_funding_profiles_v2,
  contribution_id TEXT REFERENCES song_megapot_contributions_v2 DEFERRABLE INITIALLY DEFERRED,
  allocated BIGINT NOT NULL CHECK(allocated>0), used BIGINT NOT NULL CHECK(used>=0 AND used<=allocated),
  reserved BIGINT NOT NULL CHECK(reserved>=0 AND used+reserved<=allocated),
  valid_until TIMESTAMPTZ NOT NULL, payload JSONB,
  UNIQUE(scope,scope_key)
);
CREATE TABLE reward_funding_scan_checkpoints_v2 (
  checkpoint_id TEXT PRIMARY KEY, contribution_id TEXT NOT NULL REFERENCES song_megapot_contributions_v2,
  previous_checkpoint_id TEXT REFERENCES reward_funding_scan_checkpoints_v2,
  from_block BIGINT NOT NULL CHECK(from_block>=0), through_block BIGINT NOT NULL CHECK(through_block>=from_block),
  block_hash TEXT NOT NULL CHECK(block_hash ~ '^0x[a-f0-9]{64}$'),
  block_time TIMESTAMPTZ NOT NULL, accepted_finality_at TIMESTAMPTZ NOT NULL,
  evidence JSONB NOT NULL, UNIQUE(contribution_id,from_block), UNIQUE(previous_checkpoint_id)
);
CREATE TABLE reward_incoming_receipts_v2 (
  receipt_id TEXT PRIMARY KEY, contribution_id TEXT NOT NULL UNIQUE REFERENCES song_megapot_contributions_v2,
  chain_id BIGINT NOT NULL CHECK(chain_id>0), transaction_hash TEXT NOT NULL CHECK(transaction_hash ~ '^0x[a-f0-9]{64}$'),
  transfer_log_index BIGINT NOT NULL CHECK(transfer_log_index>=0),
  sender_address TEXT NOT NULL CHECK(sender_address ~ '^0x[a-f0-9]{40}$'), sender_nonce BIGINT NOT NULL CHECK(sender_nonce>=0),
  amount_atomic reward_funding_atomic_v2 NOT NULL CHECK(amount_atomic>0),
  category TEXT NOT NULL CHECK(category IN ('pool_principal','late_principal','unattributed_principal')),
  evidence JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE(chain_id,transaction_hash,transfer_log_index)
);

CREATE FUNCTION guard_reward_funding_scan_checkpoint_v2() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior reward_funding_scan_checkpoints_v2; c song_megapot_contributions_v2;
BEGIN
  SELECT * INTO STRICT c FROM song_megapot_contributions_v2 WHERE contribution_id=NEW.contribution_id;
  IF NEW.previous_checkpoint_id IS NULL THEN
    IF NEW.from_block<>(c.state->'receipt'->'reservation'->>'valid_from_block_exclusive')::BIGINT+1 THEN RAISE EXCEPTION 'scan must start after original anchor' USING ERRCODE='PCV10'; END IF;
  ELSE
    SELECT * INTO STRICT prior FROM reward_funding_scan_checkpoints_v2 WHERE checkpoint_id=NEW.previous_checkpoint_id;
    IF prior.contribution_id<>NEW.contribution_id OR NEW.from_block<>prior.through_block+1 OR NEW.block_time<prior.block_time THEN RAISE EXCEPTION 'noncontiguous scan proof' USING ERRCODE='PCV10'; END IF;
  END IF;
  IF NEW.evidence->>'complete' IS DISTINCT FROM 'true' OR NEW.evidence->>'policy_hash' !~ '^[a-f0-9]{64}$'
    OR NEW.accepted_finality_at<NEW.block_time THEN RAISE EXCEPTION 'unproved scan finality' USING ERRCODE='PCV10'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reward_funding_scan_checkpoint_guard_v2 BEFORE INSERT ON reward_funding_scan_checkpoints_v2
  FOR EACH ROW EXECUTE FUNCTION guard_reward_funding_scan_checkpoint_v2();

CREATE FUNCTION reject_reward_contribution_history_v2() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'immutable contribution evidence' USING ERRCODE='PCV01';
END $$;
DO $immutable$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['reward_funding_profiles_v2','reward_funding_schedule_witnesses_v2','reward_funding_leg_snapshots_v2','song_megapot_contribution_commands_v2','reward_funding_submission_claims_v2','reward_incoming_receipts_v2','reward_funding_scan_checkpoints_v2'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_reward_contribution_history_v2()',t||'_append_only',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['reward_funding_profiles_v2','reward_funding_schedule_witnesses_v2','reward_song_slots_v2','reward_funding_leg_snapshots_v2','song_megapot_contributions_v2','song_megapot_contribution_commands_v2','reward_funding_submission_claims_v2','reward_contribution_reservations_v2','reward_funding_account_counters_v2','reward_funding_work_envelopes_v2','reward_funding_scan_checkpoints_v2','reward_incoming_receipts_v2'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reject_reward_contribution_history_v2()',t||'_no_truncate',t);
    IF t IN ('reward_song_slots_v2','song_megapot_contributions_v2','reward_contribution_reservations_v2','reward_funding_account_counters_v2','reward_funding_work_envelopes_v2') THEN
      EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_reward_contribution_history_v2()',t||'_no_delete',t);
    END IF;
  END LOOP;
END $immutable$;

CREATE FUNCTION load_song_contribution_command_v2(a TEXT,o TEXT,k TEXT) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT jsonb_build_object('requestHash',request_hash,'receipt',receipt)
  FROM song_megapot_contribution_commands_v2 WHERE account_id=a AND operation=o AND idempotency_key=k
$$;
CREATE FUNCTION project_song_contribution_state_v2(s JSONB) RETURNS JSONB
LANGUAGE plpgsql STABLE AS $$
DECLARE issued TIMESTAMPTZ:=(s->'receipt'->>'created_at')::TIMESTAMPTZ; deadline TIMESTAMPTZ;
BEGIN
  -- Durable first-invalidating history; unpause/reactivation never resurrects
  -- an issued funding interval. CP1/CP2 exclusion/terminal event producers
  -- remain a required source integration, not an assumed membership gate.
  deadline:=least((s->>'effectiveDeadline')::TIMESTAMPTZ,(s->'receipt'->'committed_terms'->>'ends_at')::TIMESTAMPTZ,
    (SELECT min(changed_at) FROM reward_operations_control_events WHERE paused AND changed_at>=issued),
    (SELECT tombstoned_at FROM persona_wallet_assignments WHERE assignment_id=s->'owner'->>'wallet_assignment_id'),
    (SELECT admission_closed_at FROM reward_song_slots_v2 WHERE community_id=s->'receipt'->'target'->>'community_id' AND post_id=s->'receipt'->'target'->>'post_id'),
    (SELECT retired_at FROM megapot_deployment_attestations WHERE attestation_id=s->'receipt'->'instruction'->>'attestation_id'));
  s:=jsonb_set(s,'{effectiveDeadline}',to_jsonb(to_char(deadline AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  IF deadline<=statement_timestamp() AND s->>'fundingState' IN ('instruction_issued','submission_claimed','broadcast_unknown','confirming') THEN
    s:=jsonb_set(s,'{fundingState}','"expired_reconciling"');
  END IF;
  RETURN s;
END $$;
CREATE FUNCTION load_owned_song_contribution_v2(i JSONB) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT project_song_contribution_state_v2(state) FROM song_megapot_contributions_v2 WHERE account_id=i->>'accountId'
    AND community_id=i->>'communityId' AND post_id=i->>'postId' AND contribution_id=i->>'contributionId'
$$;

CREATE FUNCTION lock_song_contribution_context_v2(i JSONB,h TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE snap reward_funding_leg_snapshots_v2; slot reward_song_slots_v2; p reward_funding_profiles_v2;
  w reward_funding_schedule_witnesses_v2; counters JSONB; work JSONB; leg TEXT; principal JSONB;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('funding-account-v2',i->>'accountId')::text,0));
  SELECT * INTO STRICT snap FROM reward_funding_leg_snapshots_v2 WHERE context_hash=h;
  SELECT * INTO STRICT slot FROM reward_song_slots_v2 WHERE slot_id=snap.slot_id FOR UPDATE;
  IF slot.community_id<>i->>'communityId' OR slot.post_id<>i->>'postId' OR snap.context->'actor'->>'account_id'<>i->>'accountId' THEN
    RAISE EXCEPTION 'private contribution context' USING ERRCODE='PCV02'; END IF;
  PERFORM lock_reward_wallet_nonce_sender_v2((snap.context->>'chain_id')::BIGINT,snap.context->'actor'->>'sender_address');
  SELECT * INTO STRICT p FROM reward_funding_profiles_v2 WHERE profile_id=snap.profile_id FOR SHARE;
  SELECT * INTO STRICT w FROM reward_funding_schedule_witnesses_v2 WHERE witness_id=snap.witness_id;
  leg:=slot.target->>'pool_leg_id';
  -- Missing envelopes never create a budget. They are admitted operational inputs.
  PERFORM 1 FROM reward_funding_work_envelopes_v2 WHERE (scope,scope_key) IN
    (('account',i->>'accountId'),('leg',leg),('global','funding')) ORDER BY scope,scope_key FOR UPDATE;
  SELECT jsonb_object_agg(scope,allocated-used-reserved) INTO work FROM reward_funding_work_envelopes_v2
    WHERE profile_id=p.profile_id AND valid_until>clock_timestamp() AND (scope,scope_key) IN
    (('account',i->>'accountId'),('leg',leg),('global','funding'));
  SELECT jsonb_build_object(
    'activeAccount',count(*) FILTER(WHERE account_id=i->>'accountId' AND NOT (state->>'nonceFinalized')::BOOLEAN)+(SELECT count(*) FROM song_reward_leg_funding_effects WHERE funder_account_id=i->>'accountId' AND state IN ('planned','confirming','reconciliation_required','reclaimable_failed')),
    'activeAccountLeg',count(*) FILTER(WHERE account_id=i->>'accountId' AND pool_leg_id=leg AND NOT (state->>'nonceFinalized')::BOOLEAN),
    'legLiabilities',count(*) FILTER(WHERE pool_leg_id=leg AND state->>'fundingState'<>'nonce_closed_no_principal'),
    'admittedLeg',count(*) FILTER(WHERE pool_leg_id=leg AND state->>'fundingState'='pool_credited'),
    'admittedAccountLeg',count(*) FILTER(WHERE account_id=i->>'accountId' AND pool_leg_id=leg AND state->>'fundingState'='pool_credited'))
    INTO counters FROM song_megapot_contributions_v2 WHERE account_id=i->>'accountId' OR pool_leg_id=leg;
  SELECT jsonb_build_object('funded',coalesce((SELECT sum(r.amount_atomic) FROM reward_incoming_receipts_v2 r JOIN song_megapot_contributions_v2 c USING(contribution_id) WHERE c.pool_leg_id=leg AND r.category='pool_principal'),0)::TEXT,
    'reserved',coalesce((SELECT sum(amount_atomic) FROM reward_contribution_reservations_v2 WHERE pool_leg_id=leg AND disposition='held'),0)::TEXT) INTO principal;
  RETURN jsonb_build_object('snapshot',to_jsonb(snap),'slot',to_jsonb(slot),'profile',to_jsonb(p),'witness',to_jsonb(w),'counts',counters,'work',work,'principal',principal);
END $$;

CREATE FUNCTION insert_song_contribution_command_v2(i JSONB,r JSONB) RETURNS VOID
LANGUAGE plpgsql AS $$ BEGIN
  IF r->>'request_hash' IS DISTINCT FROM i->>'hash' THEN RAISE EXCEPTION 'command hash' USING ERRCODE='PCV03'; END IF;
  INSERT INTO song_megapot_contribution_commands_v2(command_id,account_id,operation,idempotency_key,request_hash,community_id,post_id,contribution_id,receipt,preparation_revision)
  VALUES(r->>'command_id',i->>'accountId',i->>'operation',i->>'key',i->>'hash',i->>'communityId',i->>'postId',r->>'contribution_id',r,
    CASE WHEN r->>'object'='contribution_cancellation_command_receipt' THEN (r->>'preparation_revision')::BIGINT END);
END $$;

CREATE FUNCTION charge_reward_funding_work_v2(a TEXT,l TEXT,p TEXT,n BIGINT) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE affected INTEGER;
BEGIN
  IF n<=0 THEN RAISE EXCEPTION 'work policy unavailable' USING ERRCODE='PCV04'; END IF;
  UPDATE reward_funding_work_envelopes_v2 SET used=used+n,reserved=reserved-n WHERE profile_id=p AND valid_until>clock_timestamp()
    AND (scope,scope_key) IN (('account',a),('leg',l),('global','funding')) AND reserved>=n;
  GET DIAGNOSTICS affected=ROW_COUNT;
  IF affected<>3 THEN RAISE EXCEPTION 'work budget exhausted' USING ERRCODE='PCV04'; END IF;
END $$;

CREATE FUNCTION assert_reward_contribution_capacity_v2(snapshot TEXT,r JSONB) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE snap reward_funding_leg_snapshots_v2; p reward_funding_profiles_v2; w reward_funding_schedule_witnesses_v2;
  funded NUMERIC; free NUMERIC; live NUMERIC; opportunities NUMERIC; committed NUMERIC; amount reward_funding_atomic_v2;
  d JSONB; deadline_ms NUMERIC; margin NUMERIC; total NUMERIC:=0;
BEGIN
  SELECT * INTO STRICT snap FROM reward_funding_leg_snapshots_v2 WHERE snapshot_id=snapshot;
  SELECT * INTO STRICT p FROM reward_funding_profiles_v2 WHERE profile_id=snap.profile_id;
  SELECT * INTO STRICT w FROM reward_funding_schedule_witnesses_v2 WHERE witness_id=snap.witness_id;
  IF NOT snap.costs_reconciled OR snap.refusal IS NOT NULL OR w.valid_until<=clock_timestamp()
    OR (r->'instruction'->>'expires_at')::TIMESTAMPTZ>=(snap.context->'limits'->>'reservation_deadline_upper_bound')::TIMESTAMPTZ
    OR (r->'instruction'->>'expires_at')::TIMESTAMPTZ>=(r->'committed_terms'->>'ends_at')::TIMESTAMPTZ
    OR (snap.context->'limits'->>'latest_allocation_at')::TIMESTAMPTZ<=clock_timestamp() THEN RAISE EXCEPTION 'capacity facts unavailable' USING ERRCODE='PCV05'; END IF;
  amount:=(r->'instruction'->>'amount_atomic')::reward_funding_atomic_v2;
  deadline_ms:=extract(epoch FROM (snap.context->'limits'->>'reservation_deadline_upper_bound')::TIMESTAMPTZ)*1000;
  margin:=(p.capacity_profile->>'safetyMarginMs')::NUMERIC;
  opportunities:=0;committed:=0;
  FOR d IN SELECT value FROM jsonb_array_elements(w.schedule->'rows') LOOP
    IF NOT (r->'committed_terms'->'planned_drawing_ids' ? (d->>'id')) THEN CONTINUE; END IF;
    IF (d->>'priceAtomic')::NUMERIC<=0 OR (d->>'priceAtomic')::NUMERIC>(r->'committed_terms'->>'ticket_price_ceiling_atomic')::NUMERIC THEN RAISE EXCEPTION 'unproved price' USING ERRCODE='PCV05'; END IF;
    IF d->>'state'='committed' THEN committed:=committed+(d->>'reservedCostAtomic')::NUMERIC; END IF;
    IF d->>'state'='uncommitted' AND (d->>'entryCutoff')::NUMERIC<=extract(epoch FROM (r->'committed_terms'->>'ends_at')::TIMESTAMPTZ)*1000
      AND deadline_ms+margin<=(d->>'entryCutoff')::NUMERIC AND deadline_ms+margin<=(d->>'purchaseDeadline')::NUMERIC THEN
      opportunities:=opportunities+(d->>'priceAtomic')::NUMERIC;
    END IF;
  END LOOP;
  IF committed<>(snap.budget->>'committedPurchases')::NUMERIC THEN RAISE EXCEPTION 'unreconciled purchase exposure' USING ERRCODE='PCV05'; END IF;
  SELECT coalesce(sum(x.amount_atomic),0) INTO funded FROM reward_incoming_receipts_v2 x JOIN song_megapot_contributions_v2 c USING(contribution_id) WHERE c.pool_leg_id=r->'target'->>'pool_leg_id' AND x.category='pool_principal';
  IF funded<>(snap.budget->>'funded')::NUMERIC THEN RAISE EXCEPTION 'stale budget revision' USING ERRCODE='PCV06'; END IF;
  free:=funded-(snap.budget->>'spent')::NUMERIC-committed-(snap.budget->>'refunded')::NUMERIC-(snap.budget->>'otherObligations')::NUMERIC;
  SELECT coalesce(sum(amount_atomic),0) INTO live FROM reward_contribution_reservations_v2 WHERE pool_leg_id=r->'target'->>'pool_leg_id' AND disposition='held';
  IF free<0 OR amount<=0 OR amount>opportunities-free-live OR amount<(snap.context->'limits'->>'minimum_atomic')::NUMERIC OR amount>(snap.context->'limits'->>'maximum_atomic')::NUMERIC THEN RAISE EXCEPTION 'capacity exceeded' USING ERRCODE='PCV07'; END IF;
  total:=funded+live+amount;
  IF total>=115792089237316195423570985008687907853269984665640564039457584007913129639936 THEN RAISE EXCEPTION 'aggregate representation overflow' USING ERRCODE='PCV07'; END IF;
END $$;

CREATE FUNCTION create_song_contribution_v2(i JSONB,s JSONB,snapshot TEXT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE r JSONB:=s->'receipt'; o JSONB:=s->'owner'; snap reward_funding_leg_snapshots_v2;
  slot reward_song_slots_v2; p reward_funding_profiles_v2; lease reward_wallet_nonce_leases; amount reward_funding_atomic_v2;
  leg TEXT:=r->'target'->>'pool_leg_id'; cap BIGINT; active_count BIGINT; affected INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('funding-account-v2',i->>'accountId')::text,0));
  SELECT * INTO STRICT snap FROM reward_funding_leg_snapshots_v2 WHERE snapshot_id=snapshot;
  SELECT * INTO STRICT slot FROM reward_song_slots_v2 WHERE slot_id=snap.slot_id FOR UPDATE;
  PERFORM lock_reward_wallet_nonce_sender_v2((r->'instruction'->>'chain_id')::BIGINT,r->'instruction'->>'from');
  SELECT * INTO STRICT p FROM reward_funding_profiles_v2 WHERE profile_id=snap.profile_id;
  IF NOT p.accepted OR p.valid_until<=clock_timestamp() OR NOT slot.reward_policy_ready THEN RAISE EXCEPTION 'policy unavailable' USING ERRCODE='PCV05'; END IF;
  IF slot.status<>'open' OR slot.target IS DISTINCT FROM r->'target' OR slot.terms IS DISTINCT FROM r->'committed_terms' THEN RAISE EXCEPTION 'target terms changed' USING ERRCODE='PCV06'; END IF;
  IF snap.context->'actor' IS DISTINCT FROM o OR i->>'accountId' IS DISTINCT FROM o->>'account_id'
    OR slot.community_id<>i->>'communityId' OR slot.post_id<>i->>'postId'
    OR (s->>'revision')::BIGINT<>0 OR s->>'fundingState'<>'instruction_issued' OR (s->>'nonceFinalized')::BOOLEAN
    OR s->'fundingGrant'<>'null'::JSONB OR s->'cancellationGrant'<>'null'::JSONB OR s->'cancellationHead'<>'null'::JSONB
    OR s->>'effectiveDeadline' IS DISTINCT FROM r->'instruction'->>'expires_at'
    OR (r->'instruction'->>'expires_at')::TIMESTAMPTZ<=clock_timestamp() THEN RAISE EXCEPTION 'invalid contribution provenance' USING ERRCODE='PCV02'; END IF;
  amount:=(r->'instruction'->>'amount_atomic')::reward_funding_atomic_v2;
  IF amount<=0 OR amount<>(r->'reservation'->>'amount_atomic')::NUMERIC THEN RAISE EXCEPTION 'positive principal required' USING ERRCODE='PCV07'; END IF;
  PERFORM assert_reward_contribution_capacity_v2(snapshot,r);
  IF NOT EXISTS(SELECT 1 FROM persona_wallet_assignments a JOIN personas v USING(persona_id,account_id)
    JOIN persona_community_bindings b USING(persona_id,account_id) WHERE a.assignment_id=o->>'wallet_assignment_id'
      AND a.account_id=i->>'accountId' AND a.persona_id=o->>'persona_id' AND a.address=o->>'sender_address'
      AND a.status='active' AND v.status='active' AND b.community_id=i->>'communityId'
      AND a.hd_wallet_index=(o->>'wallet_index')::BIGINT) THEN RAISE EXCEPTION 'owned community persona required' USING ERRCODE='PCV02'; END IF;
  SELECT * INTO STRICT lease FROM reward_wallet_nonce_leases WHERE lease_id=r->'reservation'->>'nonce_lease_id';
  IF lease.source<>'song_funding_v2' OR lease.owner_id<>r->>'contribution_id' OR lease.command_id<>r->>'command_id'
    OR lease.request_hash<>i->>'hash' OR lease.account_id<>i->>'accountId' OR lease.persona_id<>o->>'persona_id'
    OR lease.wallet_assignment_id<>o->>'wallet_assignment_id' OR lease.sender_address<>r->'instruction'->>'from'
    OR lease.nonce<>(r->'instruction'->>'nonce')::BIGINT THEN RAISE EXCEPTION 'original nonce ownership required' USING ERRCODE='PCV02'; END IF;
  SELECT count(*) INTO active_count FROM song_megapot_contributions_v2 WHERE account_id=i->>'accountId' AND NOT (state->>'nonceFinalized')::BOOLEAN;
  active_count:=active_count+(SELECT count(*) FROM song_reward_leg_funding_effects WHERE funder_account_id=i->>'accountId' AND state IN ('planned','confirming','reconciliation_required','reclaimable_failed'));
  IF active_count>=(p.policy->>'maxActiveAccount')::BIGINT THEN RAISE EXCEPTION 'account effect limit' USING ERRCODE='PCV08'; END IF;
  SELECT count(*) INTO cap FROM song_megapot_contributions_v2 WHERE pool_leg_id=leg AND state->>'fundingState'<>'nonce_closed_no_principal';
  IF cap>=least((p.policy->>'maxLegLiabilities')::BIGINT,(p.policy->>'maxAdmittedLeg')::BIGINT) THEN RAISE EXCEPTION 'leg effect limit' USING ERRCODE='PCV08'; END IF;
  SELECT count(*) INTO cap FROM song_megapot_contributions_v2 WHERE account_id=i->>'accountId' AND pool_leg_id=leg AND NOT (state->>'nonceFinalized')::BOOLEAN;
  IF cap>=(p.policy->>'maxActiveAccountLeg')::BIGINT THEN RAISE EXCEPTION 'account leg active limit' USING ERRCODE='PCV08'; END IF;
  SELECT count(*) INTO cap FROM song_megapot_contributions_v2 WHERE account_id=i->>'accountId' AND pool_leg_id=leg AND state->>'fundingState'<>'nonce_closed_no_principal';
  IF cap>=(p.policy->>'maxAdmittedAccountLeg')::BIGINT THEN RAISE EXCEPTION 'account leg lifetime limit' USING ERRCODE='PCV08'; END IF;
  UPDATE reward_funding_work_envelopes_v2 SET reserved=reserved+(p.policy->>'workPerInstruction')::BIGINT WHERE profile_id=p.profile_id AND valid_until>clock_timestamp()
    AND (scope,scope_key) IN (('account',i->>'accountId'),('leg',leg),('global','funding')) AND allocated-used-reserved>=(p.policy->>'workPerInstruction')::BIGINT;
  GET DIAGNOSTICS affected=ROW_COUNT;
  IF affected<>3 THEN RAISE EXCEPTION 'work envelope unavailable' USING ERRCODE='PCV04'; END IF;
  INSERT INTO song_megapot_contributions_v2 VALUES(r->>'contribution_id',i->>'accountId',i->>'communityId',i->>'postId',leg,r->>'funding_effect_id',lease.lease_id,p.profile_id,snapshot,s,transaction_timestamp());
  PERFORM insert_song_contribution_command_v2(i,r);
  INSERT INTO reward_contribution_reservations_v2 VALUES(r->'reservation'->>'reservation_id',r->>'contribution_id',leg,amount,'held',NULL);
  INSERT INTO reward_funding_account_counters_v2 VALUES(i->>'accountId','',1,0,0)
    ON CONFLICT(account_id,scope_leg) DO UPDATE SET active=reward_funding_account_counters_v2.active+1;
  INSERT INTO reward_funding_account_counters_v2 VALUES(i->>'accountId',leg,1,0,0)
    ON CONFLICT(account_id,scope_leg) DO UPDATE SET active=reward_funding_account_counters_v2.active+1;
  INSERT INTO reward_funding_work_envelopes_v2 VALUES('instruction:'||(r->>'contribution_id'),'instruction',r->>'contribution_id',p.profile_id,r->>'contribution_id',(p.policy->>'workPerInstruction')::BIGINT,0,0,p.valid_until,NULL);
END $$;

CREATE FUNCTION update_song_contribution_command_v2(i JSONB,b JSONB,s JSONB,r JSONB) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE c song_megapot_contributions_v2; plan JSONB; purpose TEXT; policy JSONB; authority JSONB;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('funding-account-v2',i->>'accountId')::text,0));
  SELECT * INTO STRICT c FROM song_megapot_contributions_v2 WHERE contribution_id=i->>'contributionId' AND account_id=i->>'accountId' AND community_id=i->>'communityId' AND post_id=i->>'postId' FOR UPDATE;
  PERFORM lock_reward_wallet_nonce_sender_v2((c.state->'receipt'->'instruction'->>'chain_id')::BIGINT,c.state->'owner'->>'sender_address');
  IF r->>'object'='contribution_cancellation_command_receipt'
    OR (r->>'object'='contribution_submission_claim_receipt' AND r->>'purpose'='nonce_cancellation') THEN
    authority:=load_song_contribution_recovery_v2(i);
    IF authority->'policy' IS NULL OR authority->'policy'='null'::JSONB THEN
      RAISE EXCEPTION 'current cancellation recovery evidence unavailable' USING ERRCODE='PCV12';
    END IF;
    policy:=authority->'policy';
  END IF;
  PERFORM require_reward_run_authority_v1();
  IF (SELECT paused FROM reward_operations_control WHERE singleton FOR SHARE) IS DISTINCT FROM FALSE THEN RAISE EXCEPTION 'paused' USING ERRCODE='PR001'; END IF;
  IF project_song_contribution_state_v2(c.state) IS DISTINCT FROM b OR (s->>'revision')::BIGINT<>(b->>'revision')::BIGINT+1
    OR s->'owner' IS DISTINCT FROM b->'owner' OR s->'receipt' IS DISTINCT FROM b->'receipt'
    OR s->>'effectiveDeadline' IS DISTINCT FROM b->>'effectiveDeadline' OR s->'nonceFinalized' IS DISTINCT FROM b->'nonceFinalized'
    OR (b->>'nonceFinalized')::BOOLEAN THEN RAISE EXCEPTION 'lifecycle changed' USING ERRCODE='PCV06'; END IF;
  IF r->>'object'='contribution_submission_claim_receipt' THEN
    purpose:=r->>'purpose';
    IF (r->>'valid_until')::TIMESTAMPTZ<=clock_timestamp() THEN RAISE EXCEPTION 'instruction expired' USING ERRCODE='PCV09'; END IF;
    IF purpose='funding_transfer' THEN
      IF b->'fundingGrant'<>'null'::JSONB OR b->'cancellationGrant'<>'null'::JSONB OR s->'fundingGrant' IS DISTINCT FROM r
        OR s->>'fundingState'<>'submission_claimed' OR s->'cancellationGrant' IS DISTINCT FROM b->'cancellationGrant'
        OR r->>'instruction_hash' IS DISTINCT FROM b->'receipt'->'instruction'->>'instruction_hash'
        OR r->>'valid_until' IS DISTINCT FROM b->'receipt'->'instruction'->>'expires_at'
        OR (b->>'effectiveDeadline')::TIMESTAMPTZ<=clock_timestamp() THEN RAISE EXCEPTION 'funding purpose consumed or expired' USING ERRCODE='PCV09'; END IF;
    ELSIF purpose='nonce_cancellation' THEN
      plan:=b->'cancellationHead';
      IF plan->>'recovery_policy_hash' IS DISTINCT FROM policy->>'policy_hash'
        OR plan->>'recovery_attestation_id' IS DISTINCT FROM authority->>'attestationId'
        OR plan->>'recovery_attestation_hash' IS DISTINCT FROM authority->>'attestationHash'
        OR plan->>'recovery_attestation_valid_until' IS DISTINCT FROM authority->>'attestationValidUntil' THEN
        RAISE EXCEPTION 'current recovery authority changed' USING ERRCODE='PCV12'; END IF;
      IF b->'cancellationGrant'<>'null'::JSONB OR plan='null'::JSONB OR s->'cancellationGrant' IS DISTINCT FROM r
        OR s->>'fundingState' IS DISTINCT FROM b->>'fundingState' OR s->'fundingGrant' IS DISTINCT FROM b->'fundingGrant'
        OR r->>'instruction_hash' IS DISTINCT FROM plan->>'instruction_hash'
        OR r->>'valid_until' IS DISTINCT FROM plan->>'dispatch_expires_at'
        OR r->>'cancellation_preparation_id' IS DISTINCT FROM plan->>'preparation_id'
        OR r->'cancellation_preparation_revision' IS DISTINCT FROM plan->'preparation_revision' THEN RAISE EXCEPTION 'cancellation purpose consumed or stale' USING ERRCODE='PCV09'; END IF;
    ELSE RAISE EXCEPTION 'invalid purpose' USING ERRCODE='PCV02'; END IF;
    IF s->'cancellationHead' IS DISTINCT FROM b->'cancellationHead' OR s->'preparationsUsed' IS DISTINCT FROM b->'preparationsUsed' THEN RAISE EXCEPTION 'claim cannot reprepare' USING ERRCODE='PCV02'; END IF;
    INSERT INTO reward_funding_submission_claims_v2 VALUES(c.contribution_id,purpose,r->>'command_id',r->>'grant_id',r);
  ELSIF r->>'object'='contribution_cancellation_command_receipt' THEN
    IF r->>'recovery_policy_hash' IS DISTINCT FROM policy->>'policy_hash'
      OR r->>'recovery_attestation_id' IS DISTINCT FROM authority->>'attestationId'
      OR r->>'recovery_attestation_hash' IS DISTINCT FROM authority->>'attestationHash'
      OR r->>'recovery_attestation_valid_until' IS DISTINCT FROM authority->>'attestationValidUntil'
      OR (r->>'dispatch_expires_at')::TIMESTAMPTZ>least((r->>'prepared_at')::TIMESTAMPTZ+(least((policy->>'dispatch_ttl_seconds')::NUMERIC,extract(epoch FROM ((policy->>'valid_until')::TIMESTAMPTZ-(r->>'prepared_at')::TIMESTAMPTZ)),extract(epoch FROM ((authority->>'attestationValidUntil')::TIMESTAMPTZ-(r->>'prepared_at')::TIMESTAMPTZ)))*interval '1 second'),(policy->>'valid_until')::TIMESTAMPTZ,(authority->>'attestationValidUntil')::TIMESTAMPTZ)
      OR (r->>'prepared_at')::TIMESTAMPTZ>clock_timestamp() THEN RAISE EXCEPTION 'recovery validity mismatch' USING ERRCODE='PCV12'; END IF;
    IF policy IS NULL OR b->'cancellationGrant'<>'null'::JSONB OR s->>'fundingState' IS DISTINCT FROM b->>'fundingState'
      OR s->'fundingGrant' IS DISTINCT FROM b->'fundingGrant' OR s->'cancellationGrant' IS DISTINCT FROM b->'cancellationGrant'
      OR s->'cancellationHead' IS DISTINCT FROM r OR (s->>'preparationsUsed')::BIGINT<>(b->>'preparationsUsed')::BIGINT+1
      OR (s->>'preparationsUsed')::BIGINT>(policy->>'max_preparations_per_contribution')::BIGINT
      OR r->>'previous_preparation_id' IS DISTINCT FROM b->'cancellationHead'->>'preparation_id'
      OR r->>'previous_preparation_instruction_hash' IS DISTINCT FROM b->'cancellationHead'->>'instruction_hash'
      OR r->>'sender' IS DISTINCT FROM b->'receipt'->'instruction'->>'from' OR r->>'recipient'<>r->>'sender'
      OR r->>'nonce' IS DISTINCT FROM b->'receipt'->'instruction'->>'nonce' OR r->>'data'<>'0x' OR r->>'value_atomic'<>'0'
      OR (r->>'dispatch_expires_at')::TIMESTAMPTZ<=clock_timestamp()
      OR (b->'cancellationHead'->>'dispatch_expires_at')::TIMESTAMPTZ>clock_timestamp() THEN RAISE EXCEPTION 'cancellation preparation refused' USING ERRCODE='PCV09'; END IF;
  ELSE RAISE EXCEPTION 'unsupported command transition' USING ERRCODE='PCV02'; END IF;
  PERFORM charge_reward_funding_work_v2(c.account_id,c.pool_leg_id,c.profile_id,1);
  UPDATE reward_funding_work_envelopes_v2 SET used=used+1 WHERE scope='instruction' AND scope_key=c.contribution_id AND allocated-used-reserved>=1;
  IF NOT FOUND THEN RAISE EXCEPTION 'instruction work exhausted' USING ERRCODE='PCV04'; END IF;
  UPDATE song_megapot_contributions_v2 SET state=s WHERE contribution_id=c.contribution_id;
  PERFORM insert_song_contribution_command_v2(i,r);
END $$;

CREATE FUNCTION enqueue_song_contribution_reconciliation_v2(i JSONB,r JSONB,h JSONB) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE c song_megapot_contributions_v2; p reward_funding_profiles_v2; work_id TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('funding-account-v2',i->>'accountId')::text,0));
  SELECT * INTO STRICT c FROM song_megapot_contributions_v2 WHERE contribution_id=i->>'contributionId' AND account_id=i->>'accountId' AND community_id=i->>'communityId' AND post_id=i->>'postId' FOR UPDATE;
  SELECT * INTO STRICT p FROM reward_funding_profiles_v2 WHERE profile_id=c.profile_id;
  IF r->>'object'='contribution_recovery_command_receipt' THEN
    IF (jsonb_typeof(r->'work_item_id')='string' AND length(r->>'work_item_id') BETWEEN 1 AND 128) IS NOT TRUE THEN
      RAISE EXCEPTION 'missing recovery work identity' USING ERRCODE='PCV07';
    END IF;
    work_id:=r->>'work_item_id';
  ELSIF r->>'object'='contribution_observation_command_receipt' THEN
    -- Observation receipts carry a locator, not a public work_item_id.
    work_id:='request:'||(r->>'command_id');
  ELSE RAISE EXCEPTION 'unsupported reconciliation receipt' USING ERRCODE='PCV07'; END IF;
  IF h<>'null'::JSONB AND h->>'instructionHash' IS DISTINCT FROM c.state->'receipt'->'instruction'->>'instruction_hash'
    AND NOT EXISTS(SELECT 1 FROM song_megapot_contribution_commands_v2 x WHERE x.contribution_id=c.contribution_id AND x.receipt->>'object'='contribution_cancellation_command_receipt' AND x.receipt->>'instruction_hash'=h->>'instructionHash') THEN RAISE EXCEPTION 'foreign instruction hint' USING ERRCODE='PCV11'; END IF;
  PERFORM charge_reward_funding_work_v2(c.account_id,c.pool_leg_id,c.profile_id,1);
  UPDATE reward_funding_work_envelopes_v2 SET used=used+1 WHERE scope='instruction' AND scope_key=c.contribution_id AND allocated-used-reserved>=1;
  IF NOT FOUND THEN RAISE EXCEPTION 'instruction work exhausted' USING ERRCODE='PCV04'; END IF;
  INSERT INTO reward_funding_work_envelopes_v2 VALUES(work_id,'reconciliation',r->>'command_id',p.profile_id,c.contribution_id,1,0,0,p.valid_until,jsonb_build_object('hint',h,'attempts',0));
  PERFORM insert_song_contribution_command_v2(i,r);
END $$;

CREATE FUNCTION load_song_contribution_recovery_v2(i JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE c song_megapot_contributions_v2; s reward_funding_leg_snapshots_v2; p reward_funding_profiles_v2;
  owned BOOLEAN; paused BOOLEAN; available BOOLEAN; w reward_funding_schedule_witnesses_v2;
  a megapot_deployment_attestations; current_ok BOOLEAN; instr JSONB; until_at TIMESTAMPTZ;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('funding-account-v2',i->>'accountId')::text,0));
  PERFORM 1 FROM reward_song_slots_v2 WHERE community_id=i->>'communityId' AND post_id=i->>'postId' FOR UPDATE;
  SELECT * INTO STRICT c FROM song_megapot_contributions_v2 WHERE contribution_id=i->>'contributionId' AND account_id=i->>'accountId' AND community_id=i->>'communityId' AND post_id=i->>'postId' FOR UPDATE;
  PERFORM lock_reward_wallet_nonce_sender_v2((c.state->'receipt'->'instruction'->>'chain_id')::BIGINT,c.state->'owner'->>'sender_address');
  SELECT * INTO STRICT s FROM reward_funding_leg_snapshots_v2 WHERE snapshot_id=c.snapshot_id;
  SELECT * INTO STRICT p FROM reward_funding_profiles_v2 WHERE profile_id=c.profile_id FOR SHARE;
  instr:=c.state->'receipt'->'instruction';
  PERFORM 1 FROM persona_wallet_assignments WHERE assignment_id=instr->>'wallet_assignment_id' FOR SHARE;
  PERFORM 1 FROM personas WHERE persona_id=c.state->'owner'->>'persona_id' AND account_id=c.account_id FOR SHARE;
  SELECT * INTO a FROM megapot_deployment_attestations WHERE attestation_id=instr->>'attestation_id' FOR SHARE;
  SELECT * INTO w FROM reward_funding_schedule_witnesses_v2 WHERE profile_id=c.profile_id
    AND schedule->>'kind' IN ('cancellation_recovery_v2','cancellation_recovery_unavailable_v2') AND schedule->>'contributionId'=c.contribution_id
    ORDER BY (schedule->>'observedAt')::TIMESTAMPTZ DESC,(schedule->>'kind'='cancellation_recovery_unavailable_v2') DESC,created_at DESC,witness_id DESC LIMIT 1;
  SELECT EXISTS(SELECT 1 FROM persona_wallet_assignments wa JOIN personas v USING(persona_id,account_id) JOIN persona_community_bindings b USING(persona_id,account_id)
    WHERE wa.assignment_id=c.state->'owner'->>'wallet_assignment_id' AND wa.account_id=c.account_id AND wa.persona_id=c.state->'owner'->>'persona_id' AND wa.address=c.state->'owner'->>'sender_address'
      AND wa.status='active' AND v.status='active' AND b.community_id=c.community_id) INTO owned;
  SELECT x.paused INTO paused FROM reward_operations_control x WHERE singleton FOR SHARE;
  SELECT count(*)=3 INTO available FROM reward_funding_work_envelopes_v2 WHERE profile_id=c.profile_id AND valid_until>clock_timestamp()
    AND (scope,scope_key) IN (('account',c.account_id),('leg',c.pool_leg_id),('global','funding')) AND reserved>=1;
  until_at:=least(p.valid_until,(p.recovery_policy->>'valid_until')::TIMESTAMPTZ);
  current_ok:=coalesce(owned AND paused IS FALSE AND p.accepted AND p.recovery_policy IS NOT NULL
    AND p.recovery_policy->>'attestation_contract_version'='megapot-v2-current-recovery-v1'
    AND (p.recovery_policy->>'valid_from')::TIMESTAMPTZ<=clock_timestamp() AND until_at>clock_timestamp()
    AND a.status='active' AND a.retired_at IS NULL AND a.chain_id=(instr->>'chain_id')::BIGINT
    AND a.usdc_address=instr->>'to_token' AND a.custody_address=instr->>'recipient_custody'
    AND NOT (c.state->>'nonceFinalized')::BOOLEAN AND w.schedule->>'kind'='cancellation_recovery_v2' AND w.valid_until>clock_timestamp()
    AND w.schedule->>'profileHash'=p.profile_hash AND w.schedule->>'policyHash'=p.recovery_policy->>'policy_hash'
    AND w.schedule->>'noncePolicyHash'=p.nonce_policy->>'hash'
    AND w.schedule->>'instructionHash'=instr->>'instruction_hash' AND w.schedule->>'attestationId'=a.attestation_id
    AND w.schedule->>'attestationHash'=instr->>'attestation_hash' AND w.schedule->>'walletAssignmentId'=instr->>'wallet_assignment_id'
    AND w.schedule->>'sender'=instr->>'from' AND w.schedule->>'confirmedNonce'=instr->>'nonce'
    AND (w.schedule->>'pendingNonce')::NUMERIC>=(instr->>'nonce')::NUMERIC
    AND (w.schedule->>'observedAt')::TIMESTAMPTZ<=clock_timestamp()
    AND (w.schedule->>'blockTimestamp')::TIMESTAMPTZ<=clock_timestamp()
    AND (w.schedule->>'blockTimestamp')::TIMESTAMPTZ+((p.nonce_policy->>'maxAgeMs')::NUMERIC*interval '1 millisecond')>clock_timestamp()
    AND (w.schedule->>'observedAt')::TIMESTAMPTZ+((p.nonce_policy->>'maxAgeMs')::NUMERIC*interval '1 millisecond')>clock_timestamp(),FALSE);
  RETURN s.recovery_authority || jsonb_build_object('policy',CASE WHEN current_ok THEN p.recovery_policy ELSE NULL END,
    'currentEvidence',CASE WHEN current_ok THEN w.schedule ELSE NULL END,
    'attestationId',instr->>'attestation_id','attestationHash',instr->>'attestation_hash',
    'attestationValidUntil',to_char(until_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'originalWalletStillOwned',owned,'boundedWorkAvailable',available,
    'currentSigningRefusal',CASE WHEN paused IS DISTINCT FROM FALSE THEN 'paused' WHEN NOT p.accepted OR p.valid_until<=clock_timestamp() THEN 'policy_unavailable' ELSE s.recovery_authority->>'currentSigningRefusal' END);
END $$;

CREATE FUNCTION require_song_funding_work_lease_v2(id TEXT,token TEXT) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE w reward_funding_work_envelopes_v2; c song_megapot_contributions_v2;
BEGIN
  SELECT * INTO STRICT w FROM reward_funding_work_envelopes_v2 WHERE work_id=id AND scope='reconciliation';
  SELECT * INTO STRICT c FROM song_megapot_contributions_v2 WHERE contribution_id=w.contribution_id;
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('funding-account-v2',c.account_id)::TEXT,0));
  PERFORM 1 FROM reward_song_slots_v2 WHERE community_id=c.community_id AND post_id=c.post_id FOR UPDATE;
  PERFORM lock_reward_wallet_nonce_sender_v2((c.state->'receipt'->'instruction'->>'chain_id')::BIGINT,c.state->'owner'->>'sender_address');
  SELECT * INTO STRICT w FROM reward_funding_work_envelopes_v2 WHERE work_id=id FOR UPDATE;
  IF w.payload->>'leaseToken' IS DISTINCT FROM token OR w.payload->>'status' IS DISTINCT FROM 'running'
    OR ((w.payload->>'leaseUntil')::TIMESTAMPTZ>clock_timestamp()) IS NOT TRUE THEN RAISE EXCEPTION 'work fenced' USING ERRCODE='PCV06'; END IF;
END $$;

-- Durable reconciliation work. No provider call is made by these functions.
-- A lease consumes finite existing paid work; expiry never restores used work,
-- a purpose grant, principal, capacity or a wallet nonce.
CREATE FUNCTION song_funding_work_packet_v2(w reward_funding_work_envelopes_v2) RETURNS JSONB
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('workId',(w).work_id,'token',(w).payload->>'leaseToken','payload',(w).payload,
    'identity',jsonb_build_object('accountId',c.account_id,'communityId',c.community_id,'postId',c.post_id,
      'contributionId',c.contribution_id,'operation',x.operation,'key',x.idempotency_key,'hash',x.request_hash),
    'state',project_song_contribution_state_v2(c.state),'profileId',p.profile_id,'profileHash',p.profile_hash,
    'validUntil',to_char(p.valid_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'policy',CASE WHEN a.status='active' AND a.retired_at IS NULL THEN p.recovery_policy ELSE NULL END,'noncePolicy',p.nonce_policy,'workPolicy',p.policy->'reconciliation',
    'attestationBlock',a.attestation_block_number::TEXT,'attestationBlockHash',a.attestation_block_hash,
    'deployment',jsonb_build_object('attestationId',a.attestation_id,'environment',a.environment,'chainId',a.chain_id,
      'jackpotAddress',a.jackpot_address,'ticketNftAddress',a.ticket_nft_address,'usdcAddress',a.usdc_address,
      'custodyAddress',a.custody_address,'referrerAddress',a.referrer_address,'jackpotCodeHash',a.jackpot_code_hash,
      'ticketNftCodeHash',a.ticket_nft_code_hash,'usdcCodeHash',a.usdc_code_hash))
    FROM song_megapot_contributions_v2 c JOIN reward_funding_profiles_v2 p USING(profile_id)
    JOIN song_megapot_contribution_commands_v2 x ON x.command_id=(w).scope_key
    JOIN megapot_deployment_attestations a ON a.attestation_id=c.state->'receipt'->'instruction'->>'attestation_id'
    WHERE c.contribution_id=(w).contribution_id
$$;
CREATE FUNCTION list_song_funding_work_v2(n INTEGER) RETURNS SETOF TEXT LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF (n BETWEEN 1 AND 1000) IS NOT TRUE THEN RAISE EXCEPTION 'bounded work limit required' USING ERRCODE='PCV07'; END IF;
  RETURN QUERY SELECT w.work_id FROM reward_funding_work_envelopes_v2 w JOIN reward_funding_profiles_v2 p USING(profile_id)
    WHERE w.scope='reconciliation' AND p.accepted AND p.valid_until>clock_timestamp() AND p.policy->'reconciliation' IS NOT NULL
    AND coalesce(w.payload->>'status','pending') NOT IN ('complete','exhausted')
    AND (w.payload->>'leaseUntil' IS NULL OR (w.payload->>'leaseUntil')::TIMESTAMPTZ<=clock_timestamp())
    ORDER BY w.work_id LIMIT n;
END $$;
CREATE FUNCTION claim_song_funding_work_v2(id TEXT,token TEXT) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE w reward_funding_work_envelopes_v2; c song_megapot_contributions_v2; p reward_funding_profiles_v2; k JSONB; attempts BIGINT; field TEXT; value JSONB;
BEGIN
  IF (length(token) BETWEEN 1 AND 128) IS NOT TRUE THEN RAISE EXCEPTION 'work token required' USING ERRCODE='PCV07'; END IF;
  SELECT * INTO w FROM reward_funding_work_envelopes_v2 WHERE work_id=id AND scope='reconciliation';
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO STRICT c FROM song_megapot_contributions_v2 WHERE contribution_id=w.contribution_id;
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('funding-account-v2',c.account_id)::TEXT,0));
  PERFORM 1 FROM reward_song_slots_v2 WHERE community_id=c.community_id AND post_id=c.post_id FOR UPDATE;
  PERFORM lock_reward_wallet_nonce_sender_v2((c.state->'receipt'->'instruction'->>'chain_id')::BIGINT,c.state->'owner'->>'sender_address');
  SELECT * INTO STRICT p FROM reward_funding_profiles_v2 WHERE profile_id=c.profile_id FOR SHARE;
  SELECT * INTO STRICT w FROM reward_funding_work_envelopes_v2 WHERE work_id=id FOR UPDATE;
  PERFORM require_reward_run_authority_v1();
  IF (SELECT paused FROM reward_operations_control WHERE singleton FOR SHARE) IS DISTINCT FROM FALSE THEN RAISE EXCEPTION 'paused' USING ERRCODE='PR001'; END IF;
  k:=p.policy->'reconciliation';
  IF jsonb_typeof(k) IS DISTINCT FROM 'object' OR jsonb_typeof(k->'receipt') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'work policy unavailable' USING ERRCODE='PCV05'; END IF;
  FOREACH field IN ARRAY ARRAY['maxAttempts','leaseMs','maximumBlocks','maximumLogs','requiredConfirmations','maximumObservationAgeMs','maximumClockSkewMs'] LOOP
    value:=CASE WHEN field IN ('requiredConfirmations','maximumObservationAgeMs','maximumClockSkewMs') THEN k->'receipt'->field ELSE k->field END;
    IF jsonb_typeof(value) IS DISTINCT FROM 'number' OR (value::TEXT ~ '^(0|[1-9][0-9]{0,15})$') IS NOT TRUE THEN RAISE EXCEPTION 'work policy representation unavailable' USING ERRCODE='PCV05'; END IF;
    IF (value::TEXT)::NUMERIC>9007199254740991 OR (field<>'maximumClockSkewMs' AND (value::TEXT)::NUMERIC<=0) THEN RAISE EXCEPTION 'work policy bound unavailable' USING ERRCODE='PCV05'; END IF;
  END LOOP;
  IF (jsonb_typeof(k->'receipt'->'policyHash')='string' AND k->'receipt'->>'policyHash' ~ '^[a-f0-9]{64}$') IS NOT TRUE THEN RAISE EXCEPTION 'receipt policy unavailable' USING ERRCODE='PCV05'; END IF;
  IF NOT p.accepted OR p.valid_until<=clock_timestamp() OR k IS NULL OR
    ((k->>'maxAttempts')::BIGINT>0 AND (k->>'leaseMs')::BIGINT>0 AND (k->>'maximumBlocks')::BIGINT>0 AND (k->>'maximumLogs')::BIGINT>0) IS NOT TRUE THEN RAISE EXCEPTION 'work policy unavailable' USING ERRCODE='PCV05'; END IF;
  IF w.payload->>'status' IN ('complete','exhausted') OR (w.payload->>'leaseUntil')::TIMESTAMPTZ>clock_timestamp() THEN RETURN NULL; END IF;
  attempts:=coalesce((w.payload->>'attempts')::BIGINT,0);
  IF attempts>=(k->>'maxAttempts')::BIGINT THEN
    UPDATE reward_funding_work_envelopes_v2 SET payload=payload||jsonb_build_object('status','exhausted') WHERE work_id=id;
    RETURN NULL;
  END IF;
  IF attempts>0 THEN
    PERFORM charge_reward_funding_work_v2(c.account_id,c.pool_leg_id,c.profile_id,1);
    UPDATE reward_funding_work_envelopes_v2 SET used=used+1 WHERE scope='instruction' AND scope_key=c.contribution_id AND allocated-used-reserved>=1;
    IF NOT FOUND THEN RAISE EXCEPTION 'instruction work exhausted' USING ERRCODE='PCV04'; END IF;
  END IF;
  UPDATE reward_funding_work_envelopes_v2 SET used=used+1,allocated=allocated+CASE WHEN attempts>0 THEN 1 ELSE 0 END,
    payload=coalesce(payload,'{}')||jsonb_build_object('attempts',attempts+1,'status','running','leaseToken',token,
      'leaseUntil',to_char(least(clock_timestamp()+((k->>'leaseMs')::NUMERIC*interval '1 millisecond'),p.valid_until) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE work_id=id RETURNING * INTO w;
  RETURN song_funding_work_packet_v2(w);
END $$;
CREATE FUNCTION record_song_recovery_evidence_v2(id TEXT,token TEXT,e JSONB) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE c song_megapot_contributions_v2; p reward_funding_profiles_v2; a megapot_deployment_attestations; w reward_funding_work_envelopes_v2; i JSONB; original reward_funding_schedule_witnesses_v2;
BEGIN
  SELECT * INTO STRICT w FROM reward_funding_work_envelopes_v2 WHERE work_id=id AND scope='reconciliation';
  SELECT * INTO STRICT c FROM song_megapot_contributions_v2 WHERE contribution_id=w.contribution_id;
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('funding-account-v2',c.account_id)::TEXT,0));
  PERFORM 1 FROM reward_song_slots_v2 WHERE community_id=c.community_id AND post_id=c.post_id FOR UPDATE;
  SELECT * INTO STRICT c FROM song_megapot_contributions_v2 WHERE contribution_id=c.contribution_id FOR UPDATE;
  i:=c.state->'receipt'->'instruction';
  PERFORM lock_reward_wallet_nonce_sender_v2((i->>'chain_id')::BIGINT,i->>'from');
  SELECT * INTO STRICT p FROM reward_funding_profiles_v2 WHERE profile_id=c.profile_id FOR SHARE;
  SELECT * INTO STRICT a FROM megapot_deployment_attestations WHERE attestation_id=i->>'attestation_id' FOR SHARE;
  SELECT * INTO STRICT w FROM reward_funding_work_envelopes_v2 WHERE work_id=id FOR UPDATE;
  IF w.payload->>'leaseToken' IS DISTINCT FROM token OR w.payload->>'status' IS DISTINCT FROM 'running'
    OR ((w.payload->>'leaseUntil')::TIMESTAMPTZ>clock_timestamp()) IS NOT TRUE THEN RAISE EXCEPTION 'work fenced' USING ERRCODE='PCV06'; END IF;
  IF (e->>'stateRevision')::BIGINT IS DISTINCT FROM (c.state->>'revision')::BIGINT THEN RAISE EXCEPTION 'recovery source revision changed' USING ERRCODE='PCV06'; END IF;
  PERFORM require_reward_run_authority_v1();
  IF (SELECT paused FROM reward_operations_control WHERE singleton FOR SHARE) IS DISTINCT FROM FALSE THEN RAISE EXCEPTION 'paused' USING ERRCODE='PR001'; END IF;
  IF (p.accepted AND p.valid_until>clock_timestamp() AND a.status='active' AND a.retired_at IS NULL
    AND (p.recovery_policy->>'valid_from')::TIMESTAMPTZ<=clock_timestamp()
    AND p.recovery_policy->>'attestation_contract_version'='megapot-v2-current-recovery-v1'
    AND NOT (c.state->>'nonceFinalized')::BOOLEAN AND e->>'kind'='cancellation_recovery_v2'
    AND e->>'contributionId'=c.contribution_id AND e->>'profileId'=p.profile_id AND e->>'profileHash'=p.profile_hash
    AND e->>'policyHash'=p.recovery_policy->>'policy_hash' AND e->>'noncePolicyHash'=p.nonce_policy->>'hash'
    AND e->>'instructionHash'=i->>'instruction_hash' AND e->>'attestationId'=a.attestation_id AND e->>'attestationHash'=i->>'attestation_hash'
    AND e->>'walletAssignmentId'=i->>'wallet_assignment_id' AND e->>'sender'=i->>'from'
    AND (e->>'chainId')::BIGINT=a.chain_id AND e->>'token'=a.usdc_address AND e->>'custody'=a.custody_address
    AND a.chain_id=(i->>'chain_id')::BIGINT AND a.usdc_address=i->>'to_token' AND a.custody_address=i->>'recipient_custody'
    AND e->>'confirmedNonce'=i->>'nonce' AND (e->>'pendingNonce')::NUMERIC>=(i->>'nonce')::NUMERIC
    AND (e->>'observedAt')::TIMESTAMPTZ<=clock_timestamp() AND (e->>'validUntil')::TIMESTAMPTZ>clock_timestamp()
    AND (e->>'blockTimestamp')::TIMESTAMPTZ<=(e->>'observedAt')::TIMESTAMPTZ
    AND (e->>'observedAt')::TIMESTAMPTZ-(e->>'blockTimestamp')::TIMESTAMPTZ<=((p.nonce_policy->>'maxAgeMs')::NUMERIC*interval '1 millisecond')
    AND (e->>'validUntil')::TIMESTAMPTZ<=least(p.valid_until,(p.recovery_policy->>'valid_until')::TIMESTAMPTZ,(e->>'observedAt')::TIMESTAMPTZ+((p.nonce_policy->>'maxAgeMs')::NUMERIC*interval '1 millisecond'),(e->>'blockTimestamp')::TIMESTAMPTZ+((p.nonce_policy->>'maxAgeMs')::NUMERIC*interval '1 millisecond'))
    AND e->>'witnessHash' ~ '^[a-f0-9]{64}$') IS NOT TRUE THEN RAISE EXCEPTION 'recovery evidence unavailable' USING ERRCODE='PCV12'; END IF;
  PERFORM 1 FROM persona_wallet_assignments WHERE assignment_id=i->>'wallet_assignment_id' AND status='active' AND address=i->>'from' AND account_id=c.account_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'wallet retired' USING ERRCODE='PCV12'; END IF;
  SELECT * INTO original FROM reward_funding_schedule_witnesses_v2 WHERE witness_id='recovery:'||(e->>'witnessHash');
  IF FOUND THEN
    IF original.schedule IS DISTINCT FROM e THEN RAISE EXCEPTION 'recovery witness conflict' USING ERRCODE='PCV03'; END IF;
    RETURN;
  END IF;
  INSERT INTO reward_funding_schedule_witnesses_v2(witness_id,profile_id,witness_hash,schedule,nonce_witness,valid_until)
    VALUES('recovery:'||(e->>'witnessHash'),p.profile_id,e->>'witnessHash',e,'{}',(e->>'validUntil')::TIMESTAMPTZ);
END $$;
CREATE FUNCTION finish_song_funding_work_v2(id TEXT,token TEXT,result JSONB) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE reward_funding_work_envelopes_v2 SET payload=payload||jsonb_build_object('status',CASE WHEN result->>'complete'='true' THEN 'complete' ELSE 'unknown' END,'result',result,'leaseUntil',NULL)
    WHERE work_id=id AND scope='reconciliation' AND payload->>'leaseToken'=token AND payload->>'status'='running'
      AND (payload->>'leaseUntil')::TIMESTAMPTZ>clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'work fenced' USING ERRCODE='PCV06'; END IF;
END $$;

-- Negative observations supersede old evidence without disposing any liability.
CREATE FUNCTION invalidate_song_recovery_evidence_v2(id TEXT,token TEXT,reason TEXT) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE w reward_funding_work_envelopes_v2; hash TEXT;
BEGIN
  PERFORM require_song_funding_work_lease_v2(id,token);
  SELECT * INTO STRICT w FROM reward_funding_work_envelopes_v2 WHERE work_id=id;
  IF (reason IN ('cancellation_recovery_unavailable','attestation_unavailable','outcome_unknown','lifecycle_changed','paused')) IS NOT TRUE THEN RAISE EXCEPTION 'invalid evidence refusal' USING ERRCODE='PCV07'; END IF;
  hash:=encode(sha256(convert_to(jsonb_build_array(id,token,reason)::TEXT,'UTF8')),'hex');
  INSERT INTO reward_funding_schedule_witnesses_v2(witness_id,profile_id,witness_hash,schedule,nonce_witness,valid_until)
    VALUES('recovery-unavailable:'||hash,w.profile_id,hash,jsonb_build_object('kind','cancellation_recovery_unavailable_v2','contributionId',w.contribution_id,'reason',reason,'observedAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),'{}',clock_timestamp())
    ON CONFLICT(witness_id) DO NOTHING;
END $$;

-- Until277 and parent role binding, ALL new objects are migration-owner only,
-- including inherited/default ACLs. No runtime role is inferred from its name.
DO $acl$
DECLARE x RECORD; r RECORD; trusted TEXT:=current_schema();
BEGIN
  FOR x IN SELECT c.oid,c.relname,c.relowner FROM pg_class c WHERE c.relnamespace=to_regnamespace(trusted)
    AND c.relname IN ('reward_funding_profiles_v2','reward_funding_schedule_witnesses_v2','reward_song_slots_v2','reward_funding_leg_snapshots_v2','song_megapot_contributions_v2','song_megapot_contribution_commands_v2','reward_funding_submission_claims_v2','reward_contribution_reservations_v2','reward_funding_account_counters_v2','reward_funding_work_envelopes_v2','reward_funding_scan_checkpoints_v2','reward_incoming_receipts_v2') LOOP
    EXECUTE format('REVOKE ALL ON %I.%I FROM PUBLIC CASCADE',trusted,x.relname);
    FOR r IN SELECT DISTINCT pg_get_userbyid(a.grantee) AS name FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=x.oid AND a.grantee<>0 AND a.grantee<>x.relowner LOOP
      EXECUTE format('REVOKE ALL ON %I.%I FROM %I CASCADE',trusted,x.relname,r.name);
    END LOOP;
  END LOOP;
  FOR x IN SELECT oid,proname,proowner,oid::regprocedure AS sig FROM pg_proc WHERE pronamespace=to_regnamespace(trusted) AND proname IN ('invalidate_song_recovery_evidence_v2','require_song_funding_work_lease_v2','song_funding_work_packet_v2','list_song_funding_work_v2','claim_song_funding_work_v2','record_song_recovery_evidence_v2','finish_song_funding_work_v2','reject_reward_contribution_history_v2','guard_reward_funding_scan_checkpoint_v2','guard_reward_song_slot_v2','load_song_contribution_command_v2','load_owned_song_contribution_v2','project_song_contribution_state_v2','lock_song_contribution_context_v2','insert_song_contribution_command_v2','charge_reward_funding_work_v2','assert_reward_contribution_capacity_v2','create_song_contribution_v2','update_song_contribution_command_v2','enqueue_song_contribution_reconciliation_v2','load_song_contribution_recovery_v2') LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog,%I,pg_temp',x.sig,trusted);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC CASCADE',x.sig);
    FOR r IN SELECT DISTINCT pg_get_userbyid(a.grantee) AS name FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=x.oid AND a.grantee<>0 AND a.grantee<>x.proowner LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I CASCADE',x.sig,r.name); END LOOP;
  END LOOP;
END $acl$;
