// Pure SELECTs against real PostgreSQL metadata and the readonly observer columns.
export const identitySql = `SELECT current_user::text AS role_name,session_user::text AS login_name,
  r.oid::text AS role_oid,r.rolcanlogin AS can_login,r.rolsuper AS superuser,
  r.rolbypassrls AS bypass_rls,r.rolcreaterole AS create_role,r.rolcreatedb AS create_db,
  r.rolreplication AS replication,current_database()::text AS database_name,d.oid::text AS database_oid,
  control.system_identifier::text AS cluster_identifier,
  pg_catalog.to_regprocedure('pg_catalog.pg_control_system()')::oid::text AS control_function_oid,
  current_setting('server_version_num')::integer AS server_version,
  current_setting('default_transaction_read_only')='on' AS default_read_only
FROM pg_catalog.pg_roles r CROSS JOIN pg_catalog.pg_control_system() control
 JOIN pg_catalog.pg_database d ON d.datname=current_database() WHERE r.rolname=current_user`;
export const rolesSql = `SELECT EXISTS(
 SELECT 1 FROM pg_catalog.pg_roles candidate CROSS JOIN pg_catalog.pg_namespace n
 WHERE (candidate.oid=$1::oid OR pg_catalog.pg_has_role($1::oid,candidate.oid,'SET')
   OR pg_catalog.pg_has_role($1::oid,candidate.oid,'USAGE')) AND (
   candidate.rolname ~ '^pg_' OR candidate.rolsuper OR candidate.rolbypassrls OR candidate.rolcreaterole OR candidate.rolcreatedb OR candidate.rolreplication
   OR (n.nspname !~ '^pg_(temp|toast_temp)' AND pg_catalog.has_schema_privilege(candidate.oid,n.oid,'CREATE'))
   OR pg_catalog.has_database_privilege(candidate.oid,current_database(),'CREATE')
   OR candidate.oid=(SELECT relowner FROM pg_catalog.pg_class WHERE oid=pg_catalog.to_regclass($2 || '.participation_owners'))))
 OR pg_catalog.pg_has_role($1::oid,(SELECT relowner FROM pg_catalog.pg_class WHERE oid=pg_catalog.to_regclass($2 || '.participation_owners')),'MEMBER') AS unsafe`;
export const aclSql = `WITH reachable AS (
 SELECT oid FROM pg_catalog.pg_roles WHERE oid=$1::oid
  OR pg_catalog.pg_has_role($1::oid,oid,'SET') OR pg_catalog.pg_has_role($1::oid,oid,'USAGE')
), objects AS (
 SELECT c.oid,c.relname,c.relkind,n.nspname FROM pg_catalog.pg_class c
 JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
), columns AS (
 SELECT DISTINCT o.nspname AS schema_name,o.relname AS table_name,a.attname AS column_name,p.privilege
 FROM reachable r CROSS JOIN objects o JOIN pg_catalog.pg_attribute a ON a.attrelid=o.oid
 CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) p(privilege)
 WHERE o.relkind IN('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped
  AND pg_catalog.has_column_privilege(r.oid,o.oid,a.attnum,p.privilege)
), tables AS (
 SELECT DISTINCT o.nspname AS schema_name,o.relname AS table_name,p.privilege
 FROM reachable r CROSS JOIN objects o CROSS JOIN
 unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) p(privilege)
 WHERE o.relkind IN('r','p','v','m','f') AND pg_catalog.has_table_privilege(r.oid,o.oid,p.privilege)
), sequences AS (
 SELECT DISTINCT o.nspname AS schema_name,o.relname AS sequence_name,p.privilege
 FROM reachable r CROSS JOIN objects o CROSS JOIN unnest(ARRAY['USAGE','SELECT','UPDATE']) p(privilege)
 WHERE o.relkind='S' AND pg_catalog.has_sequence_privilege(r.oid,o.oid,p.privilege)
), functions AS (
 SELECT DISTINCT n.nspname AS schema_name,p.oid::text AS function_oid
 FROM reachable r CROSS JOIN pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
  AND pg_catalog.has_schema_privilege(r.oid,n.oid,'USAGE') AND pg_catalog.has_function_privilege(r.oid,p.oid,'EXECUTE')
)
SELECT coalesce((SELECT jsonb_agg(DISTINCT jsonb_build_object('function_oid',p.oid::text))
 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
 CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
 WHERE n.nspname='pg_catalog' AND a.privilege_type='EXECUTE' AND a.grantee<>p.proowner
   AND a.grantee IN(SELECT oid FROM reachable)), '[]') AS catalog_functions,
 coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY schema_name COLLATE "C",table_name COLLATE "C",column_name COLLATE "C",privilege COLLATE "C") FROM columns c),'[]') AS columns,
 coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY schema_name COLLATE "C",table_name COLLATE "C",privilege COLLATE "C") FROM tables t),'[]') AS tables,
 coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY schema_name COLLATE "C",sequence_name COLLATE "C",privilege COLLATE "C") FROM sequences s),'[]') AS sequences,
 coalesce((SELECT jsonb_agg(to_jsonb(f) ORDER BY schema_name COLLATE "C",function_oid COLLATE "C") FROM functions f),'[]') AS functions`;
export const functionsSql = `SELECT signature,p.oid::text AS function_oid,p.prosecdef AS definer,
 p.prokind::text AS kind,p.pronamespace=anchor.namespace_id AS namespace,
 p.proowner=anchor.owner_id AS owned,p.proconfig=ARRAY[format('search_path=pg_catalog, %I, pg_temp',$1)] AS pinned,
 encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') AS body_sha256
FROM unnest($2::text[]) q(signature) LEFT JOIN pg_catalog.pg_proc p
 ON p.oid=pg_catalog.to_regprocedure($1 || '.' || signature)
CROSS JOIN (SELECT relnamespace AS namespace_id,relowner AS owner_id FROM pg_catalog.pg_class
 WHERE oid=pg_catalog.to_regclass($1 || '.participation_owners')) anchor
ORDER BY signature COLLATE "C"`;
export const bodiesSql = `SELECT p.proname AS name,encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') AS body_sha256,
 p.proowner=anchor.owner_id AS owned,p.pronamespace=anchor.namespace_id AS namespace,
 p.prokind::text AS kind,p.prosecdef AS definer,
 CASE WHEN p.proconfig IS NULL THEN 'none'
  WHEN p.proconfig=ARRAY[format('search_path=pg_catalog, %I, pg_temp',$1)] THEN 'pinned'
  ELSE 'unreviewed' END AS configuration
FROM pg_catalog.pg_proc p CROSS JOIN (SELECT relnamespace AS namespace_id,relowner AS owner_id
 FROM pg_catalog.pg_class WHERE oid=pg_catalog.to_regclass($1 || '.participation_owners')) anchor
WHERE p.pronamespace=anchor.namespace_id AND p.proname=ANY($2::text[]) ORDER BY name COLLATE "C"`;
export const ledgerSql = (schema: string) =>
  `SELECT version,checksum FROM ${schema}.schema_migrations ORDER BY version COLLATE "C"`;
export const phaseSql = (schema: string) => `WITH anchor AS (
 SELECT relnamespace AS namespace_id,relowner AS owner_id FROM pg_catalog.pg_class
 WHERE oid=pg_catalog.to_regclass($1 || '.participation_owners'))
SELECT NOT (NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE oid=pg_catalog.to_regclass($1 || '.guest_learning_schema_phase')
      AND relnamespace=anchor.namespace_id AND relowner=anchor.owner_id)
    OR (SELECT count(*) FROM ${schema}.guest_learning_schema_phase
      WHERE singleton AND phase='practice_only_owner_audio_producer_history_v5')<>1
    OR EXISTS(SELECT 1 FROM unnest(ARRAY[
      'participation_owners','guest_credentials','guest_empty_owner_aliases','participation_owner_clocks','guest_learning_preferences','guest_participation_operations','guest_secret_issuance_operations','guest_attachment_intents','study_sessions_v2','study_review_items','study_session_items_v2','study_spoken_answer_commands','learner_audio_artifacts','guest_resource_session_reservations','guest_resource_provider_calls','guest_resource_release_receipts','learner_audio_owner_fences','learner_audio_delete_commands','learner_audio_delete_sources','learner_audio_delete_target_artifacts','learner_audio_object_names','learner_audio_upload_attempts','learner_audio_delete_batches','learner_audio_delete_batch_items','learner_audio_deleted_objects','guest_study_spoken_captures','guest_study_spoken_checkpoints','learner_audio_account_producer_captures','learner_audio_upload_terminal_facts','learner_audio_upload_cleanup_commands','learner_audio_account_spoken_checkpoints','learner_audio_account_provider_calls'
      ]) required_name WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class relation
      WHERE relation.oid=pg_catalog.to_regclass($1 || '.' || required_name) AND relation.relnamespace=anchor.namespace_id
        AND relation.relowner=anchor.owner_id AND relation.relkind='r'))
    OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class sequence_relation
      WHERE sequence_relation.oid=pg_catalog.to_regclass($1 || '.learner_audio_fence_revision_v1')
        AND sequence_relation.relnamespace=anchor.namespace_id
        AND sequence_relation.relowner=anchor.owner_id AND sequence_relation.relkind='S')
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_depend dependency
      LEFT JOIN pg_catalog.pg_attrdef default_expression ON dependency.classid=pg_catalog.to_regclass('pg_catalog.pg_attrdef')
        AND default_expression.oid=dependency.objid
      LEFT JOIN pg_catalog.pg_class consumer_relation ON consumer_relation.oid=CASE
        WHEN dependency.classid=pg_catalog.to_regclass('pg_catalog.pg_attrdef') THEN default_expression.adrelid
        WHEN dependency.classid=pg_catalog.to_regclass('pg_catalog.pg_class') THEN dependency.objid END
      WHERE dependency.refclassid=pg_catalog.to_regclass('pg_catalog.pg_class')
        AND dependency.refobjid=pg_catalog.to_regclass($1 || '.learner_audio_fence_revision_v1')
        AND NOT (COALESCE(consumer_relation.relnamespace=anchor.namespace_id AND consumer_relation.relname IN
          ('learner_audio_owner_fences','learner_audio_delete_commands'),FALSE)
          OR (dependency.classid=pg_catalog.to_regclass('pg_catalog.pg_proc') AND dependency.objid=
            pg_catalog.to_regprocedure($1 || '.prepare_learner_audio_delete_private_v1(text,text,text,text,text[],text,integer,text)'))))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relnamespace=anchor.namespace_id AND c.relkind IN ('r','p','f','v','m')
        AND a.attnum>0 AND NOT a.attisdropped
        -- Guest source IDs; ordinary account/policy/lease owner fields have
        -- separate accepted authorities and do not reference guest identities.
        AND a.attname ~ '(^|_)owner_id$'
        AND c.relname NOT IN (
          'participation_owners','guest_credentials','guest_empty_owner_aliases',
          'participation_owner_clocks','guest_learning_preferences',
          'guest_participation_operations','guest_secret_issuance_operations','guest_attachment_intents',
          'study_sessions_v2','study_review_items','study_session_items_v2',
          'study_spoken_answer_commands','learner_audio_artifacts',
          'guest_resource_session_reservations','guest_resource_provider_calls','guest_resource_release_receipts',
          'learner_audio_owner_fences','learner_audio_delete_commands','learner_audio_delete_sources','learner_audio_delete_target_artifacts','learner_audio_object_names','learner_audio_upload_attempts','learner_audio_delete_batches','learner_audio_delete_batch_items','learner_audio_deleted_objects','guest_study_spoken_captures','guest_study_spoken_checkpoints','learner_audio_account_producer_captures','learner_audio_upload_terminal_facts','learner_audio_upload_cleanup_commands','learner_audio_account_spoken_checkpoints','learner_audio_account_provider_calls'))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_constraint fk JOIN pg_catalog.pg_class c ON c.oid=fk.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE fk.contype='f' AND fk.confrelid=ANY(ARRAY[
          pg_catalog.to_regclass($1 || '.participation_owners'),pg_catalog.to_regclass($1 || '.guest_credentials'),
          pg_catalog.to_regclass($1 || '.guest_empty_owner_aliases'),pg_catalog.to_regclass($1 || '.participation_owner_clocks'),
          pg_catalog.to_regclass($1 || '.guest_learning_preferences'),pg_catalog.to_regclass($1 || '.guest_participation_operations'),
          pg_catalog.to_regclass($1 || '.guest_secret_issuance_operations'),pg_catalog.to_regclass($1 || '.guest_attachment_intents'),
          pg_catalog.to_regclass($1 || '.guest_resource_session_reservations'),pg_catalog.to_regclass($1 || '.guest_resource_provider_calls'),
          pg_catalog.to_regclass($1 || '.guest_resource_release_receipts'),
          pg_catalog.to_regclass($1 || '.learner_audio_owner_fences'),pg_catalog.to_regclass($1 || '.learner_audio_delete_commands'),pg_catalog.to_regclass($1 || '.learner_audio_delete_sources'),pg_catalog.to_regclass($1 || '.learner_audio_delete_target_artifacts'),pg_catalog.to_regclass($1 || '.learner_audio_object_names'),pg_catalog.to_regclass($1 || '.learner_audio_upload_attempts'),pg_catalog.to_regclass($1 || '.learner_audio_delete_batches'),pg_catalog.to_regclass($1 || '.learner_audio_delete_batch_items'),pg_catalog.to_regclass($1 || '.learner_audio_deleted_objects'),pg_catalog.to_regclass($1 || '.guest_study_spoken_captures'),pg_catalog.to_regclass($1 || '.guest_study_spoken_checkpoints'),pg_catalog.to_regclass($1 || '.learner_audio_account_producer_captures'),pg_catalog.to_regclass($1 || '.learner_audio_upload_terminal_facts'),pg_catalog.to_regclass($1 || '.learner_audio_upload_cleanup_commands'),pg_catalog.to_regclass($1 || '.learner_audio_account_spoken_checkpoints'),pg_catalog.to_regclass($1 || '.learner_audio_account_provider_calls')])
        AND c.relnamespace=anchor.namespace_id AND c.relname NOT IN (
          'participation_owners','guest_credentials','guest_empty_owner_aliases','participation_owner_clocks',
          'guest_learning_preferences','guest_participation_operations',
          'guest_secret_issuance_operations','guest_attachment_intents',
          'study_sessions_v2','study_review_items','study_session_items_v2',
          'study_spoken_answer_commands','learner_audio_artifacts',
          'guest_resource_session_reservations','guest_resource_provider_calls','guest_resource_release_receipts',
          'learner_audio_owner_fences','learner_audio_delete_commands','learner_audio_delete_sources','learner_audio_delete_target_artifacts','learner_audio_object_names','learner_audio_upload_attempts','learner_audio_delete_batches','learner_audio_delete_batch_items','learner_audio_deleted_objects','guest_study_spoken_captures','guest_study_spoken_checkpoints','learner_audio_account_producer_captures','learner_audio_upload_terminal_facts','learner_audio_upload_cleanup_commands','learner_audio_account_spoken_checkpoints','learner_audio_account_provider_calls'))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE relnamespace=anchor.namespace_id
      AND relname IN ('guest_owner_associations','participation_eligibility_decisions',
        'megapot_owner_shares','megapot_owner_snapshot_leaves','megapot_owner_allocations',
        'reward_credit_persona_bindings','reward_credit_recipient_selections'))

)
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_class capture_relation
  WHERE capture_relation.oid=pg_catalog.to_regclass($1 || '.guest_study_spoken_captures')
   AND capture_relation.relnamespace=anchor.namespace_id AND capture_relation.relowner=anchor.owner_id
   AND capture_relation.relkind='r')
 AND (SELECT count(*) FROM pg_catalog.pg_attribute attribute
  WHERE attribute.attrelid=pg_catalog.to_regclass($1 || '.guest_study_spoken_captures')
   AND attribute.attnum>0 AND NOT attribute.attisdropped AND NOT attribute.attnotnull
   AND NOT attribute.atthasdef AND attribute.attidentity='' AND attribute.attgenerated=''
   AND attribute.attndims=0 AND attribute.atttypmod=-1
   AND ((attribute.attname='captured_platform_retention' AND attribute.atttypid='pg_catalog.text'::regtype)
    OR (attribute.attname='captured_retention_expires_at' AND attribute.atttypid='pg_catalog.timestamptz'::regtype)))=2
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_constraint shape
  WHERE shape.conrelid=pg_catalog.to_regclass($1 || '.guest_study_spoken_captures')
   AND shape.connamespace=anchor.namespace_id AND shape.conname='guest_capture_retention_shape'
   AND shape.contype='c' AND shape.convalidated AND shape.conislocal AND NOT shape.connoinherit
   AND NOT shape.condeferrable AND NOT shape.condeferred
   AND ARRAY(SELECT key FROM unnest(shape.conkey) key ORDER BY key)=ARRAY(
    SELECT attribute.attnum FROM pg_catalog.pg_attribute attribute
    WHERE attribute.attrelid=shape.conrelid AND attribute.attnum>0 AND NOT attribute.attisdropped
     AND attribute.attname IN('captured_platform_retention','captured_retention_expires_at','created_at')
    ORDER BY attribute.attnum)
   AND cardinality(shape.conkey)=3)
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_trigger retention_trigger
  WHERE retention_trigger.tgrelid=pg_catalog.to_regclass($1 || '.guest_study_spoken_captures')
   AND retention_trigger.tgname='guest_audio_retention_capture'
   AND retention_trigger.tgfoid=pg_catalog.to_regprocedure($1 || '.capture_guest_audio_retention_private_v1()')
   AND retention_trigger.tgtype=7 AND retention_trigger.tgenabled='O' AND NOT retention_trigger.tgisinternal
   AND retention_trigger.tgconstraint=0 AND NOT retention_trigger.tgdeferrable AND NOT retention_trigger.tginitdeferred
   AND retention_trigger.tgnargs=0 AND cardinality(retention_trigger.tgattr::smallint[])=0
   AND retention_trigger.tgqual IS NULL AND retention_trigger.tgparentid=0
   AND retention_trigger.tgoldtable IS NULL AND retention_trigger.tgnewtable IS NULL) AS valid,
 (SELECT phase FROM ${schema}.guest_learning_schema_phase WHERE singleton) AS phase FROM anchor`;

/** Initial PostgreSQL17 ACLs come from native initdb pg_init_privs entries, or
 * pg_catalog.acldefault for standard default-public routines. Critical restricted
 * overloads MUST have an initdb nonpublic entry; they are fixed review probes.
 * Never treat arbitrary current PUBLIC or owner capabilities as safe.
 */
export const catalogueBoundarySql = `WITH reachable AS (
 SELECT oid FROM pg_catalog.pg_roles WHERE oid=$1::oid
  OR pg_catalog.pg_has_role($1::oid,oid,'SET') OR pg_catalog.pg_has_role($1::oid,oid,'USAGE')
), baseline AS (
 SELECT p.oid,p.proname,p.proowner,p.proacl,
  i.objoid IS NOT NULL AS initdb_entry,
  EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(i.initprivs,pg_catalog.acldefault('f',p.proowner))) a
    WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS initial_public,
  EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
    WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS current_public
 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
 LEFT JOIN pg_catalog.pg_init_privs i ON i.classoid='pg_catalog.pg_proc'::regclass
   AND i.objoid=p.oid AND i.objsubid=0 AND i.privtype='i'
 WHERE n.nspname='pg_catalog'
), violations AS (
 SELECT b.oid::text AS object_oid,'unexpected_public_execute'::text AS reason
  FROM baseline b WHERE NOT b.initial_public AND b.current_public
 UNION ALL
 SELECT b.oid::text,'unreviewed_catalogue_function' FROM baseline b
  WHERE b.oid>=16384 AND EXISTS(SELECT 1 FROM reachable r WHERE pg_catalog.has_function_privilege(r.oid,b.oid,'EXECUTE'))
 UNION ALL
 SELECT b.oid::text,'restricted_effective_execute' FROM baseline b
  WHERE NOT b.initial_public AND b.oid<>pg_catalog.to_regprocedure('pg_catalog.pg_control_system()')
    AND EXISTS(SELECT 1 FROM reachable r WHERE pg_catalog.has_function_privilege(r.oid,b.oid,'EXECUTE'))
 UNION ALL
 SELECT b.oid::text,'catalogue_function_ownership' FROM baseline b
  WHERE EXISTS(SELECT 1 FROM reachable r WHERE r.oid=b.proowner OR pg_catalog.pg_has_role(r.oid,b.proowner,'MEMBER'))
 UNION ALL
 SELECT c.oid::text,'catalogue_table_mutation' FROM pg_catalog.pg_class c
 JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='pg_catalog' AND c.relkind IN('r','p','v','m','f') AND EXISTS(
  SELECT 1 FROM reachable r WHERE pg_catalog.has_table_privilege(r.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
    OR pg_catalog.has_any_column_privilege(r.oid,c.oid,'INSERT,UPDATE,REFERENCES'))
), probes AS (
 SELECT name,(SELECT count(*)::integer FROM baseline b WHERE b.proname=name) AS overloads,
  (SELECT count(*)::integer FROM baseline b WHERE b.proname=name AND b.initdb_entry AND NOT b.initial_public) AS restricted_overloads
 FROM unnest($2::text[]) AS names(name)
)
SELECT coalesce((SELECT jsonb_agg(to_jsonb(v) ORDER BY object_oid COLLATE "C",reason COLLATE "C") FROM violations v),'[]') AS violations,
 coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY name COLLATE "C") FROM probes p),'[]') AS probes`;
