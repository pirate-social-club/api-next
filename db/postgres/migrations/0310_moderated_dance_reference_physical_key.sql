-- A sealed render records its logical immutable reference. The source gateway
-- reads R2 directly, so this boundary must return the corresponding physical
-- key. Preserve the sealed identity and every existing capability/access gate.
CREATE OR REPLACE FUNCTION resolve_moderated_dance_reference_source_v1(p_digest TEXT)
RETURNS TABLE(physical_key TEXT,object_version TEXT,etag TEXT,size_bytes BIGINT,content_type TEXT,canonical_sha256 TEXT,expires_at TIMESTAMPTZ,identity_kind TEXT)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
 SELECT 'immutable/'||source_key.suffix,master.verified_object_version,master.verified_object_etag,
        master.master_byte_length,'video/mp4',master.master_sha256,grant_row.expires_at,'content_etag'
 FROM dance_moderated_reference_sources_v1 grant_row
 JOIN dance_moderated_reference_commands_v1 command USING(choreography_id)
 JOIN media_song_video_masters master ON master.master_revision_id=command.master_revision_id
 JOIN posts video ON video.community_id=command.reference_community_id AND video.post_id=command.reference_post_id
   AND video.status='published' AND video.visibility='public'
 CROSS JOIN LATERAL (
   SELECT substring(master.verified_object_key FROM length('media://immutable/')+1) AS suffix
 ) source_key
 WHERE starts_with(master.verified_object_key,'media://immutable/')
   AND length(source_key.suffix) BETWEEN 1 AND 768
   AND NOT starts_with(source_key.suffix,'/')
   AND strpos(source_key.suffix,chr(92))=0
   AND NOT ('..'=ANY(string_to_array(source_key.suffix,'/')))
   AND EXISTS(SELECT 1 FROM video_detail_access_v1(command.account_id,video.post_id) access
     WHERE access.non_age_allowed AND access.age_allowed)
   AND grant_row.capability_sha256=p_digest AND grant_row.revoked_at IS NULL
   AND grant_row.expires_at>clock_timestamp() AND grant_row.work_token=command.work_token
   AND command.state IN('normalizing','unknown') AND command.worker_deadline>clock_timestamp()
$$;

-- CREATE OR REPLACE retains the existing owner and confined execution grants.
-- Rebind the same trusted search path; add no new public or runtime authority.
DO $path$ DECLARE trusted TEXT:=current_schema(); BEGIN
 EXECUTE format('ALTER FUNCTION resolve_moderated_dance_reference_source_v1(text) SET search_path=%I,pg_catalog,pg_temp',trusted);
END $path$;
