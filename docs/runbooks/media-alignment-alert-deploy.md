# Media alignment alert deployment

Before deploying the jobs worker with the alignment-alert cursor, check the
database connection used by the intended environment's jobs worker. Check
staging and production separately. An admin connection or a role example in
the repository does not establish the serving role's effective permissions.

Run this read-only preflight as the jobs database user. The Hyperdrive adapter
uses `api_next,pg_catalog` as its transaction search path:

```sql
BEGIN;
SET LOCAL search_path = api_next,pg_catalog;
SELECT current_database(), current_user,
       has_table_privilege(current_user, 'api_next.recovery_inspection_cursors', 'SELECT') AS can_select,
       has_table_privilege(current_user, 'api_next.recovery_inspection_cursors', 'UPDATE') AS can_update,
       has_table_privilege(current_user, 'api_next.recovery_inspection_cursors', 'INSERT') AS can_insert;
SELECT last_identifier
  FROM api_next.recovery_inspection_cursors
 WHERE cursor_key = 'media-alignment-alerts';
ROLLBACK;
```

SELECT and UPDATE must be allowed. If the cursor exists, its identifier must
decode as JSON containing string `operation_id` and `workflow_instance_id`
fields. Existing progress is retained; do not reset it during deployment.

If the cursor is absent, INSERT must be allowed for first-run initialization.
If INSERT is denied, a database operator can create this metadata row before
deployment, without changing schema or submission/recovery authority:

```sql
INSERT INTO api_next.recovery_inspection_cursors
       (cursor_key, last_updated_at, last_identifier)
VALUES ('media-alignment-alerts', 'epoch', '{"operation_id":"","workflow_instance_id":""}')
ON CONFLICT (cursor_key) DO NOTHING;
```

The worker first locks an existing cursor and only attempts INSERT when it is
absent. A pre-seeded cursor therefore supports a SELECT/UPDATE-only serving
role. Repeat the read-only preflight after an operator insert. A missing or
malformed cursor without usable initialization is a deployment blocker.

Record the environment, checked role and database, privilege results, cursor
state, source SHA, and timestamp in the release evidence. Do not include
connection strings or passwords. The grants in `db/postgres/roles.sql.example`
are operational examples, not proof of live privileges.

After admission and merge, deploy the accepted source through
`scripts/deploy-worker-with-provenance.ts`. Verify that the alignment alert
scanner runs without `song_alignment_recovery_alert_scan_unavailable` and
continues to emit or suppress retained high-severity alerts. Fresh lookup and
storage failures must remain errors.

This rollout reduces repeated stored-failure logging. It does not repair the
verifier's origin 503s or reprocess a stranded media submission. Those require
verifier-host diagnosis and the separate audited media operator reprocess path.
