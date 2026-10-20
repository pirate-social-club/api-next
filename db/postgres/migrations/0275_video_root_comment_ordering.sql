-- Video roots are newest first; replies and text/song roots remain oldest first.
-- Explicit direction, parent and cursor branches retain indexable seek predicates.
-- Every candidate branch stops at21 before bounded presentation sorting/projection.
-- Applied migration bytes, authorization, privacy and cursor identity remain unchanged.

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
       WITH candidates AS MATERIALIZED (
          (SELECT c.comment_id,c.created_at,c.community_id,c.post_id,c.parent_comment_id,c.body,c.author_user_id,c.author_persona_id,c.depth,c.content_rating
          FROM comments c WHERE c.community_id=branch.community_id AND c.post_id=branch.post_id AND c.parent_comment_id IS NULL AND c.status='published' AND (p.post_type='video' AND node.parent_comment_id IS NULL) AND (c.created_at,c.comment_id)<=(node.created_at,node.comment_id)
          ORDER BY c.created_at DESC,c.comment_id DESC LIMIT 21)
          UNION ALL
          (SELECT c.comment_id,c.created_at,c.community_id,c.post_id,c.parent_comment_id,c.body,c.author_user_id,c.author_persona_id,c.depth,c.content_rating
          FROM comments c WHERE c.community_id=branch.community_id AND c.post_id=branch.post_id AND c.parent_comment_id IS NULL AND c.status='published' AND (p.post_type<>'video' AND node.parent_comment_id IS NULL) AND (c.created_at,c.comment_id)>=(node.created_at,node.comment_id)
          ORDER BY c.created_at ASC,c.comment_id ASC LIMIT 21)
          UNION ALL
          (SELECT c.comment_id,c.created_at,c.community_id,c.post_id,c.parent_comment_id,c.body,c.author_user_id,c.author_persona_id,c.depth,c.content_rating
          FROM comments c WHERE c.community_id=branch.community_id AND c.post_id=branch.post_id AND c.parent_comment_id=node.parent_comment_id AND c.status='published' AND (node.parent_comment_id IS NOT NULL) AND (c.created_at,c.comment_id)>=(node.created_at,node.comment_id)
          ORDER BY c.created_at ASC,c.comment_id ASC LIMIT 21)
       ), page AS MATERIALIZED (
         SELECT c.comment_id,c.created_at,(p.post_type='video' AND node.parent_comment_id IS NULL) AS newest_roots,CASE WHEN NOT can_account_view_content_rating_v1(p_viewer,c.content_rating) THEN
           jsonb_build_object('kind','age_locked','content_rating','adult_18',
             'next_action',jsonb_build_object('kind','verify_minimum_age','minimum_age',18))
         ELSE jsonb_build_object('comment_id',c.comment_id,'parent_comment_id',c.parent_comment_id,
           'body',c.body,'author_persona',CASE WHEN EXISTS(SELECT 1 FROM users author WHERE author.user_id=c.author_user_id AND author.status='active') THEN public_persona_projection(c.author_persona_id) ELSE NULL END,'depth',c.depth,
           'reply_count',(SELECT count(*) FROM comments reply WHERE reply.community_id=c.community_id
             AND reply.post_id=c.post_id AND reply.parent_comment_id=c.comment_id AND reply.status='published'),
           'status','published','content_rating',c.content_rating,'created_at',c.created_at) END AS item
         FROM candidates c
       ), shown AS (SELECT * FROM page ORDER BY CASE WHEN newest_roots THEN created_at END DESC,CASE WHEN newest_roots THEN comment_id END DESC,created_at,comment_id LIMIT 20)
       SELECT jsonb_build_object('parent_comment_id',node.parent_comment_id,'branch_comment_id',node.comment_id,
         'items',(SELECT jsonb_agg(item ORDER BY CASE WHEN newest_roots THEN created_at END DESC,CASE WHEN newest_roots THEN comment_id END DESC,created_at,comment_id) FROM shown),
         'earlier_items_omitted',CASE WHEN p.post_type='video' AND node.parent_comment_id IS NULL THEN EXISTS(SELECT 1 FROM comments earlier WHERE earlier.community_id=branch.community_id AND earlier.post_id=branch.post_id AND earlier.parent_comment_id IS NULL AND earlier.status='published' AND (earlier.created_at,earlier.comment_id)>(node.created_at,node.comment_id))
           WHEN node.parent_comment_id IS NULL THEN EXISTS(SELECT 1 FROM comments earlier WHERE earlier.community_id=branch.community_id AND earlier.post_id=branch.post_id AND earlier.parent_comment_id IS NULL AND earlier.status='published' AND (earlier.created_at,earlier.comment_id)<(node.created_at,node.comment_id))
           ELSE EXISTS(SELECT 1 FROM comments earlier WHERE earlier.community_id=branch.community_id AND earlier.post_id=branch.post_id AND earlier.parent_comment_id=node.parent_comment_id AND earlier.status='published' AND (earlier.created_at,earlier.comment_id)<(node.created_at,node.comment_id)) END,
         'next_cursor',CASE WHEN (SELECT count(*) FROM page)>20 THEN
           (SELECT comment_id FROM shown ORDER BY CASE WHEN newest_roots THEN created_at END,CASE WHEN newest_roots THEN comment_id END,created_at DESC,comment_id DESC LIMIT 1) ELSE NULL END) AS document
     ) w)) END)
 FROM authorized_comment_branch_v1(p_viewer,p_comment) branch
 JOIN posts p ON p.community_id=branch.community_id AND p.post_id=branch.post_id AND p.post_type IN('text','song','video')
 LEFT JOIN post_slug_aliases alias ON alias.post_id=p.post_id
 WHERE p.post_type='video' OR alias.slug IS NOT NULL
$$;

CREATE OR REPLACE FUNCTION list_post_comment_children_v1(p_viewer TEXT,p_post TEXT,p_parent TEXT,p_cursor TEXT)
RETURNS JSONB LANGUAGE sql STABLE AS $$
 WITH access AS MATERIALIZED (
   SELECT p.community_id,p.post_type='video' AND p_parent IS NULL AS newest_roots FROM posts p JOIN communities community USING(community_id)
   JOIN users viewer ON viewer.user_id=p_viewer AND viewer.status='active'
   WHERE p.post_id=p_post AND p.status='published' AND community.status='active'
     AND (p.post_type<>'video' OR EXISTS(SELECT 1 FROM video_detail_access_v1(p_viewer,p.post_id) v WHERE v.non_age_allowed AND v.age_allowed))
     AND can_account_view_content_rating_v1(p_viewer,p.content_rating)
     AND (p.visibility='public' OR (p.visibility='members_only' AND EXISTS(
       SELECT 1 FROM community_memberships m WHERE m.community_id=p.community_id
         AND m.user_id=p_viewer AND m.status='member')))
 ), authorized AS MATERIALIZED (
   SELECT access.community_id,access.newest_roots,p_parent IS NULL OR EXISTS(
     SELECT 1 FROM authorized_comment_branch_v1(p_viewer,p_parent) branch
       WHERE branch.community_id=access.community_id AND branch.post_id=p_post
         AND branch.target_rating_allowed) AS parent_allowed FROM access
 ), anchor AS MATERIALIZED (
   SELECT c.comment_id,c.created_at FROM comments c JOIN access USING(community_id)
   WHERE c.post_id=p_post AND c.parent_comment_id IS NOT DISTINCT FROM p_parent AND c.comment_id=p_cursor
 ), candidates AS MATERIALIZED (
   SELECT c.comment_id,c.created_at,c.community_id,c.post_id,c.parent_comment_id,c.body,c.author_user_id,c.author_persona_id,c.depth,c.content_rating,a.newest_roots FROM authorized a CROSS JOIN LATERAL (
          (SELECT c.comment_id,c.created_at,c.community_id,c.post_id,c.parent_comment_id,c.body,c.author_user_id,c.author_persona_id,c.depth,c.content_rating
          FROM comments c WHERE a.parent_allowed AND (a.newest_roots) AND c.community_id=a.community_id AND c.post_id=p_post AND c.parent_comment_id IS NULL AND c.status='published' AND p_cursor IS NULL
          ORDER BY c.created_at DESC,c.comment_id DESC LIMIT 21)
          UNION ALL
          (SELECT c.comment_id,c.created_at,c.community_id,c.post_id,c.parent_comment_id,c.body,c.author_user_id,c.author_persona_id,c.depth,c.content_rating
          FROM comments c WHERE a.parent_allowed AND (a.newest_roots) AND c.community_id=a.community_id AND c.post_id=p_post AND c.parent_comment_id IS NULL AND c.status='published' AND p_cursor IS NOT NULL AND (c.created_at,c.comment_id)<(SELECT created_at,comment_id FROM anchor)
          ORDER BY c.created_at DESC,c.comment_id DESC LIMIT 21)
          UNION ALL
          (SELECT c.comment_id,c.created_at,c.community_id,c.post_id,c.parent_comment_id,c.body,c.author_user_id,c.author_persona_id,c.depth,c.content_rating
          FROM comments c WHERE a.parent_allowed AND (NOT a.newest_roots AND p_parent IS NULL) AND c.community_id=a.community_id AND c.post_id=p_post AND c.parent_comment_id IS NULL AND c.status='published' AND p_cursor IS NULL
          ORDER BY c.created_at ASC,c.comment_id ASC LIMIT 21)
          UNION ALL
          (SELECT c.comment_id,c.created_at,c.community_id,c.post_id,c.parent_comment_id,c.body,c.author_user_id,c.author_persona_id,c.depth,c.content_rating
          FROM comments c WHERE a.parent_allowed AND (NOT a.newest_roots AND p_parent IS NULL) AND c.community_id=a.community_id AND c.post_id=p_post AND c.parent_comment_id IS NULL AND c.status='published' AND p_cursor IS NOT NULL AND (c.created_at,c.comment_id)>(SELECT created_at,comment_id FROM anchor)
          ORDER BY c.created_at ASC,c.comment_id ASC LIMIT 21)
          UNION ALL
          (SELECT c.comment_id,c.created_at,c.community_id,c.post_id,c.parent_comment_id,c.body,c.author_user_id,c.author_persona_id,c.depth,c.content_rating
          FROM comments c WHERE a.parent_allowed AND (p_parent IS NOT NULL) AND c.community_id=a.community_id AND c.post_id=p_post AND c.parent_comment_id=p_parent AND c.status='published' AND p_cursor IS NULL
          ORDER BY c.created_at ASC,c.comment_id ASC LIMIT 21)
          UNION ALL
          (SELECT c.comment_id,c.created_at,c.community_id,c.post_id,c.parent_comment_id,c.body,c.author_user_id,c.author_persona_id,c.depth,c.content_rating
          FROM comments c WHERE a.parent_allowed AND (p_parent IS NOT NULL) AND c.community_id=a.community_id AND c.post_id=p_post AND c.parent_comment_id=p_parent AND c.status='published' AND p_cursor IS NOT NULL AND (c.created_at,c.comment_id)>(SELECT created_at,comment_id FROM anchor)
          ORDER BY c.created_at ASC,c.comment_id ASC LIMIT 21)
   ) c
 ), page AS MATERIALIZED (
   SELECT c.comment_id,c.created_at,c.newest_roots,
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
   FROM candidates c
 ), shown AS (SELECT * FROM page ORDER BY CASE WHEN newest_roots THEN created_at END DESC,CASE WHEN newest_roots THEN comment_id END DESC,created_at,comment_id LIMIT 20)
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM access) THEN jsonb_build_object('kind','post_not_found')
   WHEN NOT EXISTS(SELECT 1 FROM authorized WHERE parent_allowed) THEN jsonb_build_object('kind','comment_not_found')
   WHEN p_cursor IS NOT NULL AND NOT EXISTS(SELECT 1 FROM anchor) THEN jsonb_build_object('kind','invalid_cursor')
   ELSE jsonb_build_object('kind','available','document',jsonb_build_object(
     'items',COALESCE((SELECT jsonb_agg(item ORDER BY CASE WHEN newest_roots THEN created_at END DESC,CASE WHEN newest_roots THEN comment_id END DESC,created_at,comment_id) FROM shown),'[]'::jsonb),
     'next_cursor',CASE WHEN (SELECT count(*) FROM page)>20 THEN
       (SELECT comment_id FROM shown ORDER BY CASE WHEN newest_roots THEN created_at END,CASE WHEN newest_roots THEN comment_id END,created_at DESC,comment_id DESC LIMIT 1) ELSE NULL END)) END
$$;
