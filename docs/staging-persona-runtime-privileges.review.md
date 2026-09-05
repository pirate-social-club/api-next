# Runtime privilege decision supplement

This is a coordinator proposal for owner review, not authority to apply grants.
The machine-readable table/sequence draft remains unchanged until this policy
is ratified and compiled into a complete manifest. Physical SQL identities must
be verified from staging; role names in repository examples are not live proof.

For the shared application runtime, retain the draft's schema USAGE, product
table SELECT/INSERT/UPDATE/DELETE and sequence SELECT/UPDATE/USAGE. Do not grant
schema/database CREATE, object ownership, grant option or product-table TRUNCATE.
This preserves the broad shared-runtime model, not a per-operation minimum.

Keep the observed table and sequence defaults, with an explicit final exception
for api_next.schema_migrations: runtime SELECT only, and revoke INSERT, UPDATE,
DELETE and TRUNCATE. The migration runner owns ledger writes and uses operator
credentials. Defaults must not silently grant ledger mutation back after replay.
The current positive-only reconciler does not implement this negative override.

Add shared-runtime EXECUTE only for
api_next.append_song_owner_policy_revision_v1(text,text,text,bigint,text,text,text).
At the pinned ba0fd445 source, song-owner-video-policy-repository.ts calls it
and the HTTP composition installs that repository. This is a requested explicit
grant, not assumed historical authority: the existing three-set reconciler must
still reject an unfulfilled grant until an approved policy permits it.

Do not grant observe_song_derivative_video_policy_v1 merely because roles.sql.example
lists it. At this release pin it has no production caller; the public read uses
SELECT directly. Do not grant the trigger-internal
enqueue_hns_root_import_teardown_job_v1 to the application role as a direct call.

The four HNS claim/finalize routines belong to the provisioner's dedicated
executor principal, not automatically to the application runtime:
claim_hns_authority_provision_job_v1(text,integer),
finalize_hns_authority_provision_job_v1(text,text,bigint,text,text,bytea,text,bytea,text,text),
claim_hns_root_import_observation_job_v1(text,integer), and
finalize_hns_root_import_observation_job_v1(text,text,bigint,text,text,bytea,text,text).
The provisioner's queue and observation-queue sources call them directly, and
its operational README describes a dedicated executor. Before capture, prove
whether a provisioner targets staging; if it does, include its direct SQL writer
in the maintained fence and review its actual principal separately. The four
Cloudflare Workers alone do not prove that an external SQL poller is fenced.

The reference review inspected exact pinned source and migrations 0101, 0106
and 0107. It made no live role observation and applied no permissions. The
initial staging ACL inventory contained no explicit non-owner routine grants;
do not assume the required new grant is already there or infer an existing
service's effective identity from a template name.
