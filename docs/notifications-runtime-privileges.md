# Notifications runtime privilege intake

This is a source review proposal and disposable-fixture proof, not a managed
role change. The existing production example is `db/postgres/roles.sql.example`:
the shared runtime receives existing-table SELECT/INSERT/UPDATE/DELETE and
forward table defaults SELECT/INSERT/UPDATE. New objects do not inherit DELETE.
Notifications adds invoker functions, not a privileged definer or a new binding.

The focused test creates four task-unique `notifications_acl_<random>` LOGIN
roles only on the dedicated disposable fixture. Their random role-only
passwords stay in memory and are removed with the roles, so the same fixture
can run under the maintained CI password authentication without reusing or
recording the administrator credential. Its forward role receives the
existing table default **before migration 0269 creates the new tables**. The
test executes real HTTP list/read transport and repositories, the actual Jobs
declaration/repository, and an account-status deletion that invokes the actual
Telegram fence and Notifications cleanup triggers. Authentication is an owned
principal fixture; this does not establish live session or serving acceptance.

Minimal fixture grants are explicit in
`tests/postgres/notifications-roles-fixture.ts`:

| Role class | Required Notifications permissions |
| --- | --- |
| HTTP | SELECT on inbox and authoritative privacy/route/persona/age sources; UPDATE(read_at) on inbox |
| Jobs | SELECT on inbox, processing receipts and authoritative ownership/privacy sources; INSERT on inbox/receipts; UPDATE(state,published_at,inbox_delivery_recorded) on outbox |
| Deletion | DELETE on inbox; SELECT on inbox/receipts/users; UPDATE(notification_id) on processing receipts; UPDATE(status) on users plus existing Telegram fence permissions |
| Shared runtime forward default | New-table SELECT/INSERT/UPDATE inherited from the existing default, then source-table grants; DELETE on inbox still requires explicit parent mediation |

Jobs' `SELECT ... FOR SHARE` on actor/recipient accounts also requires UPDATE
on at least one users column in PostgreSQL. The fixture grants UPDATE(status),
confining the existing shared runtime's broader UPDATE permission. This remains
a trusted database runtime capability, not an HTTP endpoint or an account
selection permission. Parent should retain the accepted serving-role pattern
rather than assume a read-only SQL login can take those locks.

Identity-generated inbox allocation succeeds without an explicit sequence
USAGE grant in this real fixture. The test does not grant it or invent a broader
sequence default. Parent must verify its final serving role and generator
schema, including any intervening schema/role changes in actual merge order.

The inherited broad receipt UPDATE is intentionally exercised: mutation fails
at the terminal/provenance trigger. HTTP cannot acknowledge an outbox fact or
delete an inbox. Even the deletion role cannot delete an active account's
inbox; the schema guard requires account erasure. The forward role can INSERT/UPDATE a subsequently created
probe table but cannot DELETE it. Deletion clears inboxes and nulls only their
receipt references while preserving immutable fact/outcome/processed time.

Do not apply managed grants from this writer. Parent owns final role admission,
default ACLs, baseline/catalog/index order and independent rerun. Required
cleanup grants must precede serving the new source: missing privileges cause
the account-status transaction to fail atomically. Source tests drop all four
logins and their task-schema grants after closing connections and dropping the
random task schema. No production role, global default ACL or managed credential is
created or altered.

## Candidate video control-plane ACL successor (unapplied)

The video audit candidate inspects each of its three actual table owners/ACLs
and strips PUBLIC and every non-owner table/column grant, including grants
inherited at creation from named forward defaults. It likewise strips PUBLIC
and all non-owner EXECUTE grants on the two audit mutators and the audit-run
trigger function. It changes no global or schema default privileges and creates
no roles, owner memberships or SECURITY DEFINER functions. There is no runtime
reader exception for private audit evidence or cutover receipts. Existing
publication identity/alias helpers remain a distinct producer permission.

Separate parent-reviewed operator grants are required **after** candidate intake.
These are object-relative role classes, not invented production role names:

| Operator class | Explicit privileges for the invoker workflow |
| --- | --- |
| Audit/materialization operator | Schema USAGE; SELECT/INSERT/UPDATE on audit runs; SELECT/INSERT on audit items; SELECT on media submissions, Posts, users, aliases, command replays and publication projections; UPDATE on one submissions/Posts column solely to permit existing row locks; INSERT on aliases; EXECUTE on start/process audit and require-identity/ensure-exact-alias functions |
| Migration/cutover operator | Separately trusted owner of the three replaced eligibility/guard functions and private receipt table; existing normal recovery privileges, SELECT on audit evidence/producer fences and required source relations, outbox/alias exclusion privileges. Cutover retains function-owner DDL and receipt insertion; the narrow audit operator receives neither cutover receipt access nor owner membership |
| HTTP/Jobs/deletion runtimes | No private audit/cutover table or audit-mutator privileges. Current video read paths additionally SELECT capture revisions/objects, accepted masters/render plans, song edges/visibility and the existing decision/rights/safety/persona sources; stable guard EXECUTE remains required |

Final role review must enumerate effective inheritance, owner membership,
superuser and delegated grants for the **actual** runtime identities. Revocation
cannot restrict an object owner, superuser or role inheriting the owner. None may
be a serving runtime; unresolved effective authority blocks admission. This
candidate neither assumes safe owner membership nor silently reconfigures it.
All SQL remains unapplied pending that independent final migration/role review.

`notifications-video-acl.pg-fixture.ts` adds UNRUN proof source to the maintained
Notifications partition: real separate LOGIN runtime/operator connections,
direct plus inherited named table/function defaults installed before candidates,
PUBLIC table defaults, actual forged complete-run/item/cutover DML and mutator
calls returning permission denial, an explicit narrow audit workflow on a real
published video, and the separately trusted migration LOGIN's maintained cutover
and exact replay. A subsequent unrelated table/function proves defaults remain
unchanged. The fixture never grants owner membership or runtime evidence access.
Its temporary role creation is test-only, not an operational/API capability.
Parent's predecessor20-case run completed the negative ACL attempts but failed
the LOGIN case at the first positive audit transaction: its ControlPlaneDb had
escaped the provided layer's lifetime and used an already closed session.
That failed case is not completed role/workflow proof. The successor runs the
entire audit action inside its operator layer, and drain/cutover/reconciliation
inside the separately trusted migration layer. No ACL or adapter is weakened.
Parent alone reruns and records the proof on fresh synthetic fixtures; the
repaired successor is UNRUN and no completed serving-role acceptance is claimed.
