# Notifications runtime privilege intake

This is a source review proposal and disposable-fixture proof, not a managed
role change. The existing production example is `db/postgres/roles.sql.example`:
the shared runtime receives existing-table SELECT/INSERT/UPDATE/DELETE and
forward table defaults SELECT/INSERT/UPDATE. New objects do not inherit DELETE.
Notifications adds invoker functions, not a privileged definer or a new binding.

## Completed local role proof — 2026-10-17 supersession

Parent ran exact source98 `6271bb2a8629bb35d9146f3602edb222196d921f505250ceab200a2de70adb53`
after independent preexecution acceptance: hardening6 passed418 assertions,
108.974427s whole-file wall, exit0/new exact fence/cleanup0|0|0; logSHA256
`a34e2283c8ee975fad2eb37b5dc8fdd1353480c9dc65e847d49b432e719c7eb9`.
All four SCRAM LOGIN classes completed effective private denials, real HTTP/read,
first Jobs and inherited-forward delivery, deletion/Telegram and history checks.
Native35 separately passed1348 assertions,229.024078s, exact fence/cleanup0|0|0;
its log and source receipts are bound in the [video handoff](notifications-video-source-handoff.md).
Wrong-password28P01/positive LOGIN controls passed. These completed local proofs
supersede the earlier UNRUN/unmeasured status; the prior5/1 failure and194323ms
observation remain historical. Imported-fixture changes require fresh measurement.
Required full/general6/recovery/HNS/PG18, final committed migration/role review,
actual serving-role authority, paired Solid, inventory/cutover and live holds remain.

## Current four-role proof boundary — 2026-10-17 supersession

Current merge order is Notifications0271, video destination0272 and private
alias audit0273; the cutover remains a separate operator-only candidate. This
dated section supersedes earlier provisional0269 and UNRUN/status descriptions
below without rewriting their historical receipts. No managed grant, role,
schema, runtime policy or cutover is changed by this local proof-source repair.

Historical predecessor: parent's exact incoming92/97 native35 SCRAM suite
passed1348 assertions with its
new exact fence (logSHA `dcfc4240da56fb5275b0bd90b6db5f218304cad915e757ab7655033652c69abd`).
The separate six-case hardening suite failed5pass/1fail/52 assertions, no marker
(logSHA `c1b1dc3807777dfe68703b76699a90ff96a94e3ad0b9f7742ffdc541f45ca6bd`).
HTTP list expected200 but returned500/notifications.list42501 before later
Jobs/deletion/default probes. Parent's separate non-owner SCRAM reproduction
observed the first denied relation `media_song_video_render_plans`; that is not
the complete dependency closure or a live-grant defect. Its history/index case
passed; that failed run supplied no successful hardening whole-file observation
or combined41 proof.
All parent diagnostic processes ended with zero clients/schemas/temporary roles.

**This four-role workflow completed in source98's hardening6 run above.** The existing
`exerciseNotificationRoles` now selects `withInbox(..., ..., "full_migrations")`.
The unchanged maintained initializer proves an empty unique schema (no application
relations/functions/types/ledger) before and after the existing pre-DDL role/default
callback, checks the same creator/scoped search path, loads checksums and applies
all0001..0273 with an empty expected ledger, then verifies the exact resulting
ledger/ownership. Parent text casts and final-migration guard remain unchanged.
There is no baseline first,0273 replay, forged ledger, disabled default or
fixture-owned ACL revocation. Ordinary behavior baseline policy stays unchanged.

`tests/postgres/notifications-role-access.pg-fixture.ts` owns explicit SELECT
grants on these reviewed invoker dependencies for HTTP, Jobs and forward runtime:

```text
media_publication_projections    media_post_submissions
media_video_publication_decisions media_video_analyses
media_video_revisions            media_immutable_objects
media_video_rights               media_video_safety_evidence
media_video_review_holds         media_song_video_render_plans
media_song_video_accepted_masters media_song_video_masters
media_video_song_references
```

The exact chain is readable_notification_source_v1 → authorized_comment_branch_v1
→ video_detail_access_v1. New explicit grants confer no media writes or audit
authority. Jobs read metadata also includes these13 relations and the existing
inbox read needed for delivery reconciliation; its schedule/run/writes/retry and
financial gating are unchanged. Existing source/privacy/age/persona reads remain.
HTTP retains only UPDATE(read_at) on inbox. Forward inbox/receipt SELECT/INSERT/
UPDATE must come from the existing pre-DDL table defaults, not explicit grants
that could disguise broken inheritance. Those broad shared-runtime defaults
remain trusted capabilities; this fixture neither narrows them by ad hoc revokes
nor proposes them as new serving authority.

Real distinct non-owner/non-superuser LOGIN connections verify effective EXECUTE
on authorized_comment_branch_v1(text,text), video_detail_access_v1(text,text),
video_detail_id_safe_v1(text), post_slug_utf16_code_units(text),
can_account_view_content_rating_v1(text,text), current_account_age_capability_v1(text)
and current_account_age_evidence_v2(text); HTTP additionally checks
readable_notification_source_v1(text,text), Jobs/forward deliver_comment_notification_v1(text)
and eligible_comment_notification_recipient_v1(text). Existing PUBLIC EXECUTE may
satisfy these exact functions. No blanket or new function grant is added; a failed
effective check must name the missing capability for parent review.

All four callers check effective table and column privilege absence on the three
private tables, function EXECUTE absence on the two audit mutators and audit-run
trigger function, no object ownership/owner membership, and actual42501 reads,
DML/complete-run/item/cutover forgery and function calls. Migration0273 must supply
the cleanup, including the forward defaults. No runtime receives operator grants.
Private operator workflow rights remain separate in the table below.

Required positives remain actual HTTP list/count/read, a fresh receipt-free and
inbox-free fact delivered for the first time by each real Jobs and forward LOGIN,
inherited inbox/receipt writes, terminal source/receipt mutation denial, an
unrelated fixture-owner-created table accepting forward INSERT/UPDATE and refusing DELETE,
HTTP source-ack/delete denial, and actual account-status-trigger erasure under
the existing Telegram grants. Erasure may only null receipt references; fact and
terminal history snapshots must remain identical. Test-owned synthetic missed
publication setup is unchanged; these checks create no new producer policy.
Source98 supplies the completed disposable first-time Jobs/forward/deletion/
private-denial proof. Actual serving ownership/inheritance remains held; no
local role fixture, prior native35 pass or source inspection clears it. The six/35-case
counts/fences,6000-history plans, deadlines/locks and capacity slice are unchanged.

The focused test creates four task-unique `notifications_acl_<random>` LOGIN
roles only on the dedicated disposable fixture. Their random role-only
passwords stay in memory and are removed with the roles, so the same fixture
can run under the maintained CI password authentication without reusing or
recording the administrator credential. Its forward role receives the
existing table default **before full0001..0273 application DDL**. The
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

`notifications-video-acl.pg-fixture.ts` supplies proof source to the maintained
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
Parent subsequently proved the exact73-path repair with20pass/560assertions and
the precise completion sentinel, including that controlled LOGIN workflow. Its
receipt remains distinct from the failed predecessor and from the current merge.
The current role case additionally performs real delivered-video list/read,
first-read replay, recovery/duplicate delivery and account erasure under the
non-owner runtime LOGIN, preserving terminal outcomes and nulling only the erased
inbox reference. Parent's fresh79-path35-case run passed this LOGIN case and the
other19 prior cases, but all15 new matrix cases failed at immutable persona
binding before their intended behavior (20pass/15fail/574 assertions, exit1,
no marker). In that earlier fixture, initial delivery used the administrative
fixture; empty
recovery and terminal replay do not prove first-time Jobs delivery privileges.
That positive role proof was then open; source98's separate hardening case now
supplies it locally. Parent later passed the exact80-path
35-case source, then generated baseline/reset/foundation-catalog artifacts. The
exact83-path run returned34pass/1fail/1259assertions,exit1,no marker: the ACL
case failed its first private-table privilege denial before the remaining
denial/operator workflow. The baseline strips privileges and lacks0273's one-shot
ACL block; existing functions previously caused that migration to be skipped.
This is fixture-initialization evidence, not a live ACL defect.

The ACL case alone now selects explicit full maintained migrations. It requires
catalog checks showing no relations/functions/types/ledger before and after
the unchanged pre-DDL callback creates its LOGIN roles, inherited membership and
hostile schema-scoped forward defaults. Admin and scoped connections must agree
on schema and creating role. The checksum loader supplies all0001–0273 and the
maintained runner receives an exact empty expected ledger. Exact resulting
ledger checksums and ledger/private-table ownership are verified before the
existing denial assertions and separate operator grants/cutover. No test-owned
revocations, defaults disabling or ledger fabrication are added. Existing
prepositive operator grant isolation and unrelated forward-default probes stay
unchanged. This initialization and controlled workflow completed in source98's
native35 run; baseline privilege parity and actual serving admission remain unproved.

Ordinary behavior fixtures continue using the privilege-stripped generated
baseline. This repair establishes no effective-privilege parity for baseline
replay and changes no generation/security-projection policy. Parent alone
executes fresh synthetic fixtures; actual serving-role ownership, inheritance,
final migration review and admission still require independent proof.

## 2026-10-17 current invoker erasure policy successor — UNRUN

This section supersedes earlier current-instructions wording about deletion
authority; historical receipts above remain unchanged. Parent's original109
general2 run failed192pass/1fail with42501: the pre0237 Telegram runtime can
UPDATE users.status but its SELECT/INSERT/UPDATE forward defaults omit DELETE
on the later0271 inbox. Even an empty inbox reaches that invoker DELETE and
rolls the account/Telegram transaction back. This is a real authority gap.
Parent's separate harness38 proof passed8/28 with both markers and all four
schemas absent; it did not prove wholePG, ACLs or this successor.

The separately delimited Notifications block in roles.sql.example adds only
DELETE on notification_inbox to the explicitly observed account-status executor.
Existing schema USAGE, SELECT on users/inbox and existing Telegram capabilities
remain prerequisites. It grants no receipt UPDATE, private evidence authority,
TRUNCATE, consent/money deletion, owner membership or forward DELETE default.
The prepared native test must establish that the FK's ON DELETE SET NULL and
immutable receipt guard work without a caller receipt-column UPDATE grant.

The maintained serving-function preflight now reads the effective Notifications
catalog facts from the same actual LOGIN connection and repeatable-read,
read-only transaction as its unchanged function admission. It observes effective
UPDATE(users.status); a status executor needs the direct, nondelegable inbox
DELETE and required SELECTs. Other callers must lack inbox DELETE. Missing
objects/guards, unexpected retained DELETE/TRUNCATE, private table/function
access, PUBLIC authority, unsafe defaults, inherited reachable authority,
owner-equivalence, elevated role flags or a changed session identity refuse.
These facts are read-only; the preflight never applies grants or creates roles.
Existing Telegram/function gates remain independently required.

Every existing account-status writer must be held by the parent throughout
migration271–273, bounded grant and effective preflight of each actual serving
identity. Inventory all such connections, including Jobs/forward roles whose
row-lock grant makes status writable. A flag or deploying a new Worker does
not fence an already serving old writer. No technical global fence is supplied
by this source repair; unresolved writer inventory or control blocks admission.

Prepared native proof is registered, **UNRUN on these bytes**:

- The old Telegram test now authenticates distinct SCRAM LOGINs. A genuinely
  empty owned schema is initialized by the maintained checksum loader/runner
  through0236, actual documented historical provisioning, then0237–0273.
  Empty expected and exact intermediate/final273-entry ledgers are checked;
  no baseline-first replay, forged ledger or private fixture revocation is used.
  All previous unlink/cleanup/consent/money/inheritance assertions remain.
- Hardening now requires7 completions and the unchanged exact marker. Its new
  case proves missing-authority atomic rollback for empty/populated recipients,
  the actual operator block, Telegram fencing, active-account direct DELETE
  refusal, receipt-reference-only nulling, retained receipt/fact/response bytes,
  repeat/recovery without resurrection, and restricted/default/inherited
  negatives. The existing four-role case also consumes the actual block and
  removes its former explicit receipt UPDATE. All six old cases remain.

Parent alone executes these SQL/LOGIN proofs and final serving inventory. Old
source98 six-case/35-case passes are historical, not these seven/39-case results.
Their larger transitive graphs require fresh whole-file planning observations;
no cost, shard, timeout, lock or sentinel bound changes were made here. Required
full gates, realPG/PG18/HNS/CI, final committed271–273 migration review, exact
client/paired consumer/serving acceptance and controlled cutover remain held.

## 2026-10-17 trigger-shape admission repair — native proof UNRUN

Independent core157 review found a static false-admission defect: guards_valid
checked enabled/function/owner/invoker bindings but omitted trigger shape, and
bool_and could ignore a NULL comparison when an expected function was missing.
Parent's full check/test later passed on exact core157; that receipt does not
close this finding or prove native erasure/ACL behavior.

The successor requires all four expected functions explicitly and coalesces
each complete required guard comparison to false before aggregation. It matches
retained0271 trigger event/timing/ROW bits, exact update columns, zero arguments
and empty argument bytes, no WHEN/transition relation, ordinary nondeferred
nonpartition-child status, and the existing function/owner/invoker/enabled checks.
users_delete_notification_inbox remains AFTER UPDATE OF status FOR EACH ROW
with no trigger WHEN; its deleted-status/changed-status condition remains inside
the unchanged retained function. Inbox/delivery retain BEFORE INSERT/UPDATE/
DELETE ROW coverage; fact immutability retains BEFORE UPDATE/DELETE ROW coverage.
No migration, function body, grant, receipt UPDATE or operational authority changes.

The existing seventh erasure case now calls a focused catalog fixture after the
bounded grant and before normal restricted-LOGIN erasure positives. Forty
committed owner-side perturbations cover each guard's missing trigger/function,
UPDATE, timing, ROW, WHEN, arguments and update-column restrictions; relevant
DELETE/INSERT omissions, unrestricted users UPDATE, rebound and combined
missing/rebound function cases are distinct. Only catalog reads occur while
guards are weakened. The real LOGIN must see guards_valid=false on every row,
refusal specifically for guards, and all other capability facts unchanged.
Each variant restores the captured definition and retained function OID/name/
owner once, then verifies the complete catalog/capability snapshot before the
original FK/history/denial workflow. Cleanup failures preserve the primary error.

All forty catalog negatives and normal native positives remain **UNRUN**.
Hardening7, native39, feed6, Telegram1 and exact markers/bounds remain unchanged.
Fresh independent successor readiness, parent realPG/full gates/timing/CI,
final committed271–273 review, immutable0.122/consumer/paired serving and
history/alias/drain/cutover admission remain required. Existing writer-control,
Rewards/pilot/financial/credential/physical-proof/MainnetSafe STOP holds remain.
