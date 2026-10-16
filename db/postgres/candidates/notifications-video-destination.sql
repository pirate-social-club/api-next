-- UNAPPLIED CANDIDATE. No ordinal reserved. Requires Notifications predecessor,
-- actual latest-base intake, independent migration/ACL review and parent execution.
-- Does NOT enable video notification delivery; that requires the separate cutover.

CREATE FUNCTION video_publication_post_id_v1(p_submission TEXT,p_operation TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
 SELECT 'post-' || encode(sha256(
   convert_to('pirate/video-publication-post-id/v1','UTF8') || decode('00','hex') ||
   int4send(octet_length(convert_to(p_submission,'UTF8'))) || convert_to(p_submission,'UTF8') ||
   int4send(octet_length(convert_to(p_operation,'UTF8'))) || convert_to(p_operation,'UTF8')
 ),'hex')
$$;

CREATE FUNCTION video_detail_id_safe_v1(p_id TEXT) RETURNS BOOLEAN LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT p_id<>'' AND post_slug_utf16_code_units(p_id)<=512 AND p_id NOT IN('.','..')
   AND p_id!~'[[:space:][:cntrl:]]'
   AND strpos(p_id,'%')=0 AND strpos(p_id,'/')=0 AND strpos(p_id,E'\\')=0
   AND strpos(p_id,'?')=0 AND strpos(p_id,'#')=0
   AND NOT EXISTS(SELECT 1 FROM regexp_split_to_table(p_id,'') chars(character)
     WHERE ascii(character)<32 OR ascii(character) BETWEEN 127 AND 159 OR ascii(character)=65279)
$$;

CREATE FUNCTION require_video_publication_identity_v1(p_submission TEXT,p_operation TEXT,p_post TEXT)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE s media_post_submissions%ROWTYPE; p posts%ROWTYPE; expected TEXT;
BEGIN
 SELECT * INTO STRICT s FROM media_post_submissions WHERE submission_id=p_submission FOR UPDATE;
 IF s.media_kind<>'video' OR s.operation_id<>p_operation THEN
   RAISE EXCEPTION 'video publication source identity mismatch';
 END IF;
 expected := COALESCE(s.post_id,video_publication_post_id_v1(s.submission_id,s.operation_id));
 IF p_post IS DISTINCT FROM expected THEN RAISE EXCEPTION 'video publication identity mismatch'; END IF;
 SELECT * INTO p FROM posts WHERE post_id=p_post FOR SHARE;
 IF FOUND AND (p.community_id<>s.community_id OR p.post_type<>'video'
   OR p.idempotency_key IS DISTINCT FROM 'video-publication:'||s.operation_id
   OR (p.author_user_id IS DISTINCT FROM s.actor_user_id AND NOT(p.author_user_id IS NULL
     AND NOT EXISTS(SELECT 1 FROM users WHERE user_id=s.actor_user_id AND status='active')))) THEN
   RAISE EXCEPTION 'video publication Post identity collision';
 END IF;
 RETURN expected;
END $$;

CREATE FUNCTION guard_video_publication_identity_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.media_kind='video' THEN
   IF TG_OP='UPDATE' AND (NEW.submission_id IS DISTINCT FROM OLD.submission_id
     OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
     OR (OLD.post_id IS NOT NULL AND NEW.post_id IS DISTINCT FROM OLD.post_id)) THEN
     RAISE EXCEPTION 'video publication durable identity is immutable';
   END IF;
   IF NEW.post_id IS NOT NULL AND (TG_OP='INSERT' OR OLD.post_id IS NULL)
     AND NEW.post_id IS DISTINCT FROM video_publication_post_id_v1(NEW.submission_id,NEW.operation_id) THEN
     RAISE EXCEPTION 'unbound video publication must use its fixed identity';
   END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER media_video_fixed_publication_identity
 BEFORE INSERT OR UPDATE ON media_post_submissions FOR EACH ROW
 EXECUTE FUNCTION guard_video_publication_identity_v1();

CREATE FUNCTION guard_video_post_identity_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.post_type='video' AND EXISTS(SELECT 1 FROM media_post_submissions s WHERE s.media_kind='video'
   AND (s.post_id=OLD.post_id OR OLD.idempotency_key='video-publication:'||s.operation_id))
   AND ROW(NEW.post_id,NEW.community_id,NEW.post_type,NEW.idempotency_key)
   IS DISTINCT FROM ROW(OLD.post_id,OLD.community_id,OLD.post_type,OLD.idempotency_key) THEN
   RAISE EXCEPTION 'video Post publication identity is immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER video_post_publication_identity BEFORE UPDATE ON posts
 FOR EACH ROW EXECUTE FUNCTION guard_video_post_identity_v1();

ALTER TABLE post_slug_aliases DROP CONSTRAINT post_slug_aliases_policy_check;
ALTER TABLE post_slug_aliases ADD CONSTRAINT post_slug_aliases_policy_check
 CHECK (slug_policy_version IN ('post-slug-v1','video-receipt-exact-v1'));

CREATE FUNCTION guard_exact_video_alias_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.slug_policy_version='video-receipt-exact-v1' AND
   (NEW.slug<>NEW.post_id OR NOT video_detail_id_safe_v1(NEW.slug) OR NEW.slug<>normalize(NEW.slug,NFKC) OR NOT EXISTS (
      SELECT 1 FROM posts p JOIN media_post_submissions s
       ON s.community_id=p.community_id AND p.idempotency_key='video-publication:'||s.operation_id
      WHERE p.post_id=NEW.post_id AND p.post_type='video' AND s.media_kind='video'
       AND (s.post_id=p.post_id OR (s.post_id IS NULL
         AND video_publication_post_id_v1(s.submission_id,s.operation_id)=p.post_id))
       AND (p.author_user_id=s.actor_user_id OR (p.author_user_id IS NULL AND NOT EXISTS(
         SELECT 1 FROM users source_actor WHERE source_actor.user_id=s.actor_user_id AND source_actor.status='active')))
   )) THEN RAISE EXCEPTION 'exact video alias must bind its owned video identity'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER post_slug_aliases_exact_video_guard BEFORE INSERT ON post_slug_aliases
 FOR EACH ROW EXECUTE FUNCTION guard_exact_video_alias_v1();

-- Ordinary collision is data, not an allocator retry. Unknown transaction outcome
-- is reconciled by this exact operation and the durable audit, never another ID.
CREATE FUNCTION ensure_exact_video_receipt_alias_v1(p_submission TEXT,p_operation TEXT,p_post TEXT)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE existing_slug post_slug_aliases%ROWTYPE; existing_post post_slug_aliases%ROWTYPE; inserted BOOLEAN;
BEGIN
 PERFORM require_video_publication_identity_v1(p_submission,p_operation,p_post);
 IF NOT EXISTS(SELECT 1 FROM posts WHERE post_id=p_post AND post_type='video') THEN
   RAISE EXCEPTION 'owned video Post required before alias';
 END IF;
 IF NOT video_detail_id_safe_v1(p_post) OR p_post<>normalize(p_post,NFKC) OR post_slug_utf16_code_units(p_post) NOT BETWEEN 1 AND 80
   OR octet_length(p_post)>320 OR p_post~'[[:space:][:cntrl:]]'
   OR strpos(p_post,'%')>0 OR strpos(p_post,'/')>0 OR strpos(p_post,E'\\')>0
   OR p_post IN ('.','..') THEN RETURN 'invalid-key'; END IF;
 INSERT INTO post_slug_aliases(slug,post_id,slug_policy_version)
 VALUES(p_post,p_post,'video-receipt-exact-v1') ON CONFLICT DO NOTHING;
 inserted := FOUND;
 SELECT * INTO existing_slug FROM post_slug_aliases WHERE slug=p_post;
 SELECT * INTO existing_post FROM post_slug_aliases WHERE post_id=p_post;
 IF existing_slug.post_id=p_post AND existing_post.slug=p_post
   AND existing_slug.slug_policy_version IN ('post-slug-v1','video-receipt-exact-v1') THEN
   RETURN CASE WHEN inserted THEN 'inserted' ELSE 'already-exact' END;
 END IF;
 IF existing_slug.post_id IS NOT NULL AND existing_slug.post_id<>p_post THEN RETURN 'slug-collision'; END IF;
 IF existing_post.slug IS NOT NULL AND existing_post.slug<>p_post THEN RETURN 'different-existing-alias'; END IF;
 -- A conflict invisible to this command snapshot must never become success.
 RETURN 'unknown';
END $$;

CREATE FUNCTION require_video_terminal_exact_alias_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.media_kind='video' AND NEW.status='published' AND
   (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM 'published') AND NOT EXISTS (
     SELECT 1 FROM post_slug_aliases a JOIN media_publication_projections p ON p.post_id=a.post_id
     WHERE a.slug=NEW.post_id AND a.post_id=NEW.post_id AND p.submission_id=NEW.submission_id
       AND p.operation_id=NEW.operation_id AND p.creation_revision=NEW.creation_revision
       AND p.video_revision=NEW.video_revision AND p.media_kind='video'
   ) THEN RAISE EXCEPTION 'terminal video publication requires exact alias and projection'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER media_video_terminal_exact_alias
 AFTER INSERT OR UPDATE ON media_post_submissions DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION require_video_terminal_exact_alias_v1();

REVOKE ALL ON FUNCTION require_video_publication_identity_v1(TEXT,TEXT,TEXT),
 ensure_exact_video_receipt_alias_v1(TEXT,TEXT,TEXT) FROM PUBLIC;

CREATE FUNCTION reconcile_video_publication_identity_v1(p_submission TEXT,p_operation TEXT,p_post TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM media_post_submissions s
 JOIN posts p ON p.post_id=s.post_id AND p.community_id=s.community_id AND p.post_type='video'
   AND p.idempotency_key='video-publication:'||s.operation_id
 JOIN media_publication_projections pub ON pub.submission_id=s.submission_id AND pub.operation_id=s.operation_id
   AND pub.community_id=s.community_id AND pub.post_id=s.post_id AND pub.media_kind='video'
   AND pub.creation_revision=s.creation_revision AND pub.video_revision=s.video_revision AND pub.analysis_revision=s.analysis_revision
 WHERE s.submission_id=p_submission AND s.operation_id=p_operation AND s.post_id=p_post AND s.status='published' AND s.media_kind='video'
   AND (s.post_id<>video_publication_post_id_v1(s.submission_id,s.operation_id) OR EXISTS(
     SELECT 1 FROM post_slug_aliases a WHERE a.slug=s.post_id AND a.post_id=s.post_id))
 )
$$;

-- STABLE SQL functions below share the caller statement's MVCC snapshot. No
-- procedural/sequential authorizer or subsequent getPost call is part of a read.
CREATE FUNCTION video_detail_persona_v1(p_persona TEXT) RETURNS JSONB LANGUAGE sql STABLE AS $$
 SELECT public_persona_projection(persona.persona_id) FROM personas persona
 JOIN users account ON account.user_id=persona.account_id AND account.status='active'
 WHERE persona.persona_id=p_persona AND persona.status='active'
$$;

CREATE FUNCTION video_detail_access_v1(p_viewer TEXT,p_post TEXT)
RETURNS TABLE(non_age_allowed BOOLEAN,age_allowed BOOLEAN) LANGUAGE sql STABLE AS $$
 WITH candidates AS (SELECT COALESCE(
   p.status='published' AND c.status='active'
   AND video_detail_id_safe_v1(p.post_id)
   AND (p_viewer IS NULL OR EXISTS(SELECT 1 FROM users u WHERE u.user_id=p_viewer AND u.status='active'))
   AND (p.visibility='public' OR (p.visibility='members_only' AND EXISTS(
     SELECT 1 FROM community_memberships m WHERE m.community_id=p.community_id AND m.user_id=p_viewer AND m.status='member')))
   AND s.status='published' AND s.media_kind='video' AND s.video_intent IN('original_audio','song_reference')
   AND s.community_id=pub.community_id AND s.post_id=pub.post_id AND s.operation_id=pub.operation_id
   AND p.idempotency_key='video-publication:'||pub.operation_id
   AND (p.author_user_id=s.actor_user_id OR (p.author_user_id IS NULL AND NOT EXISTS(
     SELECT 1 FROM users source_actor WHERE source_actor.user_id=s.actor_user_id AND source_actor.status='active')))
   AND s.creation_revision=pub.creation_revision AND s.video_revision=pub.video_revision
   AND s.analysis_revision=pub.analysis_revision
   AND d.operation_id=pub.operation_id AND d.community_id=pub.community_id
   AND d.actor_user_id=pub.actor_user_id AND s.actor_user_id=pub.actor_user_id
   AND analysis.operation_id=pub.operation_id AND analysis.community_id=pub.community_id
   AND analysis.actor_user_id=pub.actor_user_id
   -- Analysis always describes the sealed CAPTURE, including song-reference
   -- work. Its rendered accepted MASTER is a distinct asset/digest below.
   AND analysis.video_revision=capture.video_revision AND analysis.canonical_video_sha256=capture.canonical_sha256
   AND capture.operation_id=pub.operation_id AND capture.community_id=pub.community_id
   AND capture.actor_user_id=pub.actor_user_id
   AND capture_object.submission_id=pub.submission_id AND capture_object.operation_id=pub.operation_id
   AND capture_object.community_id=pub.community_id AND capture_object.actor_user_id=pub.actor_user_id
   AND capture_object.author_persona_id IS NOT DISTINCT FROM pub.author_persona_id
   AND capture_object.canonical_sha256=capture.canonical_sha256
   AND capture_object.size_bytes=capture.size_bytes AND capture_object.content_type=capture.content_type
   AND published_object.submission_id=pub.submission_id AND published_object.operation_id=pub.operation_id
   AND published_object.community_id=pub.community_id AND published_object.actor_user_id=pub.actor_user_id
   AND published_object.author_persona_id IS NOT DISTINCT FROM pub.author_persona_id
   AND published_object.canonical_sha256=pub.canonical_video_sha256
   AND ((s.video_intent='original_audio' AND pub.video_asset_ref=capture.immutable_ref
       AND pub.canonical_video_sha256=capture.canonical_sha256 AND pub.original_sound_id IS NOT NULL
       AND pub.song_video_plan_id IS NULL AND pub.song_video_master_revision_id IS NULL)
     OR (s.video_intent='song_reference' AND pub.original_sound_id IS NULL AND EXISTS(
       SELECT 1 FROM media_song_video_render_plans plan
       JOIN media_song_video_accepted_masters accepted ON accepted.plan_id=plan.plan_id
       JOIN media_song_video_masters master ON master.plan_id=accepted.plan_id AND master.master_revision_id=accepted.master_revision_id
       WHERE plan.plan_id=pub.song_video_plan_id AND plan.submission_id=pub.submission_id
         AND master.master_revision_id=pub.song_video_master_revision_id AND master.plan_submission_id=pub.submission_id
         AND master.source_immutable_ref=capture.immutable_ref AND master.source_sha256=capture.canonical_sha256
         AND master.verified_object_key=pub.video_asset_ref AND master.master_sha256=pub.canonical_video_sha256
         AND master.master_sha256<>capture.canonical_sha256
         AND published_object.size_bytes=master.master_byte_length AND published_object.content_type='video/mp4'
         AND published_object.object_version=master.verified_object_version AND published_object.etag=master.verified_object_etag
         AND EXISTS(SELECT 1 FROM media_video_song_references edge WHERE edge.submission_id=pub.submission_id
           AND edge.operation_id=pub.operation_id AND edge.creation_revision=pub.creation_revision
           AND edge.actor_account_id=pub.actor_user_id AND edge.post_id=pub.post_id
           AND edge.plan_id=plan.plan_id AND edge.master_revision_id=master.master_revision_id
           AND edge.song_post_id=plan.song_post_id AND edge.audio_revision=plan.audio_revision))))
   AND d.video_revision=pub.video_revision AND d.analysis_revision=pub.analysis_revision
   AND pub.decision_revision<=pub.creation_revision
   AND r.rights_basis=CASE s.video_intent WHEN 'song_reference' THEN 'derivative' ELSE 'original' END
   AND NOT EXISTS(SELECT 1 FROM media_video_safety_evidence e WHERE e.submission_id=pub.submission_id
     AND e.video_revision=pub.video_revision AND e.creation_revision BETWEEN pub.decision_revision AND pub.creation_revision AND e.platform_held)
   AND (d.outcome='publish' OR (d.outcome='review' AND EXISTS(SELECT 1 FROM media_video_review_holds h
     WHERE h.submission_id=pub.submission_id AND h.creation_revision=pub.decision_revision AND h.status='approved')))
   AND NOT EXISTS(SELECT 1 FROM media_video_review_holds h WHERE h.submission_id=pub.submission_id
     AND h.creation_revision BETWEEN pub.decision_revision AND pub.creation_revision AND h.status<>'approved')
   AND (s.video_intent<>'song_reference' OR EXISTS(
     SELECT 1 FROM media_video_song_references edge
     JOIN posts song ON song.post_id=edge.song_post_id AND song.community_id=edge.song_community_id
     JOIN communities song_community ON song_community.community_id=song.community_id AND song_community.status='active'
     WHERE edge.submission_id=pub.submission_id AND edge.post_id=pub.post_id
       AND edge.plan_id=pub.song_video_plan_id AND edge.master_revision_id=pub.song_video_master_revision_id
       AND song.status='published' AND song.post_type='song'
       AND (song.visibility='public' OR EXISTS(SELECT 1 FROM community_memberships m
         WHERE m.community_id=song.community_id AND m.user_id=p_viewer AND m.status='member')))),FALSE) AS non_age_allowed,
   COALESCE(can_account_view_content_rating_v1(p_viewer,p.content_rating)
     AND can_account_view_content_rating_v1(p_viewer,d.effective_content_rating)
     AND (s.video_intent<>'song_reference' OR EXISTS(SELECT 1 FROM media_video_song_references edge
       JOIN posts song ON song.community_id=edge.song_community_id AND song.post_id=edge.song_post_id
       WHERE edge.submission_id=pub.submission_id AND edge.post_id=pub.post_id
       AND edge.plan_id=pub.song_video_plan_id AND edge.master_revision_id=pub.song_video_master_revision_id
       AND can_account_view_content_rating_v1(p_viewer,song.content_rating))),FALSE) AS age_allowed
 FROM posts p JOIN communities c ON c.community_id=p.community_id
 LEFT JOIN media_publication_projections pub ON pub.post_id=p.post_id AND pub.community_id=p.community_id AND pub.media_kind='video'
   AND p.idempotency_key='video-publication:'||pub.operation_id
 LEFT JOIN media_post_submissions s ON s.submission_id=pub.submission_id
 LEFT JOIN media_video_publication_decisions d ON d.submission_id=pub.submission_id AND d.creation_revision=pub.decision_revision
 LEFT JOIN media_video_analyses analysis ON analysis.submission_id=pub.submission_id AND analysis.analysis_revision=pub.analysis_revision
 LEFT JOIN media_video_revisions capture ON capture.submission_id=pub.submission_id AND capture.video_revision=pub.video_revision
 LEFT JOIN media_immutable_objects capture_object ON capture_object.immutable_ref=capture.immutable_ref
 LEFT JOIN media_immutable_objects published_object ON published_object.immutable_ref=pub.video_asset_ref
 LEFT JOIN media_video_rights r ON r.submission_id=pub.submission_id
 WHERE p.post_id=p_post AND p.post_type='video')
 SELECT count(*)=1 AND COALESCE(bool_and(non_age_allowed),FALSE),
   count(*)=1 AND COALESCE(bool_and(age_allowed),FALSE) FROM candidates
$$;

-- Same snapshot guard for targeted ancestry and ordinary inline continuations.
CREATE OR REPLACE FUNCTION authorized_comment_branch_v1(p_viewer TEXT,p_comment TEXT)
RETURNS TABLE(community_id TEXT,post_id TEXT,comment_id TEXT,path_ids TEXT[],
  ancestor_ids TEXT[],target_rating_allowed BOOLEAN)
LANGUAGE sql STABLE AS $$
 WITH RECURSIVE ancestry AS (
   SELECT c.community_id,c.post_id,c.comment_id,c.parent_comment_id,c.depth,c.depth AS target_depth,
     c.status,c.content_rating,0 AS hops,ARRAY[c.comment_id] AS seen,FALSE AS cycle
     FROM comments c WHERE c.comment_id=p_comment
   UNION ALL
   SELECT c.community_id,c.post_id,c.comment_id,c.parent_comment_id,c.depth,a.target_depth,
     c.status,c.content_rating,a.hops+1,a.seen||c.comment_id,c.comment_id=ANY(a.seen)
     FROM comments c JOIN ancestry a ON c.comment_id=a.parent_comment_id
     WHERE c.community_id=a.community_id AND c.post_id=a.post_id AND a.hops<8 AND NOT a.cycle
 ), valid AS (
   SELECT COUNT(*)=MAX(target_depth)+1 AND COUNT(DISTINCT comment_id)=COUNT(*)
     AND bool_and(target_depth BETWEEN 0 AND 8 AND depth=target_depth-hops AND NOT cycle AND status='published')
     AND bool_or(depth=0 AND parent_comment_id IS NULL AND hops=target_depth)
     AND bool_and(hops=0 OR can_account_view_content_rating_v1(p_viewer,content_rating)) AS allowed
   FROM ancestry
 ) SELECT target.community_id,target.post_id,target.comment_id,
   ARRAY(SELECT a.comment_id FROM ancestry a ORDER BY a.hops DESC),
   ARRAY(SELECT a.comment_id FROM ancestry a WHERE a.hops>0 ORDER BY a.hops DESC),
   can_account_view_content_rating_v1(p_viewer,target.content_rating)
 FROM ancestry target JOIN posts p ON p.community_id=target.community_id AND p.post_id=target.post_id
 JOIN communities community ON community.community_id=p.community_id
 JOIN users viewer ON viewer.user_id=p_viewer AND viewer.status='active'
 WHERE target.hops=0 AND (SELECT allowed FROM valid)
   AND p.status='published' AND community.status='active'
   AND (p.post_type<>'video' OR EXISTS(SELECT 1 FROM video_detail_access_v1(p_viewer,p.post_id) v WHERE v.non_age_allowed AND v.age_allowed))
   AND can_account_view_content_rating_v1(p_viewer,p.content_rating)
   AND (p.visibility='public' OR (p.visibility='members_only' AND EXISTS (
     SELECT 1 FROM community_memberships m WHERE m.community_id=p.community_id
       AND m.user_id=p_viewer AND m.status='member')))
$$;

CREATE OR REPLACE FUNCTION resolve_comment_navigation_v1(p_viewer TEXT,p_comment TEXT)
RETURNS JSONB LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('post_type',p.post_type,'post_id',p.post_id,'post_slug',alias.slug,'document',CASE WHEN NOT branch.target_rating_allowed THEN
   jsonb_build_object('kind','age_locked','content_rating','adult_18',
     'next_action',jsonb_build_object('kind','verify_minimum_age','minimum_age',18))
 ELSE jsonb_build_object('kind','available','post_id',branch.post_id,'community_id',branch.community_id,
   'target_comment_id',branch.comment_id,'ancestor_comment_ids',to_jsonb(branch.ancestor_ids),
   'windows',(SELECT jsonb_agg(w.document ORDER BY path.ordinal)
     FROM unnest(branch.path_ids) WITH ORDINALITY AS path(id,ordinal)
     JOIN comments node ON node.comment_id=path.id AND node.community_id=branch.community_id AND node.post_id=branch.post_id
     CROSS JOIN LATERAL (
       WITH page AS MATERIALIZED (
         SELECT c.comment_id,c.created_at,CASE WHEN NOT can_account_view_content_rating_v1(p_viewer,c.content_rating) THEN
           jsonb_build_object('kind','age_locked','content_rating','adult_18',
             'next_action',jsonb_build_object('kind','verify_minimum_age','minimum_age',18))
         ELSE jsonb_build_object('comment_id',c.comment_id,'parent_comment_id',c.parent_comment_id,
           'body',c.body,'author_persona',CASE WHEN EXISTS(SELECT 1 FROM users author WHERE author.user_id=c.author_user_id AND author.status='active') THEN public_persona_projection(c.author_persona_id) ELSE NULL END,'depth',c.depth,
           'reply_count',(SELECT count(*) FROM comments reply WHERE reply.community_id=c.community_id
             AND reply.post_id=c.post_id AND reply.parent_comment_id=c.comment_id AND reply.status='published'),
           'status','published','content_rating',c.content_rating,'created_at',c.created_at) END AS item
         FROM comments c WHERE c.community_id=branch.community_id AND c.post_id=branch.post_id
           AND c.parent_comment_id IS NOT DISTINCT FROM node.parent_comment_id AND c.status='published'
           AND (c.created_at,c.comment_id)>=(node.created_at,node.comment_id)
         ORDER BY c.created_at,c.comment_id LIMIT 21
       ), shown AS (SELECT * FROM page ORDER BY created_at,comment_id LIMIT 20)
       SELECT jsonb_build_object('parent_comment_id',node.parent_comment_id,'branch_comment_id',node.comment_id,
         'items',(SELECT jsonb_agg(item ORDER BY created_at,comment_id) FROM shown),
         'earlier_items_omitted',EXISTS(SELECT 1 FROM comments earlier WHERE earlier.community_id=branch.community_id
           AND earlier.post_id=branch.post_id AND earlier.parent_comment_id IS NOT DISTINCT FROM node.parent_comment_id
           AND earlier.status='published' AND (earlier.created_at,earlier.comment_id)<(node.created_at,node.comment_id)),
         'next_cursor',CASE WHEN (SELECT count(*) FROM page)>20 THEN
           (SELECT comment_id FROM shown ORDER BY created_at DESC,comment_id DESC LIMIT 1) ELSE NULL END) AS document
     ) w)) END)
 FROM authorized_comment_branch_v1(p_viewer,p_comment) branch
 JOIN posts p ON p.community_id=branch.community_id AND p.post_id=branch.post_id AND p.post_type IN('text','song','video')
 LEFT JOIN post_slug_aliases alias ON alias.post_id=p.post_id
 WHERE p.post_type='video' OR alias.slug IS NOT NULL
$$;

CREATE OR REPLACE FUNCTION list_post_comment_children_v1(p_viewer TEXT,p_post TEXT,p_parent TEXT,p_cursor TEXT)
RETURNS JSONB LANGUAGE sql STABLE AS $$
 WITH access AS MATERIALIZED (
   SELECT p.community_id FROM posts p JOIN communities community USING(community_id)
   JOIN users viewer ON viewer.user_id=p_viewer AND viewer.status='active'
   WHERE p.post_id=p_post AND p.status='published' AND community.status='active'
     AND (p.post_type<>'video' OR EXISTS(SELECT 1 FROM video_detail_access_v1(p_viewer,p.post_id) v WHERE v.non_age_allowed AND v.age_allowed))
     AND can_account_view_content_rating_v1(p_viewer,p.content_rating)
     AND (p.visibility='public' OR (p.visibility='members_only' AND EXISTS(
       SELECT 1 FROM community_memberships m WHERE m.community_id=p.community_id
         AND m.user_id=p_viewer AND m.status='member')))
 ), authorized AS MATERIALIZED (
   SELECT access.community_id,p_parent IS NULL OR EXISTS(
     SELECT 1 FROM authorized_comment_branch_v1(p_viewer,p_parent) branch
       WHERE branch.community_id=access.community_id AND branch.post_id=p_post
         AND branch.target_rating_allowed) AS parent_allowed FROM access
 ), anchor AS MATERIALIZED (
   SELECT c.comment_id,c.created_at FROM comments c JOIN access USING(community_id)
   WHERE c.post_id=p_post AND c.parent_comment_id IS NOT DISTINCT FROM p_parent AND c.comment_id=p_cursor
 ), page AS MATERIALIZED (
   SELECT c.comment_id,c.created_at,
     CASE WHEN NOT can_account_view_content_rating_v1(p_viewer,c.content_rating) THEN
       jsonb_build_object('kind','age_locked','content_rating','adult_18',
         'next_action',jsonb_build_object('kind','verify_minimum_age','minimum_age',18))
     ELSE jsonb_build_object('comment_id',c.comment_id,'parent_comment_id',c.parent_comment_id,
       'body',c.body,'author_persona',CASE WHEN EXISTS(SELECT 1 FROM users author
         WHERE author.user_id=c.author_user_id AND author.status='active')
         THEN public_persona_projection(c.author_persona_id) ELSE NULL END,
       'depth',c.depth,'reply_count',(SELECT count(*) FROM comments reply WHERE reply.community_id=c.community_id
         AND reply.post_id=c.post_id AND reply.parent_comment_id=c.comment_id AND reply.status='published'),
       'status','published','content_rating',c.content_rating,'created_at',c.created_at) END AS item
   FROM comments c JOIN authorized a USING(community_id)
   WHERE a.parent_allowed AND c.post_id=p_post AND c.parent_comment_id IS NOT DISTINCT FROM p_parent
     AND c.status='published' AND (p_cursor IS NULL OR
       (c.created_at,c.comment_id)>(SELECT created_at,comment_id FROM anchor))
   ORDER BY c.created_at,c.comment_id LIMIT 21
 ), shown AS (SELECT * FROM page ORDER BY created_at,comment_id LIMIT 20)
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM access) THEN jsonb_build_object('kind','post_not_found')
   WHEN NOT EXISTS(SELECT 1 FROM authorized WHERE parent_allowed) THEN jsonb_build_object('kind','comment_not_found')
   WHEN p_cursor IS NOT NULL AND NOT EXISTS(SELECT 1 FROM anchor) THEN jsonb_build_object('kind','invalid_cursor')
   ELSE jsonb_build_object('kind','available','document',jsonb_build_object(
     'items',COALESCE((SELECT jsonb_agg(item ORDER BY created_at,comment_id) FROM shown),'[]'::jsonb),
     'next_cursor',CASE WHEN (SELECT count(*) FROM page)>20 THEN
       (SELECT comment_id FROM shown ORDER BY created_at DESC,comment_id DESC LIMIT 1) ELSE NULL END)) END
$$;
