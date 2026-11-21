-- Exact0284 projection into newly-created0278 reward_song_slots_v2.
-- That target must be absent at ledger275. Do not read it as an existing table.
-- The target has no FK to posts or communities: do not invent one as a gate.
WITH projected AS MATERIALIZED (
 SELECT 'song-slot:'||encode(sha256(convert_to(jsonb_build_array(p.community_id,p.post_id)::text,'UTF8')),'hex') AS slot_id,
        p.community_id,p.post_id
 FROM api_next.posts p WHERE p.post_type='song' AND p.status='published'
)
SELECT count(*) AS published_song_count,
 count(*) FILTER(WHERE slot_id IS NULL OR community_id IS NULL OR post_id IS NULL) AS not_null_failures,
 (SELECT count(*) FROM (SELECT slot_id FROM projected GROUP BY slot_id HAVING count(*)>1) duplicates) AS slot_id_duplicate_groups,
 (SELECT count(*) FROM (SELECT community_id,post_id FROM projected GROUP BY community_id,post_id HAVING count(*)>1) duplicates) AS song_identity_duplicate_groups,
 encode(sha256(convert_to(coalesce(string_agg(
  encode(sha256(convert_to(jsonb_build_array(slot_id,community_id,post_id,0,NULL,NULL,FALSE,'open',NULL)::text,'UTF8')),'hex'),
  E'\n' ORDER BY slot_id),''),'UTF8')),'hex') AS projected_rows_sha256
FROM projected;
