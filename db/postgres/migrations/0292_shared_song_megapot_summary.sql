-- Read-only, funder-anonymous song-wide display. Personal funding context and
-- command guards remain authoritative; this summary never authorizes payment.
CREATE FUNCTION read_shared_song_megapot_summary_v2(p_account TEXT,p_community TEXT,p_post TEXT) RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE slot reward_song_slots_v2; leg song_reward_offer_legs; offer song_reward_offers; funded NUMERIC;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM users WHERE user_id=p_account AND status='active') OR NOT can_account_access_activity_song(p_account,p_community,p_post) THEN RAISE EXCEPTION 'song unavailable' USING ERRCODE='PCV02'; END IF;
 SELECT * INTO slot FROM reward_song_slots_v2 WHERE community_id=p_community AND post_id=p_post;
 IF slot.slot_id IS NULL OR slot.target IS NULL OR slot.target->>'kind'<>'committed' THEN RETURN NULL; END IF;
 SELECT * INTO leg FROM song_reward_offer_legs WHERE leg_id=slot.target->>'pool_leg_id' AND qualification_family_v2='shared_song';
 SELECT * INTO offer FROM song_reward_offers WHERE offer_id=leg.offer_id;
 IF leg.leg_id IS NULL OR leg.shared_song_terms_v2 IS DISTINCT FROM slot.terms OR offer.community_id<>p_community OR offer.post_id<>p_post THEN RAISE EXCEPTION 'shared pot provenance unavailable' USING ERRCODE='PCV05'; END IF;
 SELECT coalesce(sum(receipt.amount_atomic),0) INTO funded FROM reward_incoming_receipts_v2 receipt JOIN song_megapot_contributions_v2 contribution USING(contribution_id) WHERE contribution.pool_leg_id=leg.leg_id AND receipt.category='pool_principal';
 RETURN jsonb_build_object('object','shared_song_megapot_summary','version',2,'target',slot.target,'terms_hash',slot.terms->>'terms_hash','ends_at',slot.terms->>'ends_at','confirmed_pool_atomic',funded::TEXT,
 'availability',CASE WHEN offer.status='active' AND leg.status IN('funding','active') AND clock_timestamp()<offer.ends_at AND (SELECT paused FROM reward_operations_control WHERE singleton) IS FALSE THEN 'ready' ELSE 'unavailable' END,
 'activities',jsonb_build_array('study','karaoke','dance'));
END $$;
DO $acl$
DECLARE f RECORD;r RECORD;trusted TEXT:=current_schema();
BEGIN
 FOR f IN SELECT p.oid,p.proowner,p.oid::regprocedure signature FROM pg_proc p WHERE p.pronamespace=trusted::regnamespace AND p.proname='read_shared_song_megapot_summary_v2' LOOP
  EXECUTE format('ALTER FUNCTION %s SET search_path=%I,pg_catalog,pg_temp',f.signature,trusted);EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC CASCADE',f.signature);
  FOR r IN SELECT DISTINCT pg_get_userbyid(a.grantee) name FROM aclexplode(coalesce((SELECT proacl FROM pg_proc WHERE oid=f.oid),acldefault('f',f.proowner))) a WHERE a.grantee NOT IN(0,f.proowner) LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I CASCADE',f.signature,r.name); END LOOP;
 END LOOP;
END $acl$;
