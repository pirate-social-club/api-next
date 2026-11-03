-- Owned browser persistence. Secrets and access tokens are never stored here.
CREATE TABLE browser_sessions (
  session_id TEXT PRIMARY KEY CHECK (session_id ~ '^bs_[a-f0-9]{32}$'),
  account_id TEXT NOT NULL REFERENCES users(user_id),
  credential_id TEXT NOT NULL REFERENCES identity_credentials(credential_id),
  credential_user_id TEXT NOT NULL,
  provider_app_id TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (btrim(scope)<>'' AND scope=btrim(scope)),
  browser_origin TEXT NOT NULL CHECK (browser_origin ~ '^https://[^/[:space:]?#@]+$'),
  renewable BOOLEAN NOT NULL,
  renewal_secret_hash TEXT,
  csrf_hash TEXT NOT NULL CHECK (csrf_hash ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL,
  idle_expires_at TIMESTAMPTZ NOT NULL,
  absolute_expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  CHECK ((renewable AND renewal_secret_hash IS NOT NULL AND renewal_secret_hash ~ '^[a-f0-9]{64}$') OR
    (NOT renewable AND renewal_secret_hash IS NULL)),
  CHECK (created_at<idle_expires_at AND idle_expires_at<=absolute_expires_at),
  CHECK (absolute_expires_at<=created_at+interval '90 days'),
  CHECK (renewable OR (scope='persona-wallet-setup-v1' AND
    absolute_expires_at<=created_at+interval '1 hour'))
);
CREATE INDEX browser_sessions_account_idx ON browser_sessions(account_id);
CREATE INDEX browser_sessions_expiry_idx ON browser_sessions(absolute_expires_at);

CREATE FUNCTION guard_browser_session_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.session_id,NEW.account_id,NEW.credential_id,NEW.credential_user_id,
      NEW.provider_app_id,NEW.provider_subject,NEW.scope,NEW.browser_origin,
      NEW.renewable,NEW.renewal_secret_hash,NEW.csrf_hash,NEW.created_at,NEW.absolute_expires_at)
    IS DISTINCT FROM ROW(OLD.session_id,OLD.account_id,OLD.credential_id,OLD.credential_user_id,
      OLD.provider_app_id,OLD.provider_subject,OLD.scope,OLD.browser_origin,
      OLD.renewable,OLD.renewal_secret_hash,OLD.csrf_hash,OLD.created_at,OLD.absolute_expires_at)
    OR NEW.idle_expires_at<OLD.idle_expires_at
    OR (OLD.revoked_at IS NOT NULL AND
      ROW(NEW.idle_expires_at,NEW.revoked_at) IS DISTINCT FROM ROW(OLD.idle_expires_at,OLD.revoked_at))
  THEN RAISE EXCEPTION 'browser session binding is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER browser_session_binding BEFORE UPDATE ON browser_sessions
  FOR EACH ROW EXECUTE FUNCTION guard_browser_session_v1();

CREATE FUNCTION browser_session_packet_v1(s browser_sessions) RETURNS JSONB
LANGUAGE sql VOLATILE AS $$
 SELECT jsonb_build_object('sessionId',(s).session_id,'accountId',(s).account_id,
  'credentialUserId',(s).credential_user_id,'scope',(s).scope,'origin',(s).browser_origin,
  'renewable',(s).renewable,'idleExpiresAt',floor(extract(epoch FROM (s).idle_expires_at)),
  'absoluteExpiresAt',floor(extract(epoch FROM (s).absolute_expires_at)),
  'now',floor(extract(epoch FROM clock_timestamp())))
$$;

-- The existing canonical resolver's directed active-edge semantics and 8-hop
-- bound. Callers that mutate authority stabilize absent edges before calling.
CREATE FUNCTION browser_session_account_matches_v1(source_id TEXT,expected_id TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE AS $$
DECLARE cursor_id TEXT:=source_id; next_id TEXT; visited TEXT[]:=ARRAY[]::TEXT[]; depth INTEGER;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM users WHERE user_id=source_id AND status='active') THEN RETURN FALSE; END IF;
  FOR depth IN 0..8 LOOP
    IF cursor_id=ANY(visited) THEN RETURN FALSE; END IF;
    visited:=array_append(visited,cursor_id);
    SELECT canonical_user_id INTO next_id FROM account_aliases
      WHERE source_user_id=cursor_id AND ((kind='alias' AND status='active') OR
        (kind='merge' AND status IN ('finalizing','completed')));
    IF NOT FOUND THEN
      RETURN cursor_id=expected_id AND EXISTS(SELECT 1 FROM users WHERE user_id=cursor_id AND status='active');
    END IF;
    IF depth=8 OR next_id IS NULL OR btrim(next_id)='' OR next_id<>btrim(next_id) THEN RETURN FALSE; END IF;
    cursor_id:=next_id;
  END LOOP;
  RETURN FALSE;
END $$;

CREATE FUNCTION create_browser_session_v1(p JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE c identity_credentials; s browser_sessions; prior browser_sessions;
  observed TIMESTAMPTZ; access_seconds INTEGER; replacement JSONB;
BEGIN
  IF jsonb_typeof(p->'renewable') IS DISTINCT FROM 'boolean' OR
    jsonb_typeof(p->'accessSeconds') IS DISTINCT FROM 'number' OR
    ((p->>'accessSeconds') ~ '^[0-9]{1,4}$') IS NOT TRUE
  THEN RAISE EXCEPTION 'invalid browser session' USING ERRCODE='22023'; END IF;
  access_seconds:=(p->>'accessSeconds')::INTEGER;
  IF access_seconds<1 OR access_seconds>3600 OR
    ((p->>'scope'='persona-wallet-setup-v1')=(NOT (p->>'renewable')::BOOLEAN)) IS NOT TRUE
  THEN RAISE EXCEPTION 'invalid browser session authority' USING ERRCODE='22023'; END IF;
  -- SHARE stabilizes absent aliases and status changes, matching the existing
  -- identity-topology protocols. Order is alias table, session, credential/user.
  LOCK TABLE account_aliases IN SHARE MODE;
  replacement:=p->'replacement';
  IF replacement IS NOT NULL AND replacement<>'null'::jsonb THEN
    SELECT * INTO prior FROM browser_sessions WHERE session_id=replacement->>'sessionId' FOR UPDATE;
    IF NOT FOUND OR prior.csrf_hash IS DISTINCT FROM replacement->>'csrfHash'
      OR prior.browser_origin IS DISTINCT FROM replacement->>'origin'
      OR prior.browser_origin IS DISTINCT FROM p->>'origin'
      OR (CASE WHEN replacement->>'secretHash' IS NOT NULL
        THEN prior.renewal_secret_hash IS DISTINCT FROM replacement->>'secretHash'
        ELSE replacement->>'accountId' IS NULL OR prior.account_id IS DISTINCT FROM replacement->>'accountId' END)
    THEN RAISE EXCEPTION 'browser replacement unavailable' USING ERRCODE='28000'; END IF;
    IF prior.revoked_at IS NULL THEN
      UPDATE browser_sessions SET revoked_at=clock_timestamp() WHERE session_id=prior.session_id;
    END IF;
  END IF;
  SELECT * INTO c FROM identity_credentials
    WHERE provider='privy' AND provider_app_id=p->>'providerAppId'
      AND provider_subject=p->>'providerSubject' AND status='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'browser credential unavailable' USING ERRCODE='28000'; END IF;
  PERFORM 1 FROM users WHERE user_id IN(c.canonical_user_id,p->>'accountId') ORDER BY user_id FOR SHARE;
  IF NOT browser_session_account_matches_v1(c.canonical_user_id,p->>'accountId')
  THEN RAISE EXCEPTION 'browser account unavailable' USING ERRCODE='28000'; END IF;
  observed:=clock_timestamp();
  IF jsonb_typeof(p->'proofExpiresAt') IS DISTINCT FROM 'number'
    OR (p->>'proofExpiresAt' ~ '^[0-9]{1,15}$') IS NOT TRUE
    OR observed>=to_timestamp((p->>'proofExpiresAt')::DOUBLE PRECISION)
  THEN RAISE EXCEPTION 'browser proof expired' USING ERRCODE='28000'; END IF;
  INSERT INTO browser_sessions(session_id,account_id,credential_id,credential_user_id,
    provider_app_id,provider_subject,scope,browser_origin,renewable,renewal_secret_hash,
    csrf_hash,created_at,idle_expires_at,absolute_expires_at)
  VALUES(p->>'sessionId',p->>'accountId',c.credential_id,c.canonical_user_id,
    c.provider_app_id,c.provider_subject,p->>'scope',p->>'origin',(p->>'renewable')::BOOLEAN,
    p->>'secretHash',p->>'csrfHash',observed,
    observed+CASE WHEN (p->>'renewable')::BOOLEAN THEN interval '30 days'
      ELSE least(access_seconds*interval '1 second',to_timestamp((p->>'proofExpiresAt')::DOUBLE PRECISION)-observed) END,
    observed+CASE WHEN (p->>'renewable')::BOOLEAN THEN interval '90 days'
      ELSE least(access_seconds*interval '1 second',to_timestamp((p->>'proofExpiresAt')::DOUBLE PRECISION)-observed) END)
  RETURNING * INTO s;
  RETURN browser_session_packet_v1(s);
END $$;

CREATE FUNCTION read_browser_session_access_v1(id TEXT,account TEXT,required_scope TEXT)
RETURNS JSONB LANGUAGE sql SECURITY DEFINER VOLATILE AS $$
 SELECT browser_session_packet_v1(s) FROM browser_sessions s
 JOIN users u ON u.user_id=s.account_id AND u.status='active'
 JOIN identity_credentials c ON c.credential_id=s.credential_id AND c.status='active'
  AND c.canonical_user_id=s.credential_user_id AND c.provider_app_id=s.provider_app_id
  AND c.provider_subject=s.provider_subject AND c.provider='privy'
 WHERE s.session_id=$1 AND s.account_id=$2 AND s.scope=$3
  AND s.revoked_at IS NULL AND s.idle_expires_at>clock_timestamp()
  AND s.absolute_expires_at>clock_timestamp()
  AND browser_session_account_matches_v1(s.credential_user_id,s.account_id)
$$;

CREATE FUNCTION read_browser_session_renewal_v1(id TEXT,secret_hash TEXT,csrf TEXT,origin TEXT)
RETURNS JSONB LANGUAGE sql SECURITY DEFINER VOLATILE AS $$
 SELECT browser_session_packet_v1(s) FROM browser_sessions s
 JOIN users u ON u.user_id=s.account_id AND u.status='active'
 JOIN identity_credentials c ON c.credential_id=s.credential_id AND c.status='active'
  AND c.canonical_user_id=s.credential_user_id AND c.provider_app_id=s.provider_app_id
  AND c.provider_subject=s.provider_subject AND c.provider='privy'
 WHERE s.session_id=$1 AND s.renewal_secret_hash=$2 AND s.csrf_hash=$3
  AND s.browser_origin=$4 AND s.renewable AND s.scope<>'persona-wallet-setup-v1'
  AND s.revoked_at IS NULL AND s.idle_expires_at>clock_timestamp()
  AND s.absolute_expires_at>clock_timestamp()
  AND browser_session_account_matches_v1(s.credential_user_id,s.account_id)
$$;

CREATE FUNCTION renew_browser_session_v1(id TEXT,secret_hash TEXT,csrf TEXT,origin TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE s browser_sessions; observed TIMESTAMPTZ;
BEGIN
  LOCK TABLE account_aliases IN SHARE MODE;
  SELECT * INTO s FROM browser_sessions WHERE session_id=id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  -- Time is sampled after the lock wait; expired or revoked authority never rolls.
  observed:=clock_timestamp();
  IF NOT s.renewable OR s.scope='persona-wallet-setup-v1' OR s.revoked_at IS NOT NULL
    OR s.renewal_secret_hash IS DISTINCT FROM secret_hash OR s.csrf_hash IS DISTINCT FROM csrf
    OR s.browser_origin IS DISTINCT FROM origin OR s.idle_expires_at<=observed
    OR s.absolute_expires_at<=observed THEN RETURN NULL; END IF;
  PERFORM 1 FROM identity_credentials c JOIN users u ON u.user_id=s.account_id AND u.status='active'
    WHERE c.credential_id=s.credential_id AND c.status='active' AND c.provider='privy'
      AND c.canonical_user_id=s.credential_user_id AND c.provider_app_id=s.provider_app_id
      AND c.provider_subject=s.provider_subject FOR SHARE OF c,u;
  IF NOT FOUND THEN RETURN NULL; END IF;
  observed:=clock_timestamp();
  IF s.idle_expires_at<=observed OR s.absolute_expires_at<=observed
    OR NOT browser_session_account_matches_v1(s.credential_user_id,s.account_id) THEN RETURN NULL; END IF;
  UPDATE browser_sessions SET idle_expires_at=greatest(idle_expires_at,
    least(observed+interval '30 days',absolute_expires_at)) WHERE session_id=id RETURNING * INTO s;
  RETURN browser_session_packet_v1(s);
END $$;

CREATE FUNCTION revoke_browser_session_v1(id TEXT,secret_hash TEXT,account TEXT,csrf TEXT,origin TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE s browser_sessions;
BEGIN
  SELECT * INTO s FROM browser_sessions WHERE session_id=id FOR UPDATE;
  IF NOT FOUND OR s.csrf_hash IS DISTINCT FROM csrf OR s.browser_origin IS DISTINCT FROM origin
    OR (CASE WHEN secret_hash IS NOT NULL THEN s.renewal_secret_hash IS DISTINCT FROM secret_hash
      ELSE account IS NULL OR s.account_id IS DISTINCT FROM account END)
  THEN RETURN FALSE; END IF;
  IF s.revoked_at IS NULL THEN
    UPDATE browser_sessions SET revoked_at=clock_timestamp() WHERE session_id=id;
  END IF;
  RETURN TRUE;
END $$;

-- Harden hostile defaults; runtime capabilities are granted separately and narrowly.
DO $$
DECLARE trusted TEXT:=current_schema(); t REGCLASS:='browser_sessions'::REGCLASS;
  grant_row RECORD; f RECORD;
BEGIN
  EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC',t);
  FOR grant_row IN SELECT DISTINCT a.grantee FROM pg_class c,
    LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    WHERE c.oid=t AND a.grantee<>0 AND a.grantee<>c.relowner
  LOOP EXECUTE format('REVOKE ALL ON TABLE %s FROM %I',t,pg_get_userbyid(grant_row.grantee)); END LOOP;
  FOR f IN SELECT p.oid,p.proowner,p.oid::regprocedure AS name FROM pg_proc p
    WHERE p.pronamespace=to_regnamespace(trusted) AND p.proname IN (
      'guard_browser_session_v1','browser_session_packet_v1','browser_session_account_matches_v1','create_browser_session_v1',
      'read_browser_session_access_v1','read_browser_session_renewal_v1',
      'renew_browser_session_v1','revoke_browser_session_v1')
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path=pg_catalog,%I,pg_temp',f.name,trusted);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.name);
    FOR grant_row IN SELECT DISTINCT a.grantee FROM pg_proc p,
      LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE p.oid=f.oid AND a.grantee<>0 AND a.grantee<>p.proowner
    LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f.name,pg_get_userbyid(grant_row.grantee)); END LOOP;
  END LOOP;
END $$;
