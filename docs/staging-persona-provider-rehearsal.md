# Provider rehearsal evidence

This is not the final recovery copy. Branch persona-reset-rehearsal-20260906
(0ny029b910ob) restores the unfenced rehearsal backup xvvo8r6tcaa5 from staging
main syu03e00w3ux. Its only purpose is restore fidelity and phased-runner/failure
rehearsal on the provider. No Worker should be routed to it. The final live
reset still requires a new verified capture inside the continuous producer
fence.

Retention is bounded: retain through the current rehearsal, then delete with
a provider receipt. The coordinator must review or delete it by
2026-09-07T04:00:00Z; extending that deadline needs a recorded reason and new
date. It is billed at PS_5_AWS_ARM and must not remain as an accidental second
staging environment. This is a recorded deadline, not an automated expiry.

## Restore fidelity, 2026-09-06

Provider role-list metadata was empty. That did not imply lost PostgreSQL
roles. An initial isolated default-credential command returned a CLI shape the
observer did not accept, so no SQL connection followed. The documented raw
reset-default endpoint then issued a credential bound to this isolated branch.
These two credential operations affected only the rehearsal branch; values
were kept in process memory, not printed or persisted. No source credential
was rotated. The default role could read the restored catalog but did not own
api_next, so it was not used to change grants or ownership.

The original runtime and operator passwords subsequently authenticated through
the provider-confirmed restored hostname with this branch's username suffix.
SQL session identities matched the original roles. Thus the restored SQL roles
and credentials survived even though provider role-list metadata was empty.
The reset must continue as the operator, not substitute the default role.

Operator inventory at 04:20:15 UTC confirmed all 109 ledger checksums against
the pinned manifest. All 1,204 relations, 362 routines and 660 types were
effectively owned; schema USAGE/CREATE and ownership were available. There
were 5,933 ACL entries and no explicit column ACLs. The two defaults remained
operator-owned and runtime-granted, without grant option, with digest
f0973701f1b93a794190b0a16ab24126ff6bda647a0d4476f6a00f9d75b2329d,
matching the recorded staging observation.

Installed extension names, versions and namespaces matched staging:
btree_gist 1.8 in public, hypopg 1.4.2 in pscale_extensions and plpgsql 1.0 in
pg_catalog. None needed reinstalling in this observed restore. This is measured
behavior for this branch, not a promise about future provider restores.
Settings were max_locks_per_transaction=64, max_connections=25 and
max_prepared_transactions=0, matching the low-capacity local rehearsal.

The exact pinned 0110 evidence-function prefix was installed inside a bounded
transaction solely for the evidence read, then rolled back. The result was
unbound=2, single-community=3, multi-community=1 and digest
85a756a5f36bcbdec2ce55b9cb108baa82a035e9fdec1761d82819e4861f7817,
exactly matching recorded staging evidence. The ledger was verified against
0109 again after rollback. No binding table or migration was applied.

## Outstanding proof

These observations pass the requested initial ledger/persona/default-ACL/
extension/role checks. They do not prove a complete data-bearing restore
comparison, a successful phased reset or recovery after committed removal.
The provider-safe rehearsal entrypoint and independent review remain before
destructive execution. Do not bypass the local-test URL guard or substitute
invented fence/recovery callbacks. The approved reset remains pinned through
0119. The separately approved follow-on below does not amend those artifacts.

## Reproducible data fingerprint

The fixed-branch read-only command is
`bun scripts/staging-persona-rehearsal-inventory.ts --read-only`, under the
existing staging operator-secret injection. It resolves the exact provider
branch before remapping either original credential, verifies both SQL roles,
checks the 0109 catalog, and emits metadata and hashes only. It does not invoke
the reset, accept a caller-selected host, or broaden the local-test URL guard.

Table rows are hashed inside PostgreSQL in one repeatable-read snapshot;
row hashes are ordered before aggregation, preserving duplicate multiplicity.
Sequence value/called state is fingerprinted separately and requires producer
quiescence for a stable recovery comparison. Foreign tables and materialized
views are refused rather than silently omitted. Relation/row limits and
statement timeouts bound the scan. No data rows or per-row hashes are emitted.

At 04:34:12 UTC and again at 04:37:46 UTC, the restored branch contained 329
tables, 155 nonempty tables, 34520 rows and two sequences, with aggregate digest
0b1c97ef5efa0d32eee31cf220e9d5a41f74c7cfecbe782c03f16caaf2628bf8.
The second run followed independent-review fixes pinning the provider API
origin and refusing materialized views. Both scans are read-only observations,
not proof of a maintained fence. Retain this fingerprint for comparison after
the provider failure/restore exercise; do not replace it with fresh empty-state
evidence from a successful reset.

## Separate follow-on release

The owner accepted two releases inside one continuously fenced window. First
reconstruct through 0119 from ba0fd44529d834f491879126cdb8c67c4ec9fcdc,
deploy that API with Solid fa5ce5eff47967efb5f13c04de01e75293d3e230, and
verify the reset result. Then run the ordinary migration runner from
386be35a87163bd6b93ab49c41666a7442fd17e2 and deploy that API, leaving Solid
unchanged. This is not permission to replay a newly generated reset plan or
use a moving main branch.

The follow-on checksum manifest has SHA-256
bf5d4707e639104b855a77d40ab809934acd3bc372377d023d8eb5d513bf9de2.
Its first 119 entries match the approved reset. The two added migration files
were independently hashed: 0120_hns_root_health_renewal_recovery.sql is
c4cf5757d3c6951502186637398504df7b9be02ecbff1b7c30819bb226ada399;
0121_hns_imported_inventory_renewal.sql is
3d83fb50b91572af79780bd80deff588aa4d5a8b00f14c3f410793d57bca2977.
The ordinary runner must observe the exact completed 0119 prefix before
applying the two pending migrations.

The recorded production source review found no persona contract change across
this follow-on. This is compatibility evidence, not a new authenticated test.
The maintenance fence must survive both ordinary API deployments, with final
schema, runtime-privilege and serving-pair checks before traffic resumes.
Replacing a maintenance Worker with a normal Worker does not itself preserve
the ingress fence. Neither release nor the destructive provider rehearsal has
executed at this checkpoint.

## Session observation, not admission

A read-only check at 04:49:15 UTC on the exact rehearsal branch matched the
operator identity, observed zero runtime sessions and zero prepared
transactions, and counted two other database sessions. The operator had
neither pg_read_all_stats, CREATEROLE nor direct ADMIN OPTION on the runtime
role. No privilege was changed.

The strict local observeSessionDrain helper cannot be the provider gate: it
requires full statistics privileges and no other sessions. PostgreSQL exposes
session existence, user and database without full query visibility; see its
[statistics visibility rules](https://www.postgresql.org/docs/17/monitoring-stats.html).
Those counts remain point-in-time evidence, not proof that reconnects are
prevented. Do not request broader privileges merely to satisfy this helper.
The provider rehearsal still needs actual branch/producer exclusion checks;
per-batch locks and the failed-run marker do not supply that maintained fence.

## Provider baseline disposition and isolated entrypoint

The owner explicitly classifies pscale_admin as provider substrate, not an
application writer. The 05:00:26 UTC comparison found two such sessions on
each branch, with the same two application-name fingerprints:
4d610df279c4c8ef752e6ce9ba073967a3ea23cc7d09024922ac9da4f17cf930 and
a2f5ec7abc29f65a8dfc0527aaca0fe6140718ccec2828d243c8ada40c5fe7e3.
Client address, backend type and start time were hidden on both branches;
no address-range comparison is claimed. Main had 19 total sessions and the
rehearsal branch had three, including the observer. Both reported 64/25/0,
six non-fast-path lock rows and zero sampled provider lock rows. These are
samples, not lifetime maxima.

The fixed isolated entrypoint is scripts/staging-persona-provider-rehearsal.ts,
with --dry-run or --execute. It measures the pinned baseline in a generated
local PostgreSQL 17 database, checks backup xvvo8r6tcaa5 still names restored
branch 0ny029b910ob, checks the original data fingerprint and approved defaults,
and verifies that staging Hyperdrive remains on main. It uses only the original
operator for reconstruction. The runtime credential is used solely for a fresh
identity probe, then closed. No caller-selected provider URL is accepted.

During reconstruction an independent operator connection samples locks. The
session check permits only the two known runner PIDs and the exact observed
provider application baseline. Unexpected sessions, prepared transactions or
capacity changes fail the run. Provider sessions are included in headroom:
reserve 64 entries per observed connection plus two extra connections, and cap
the remaining cluster budget at the previously reviewed 1200 rows. Each reset
transaction remains bounded at 1000 own lock rows and removal dependency closure
800. Sampling can miss transient peaks; receipts say so explicitly.

The fixed host marker is outside the reset schema. It remains after a successful
isolated run because no paired release happened there; a failed run cannot
resume. The command neither deletes that marker nor restores or deletes provider
resources. A second destructive rehearsal requires restoring the original
capture and recording the resulting provider branch identity before admission.
The live staging maintenance implementation is separate and is not a
prerequisite for this owner-dispositioned isolated rehearsal. Post-reset checks
do not prove absence of every possible concurrent write.

The first entrypoint dry run passed on 2026-09-06. It measured independent
baseline shape 2e295e58b965fd73e73167c1b6628efe28115fd01386d3fd155b104ba0d432fd,
reconfirmed the original data fingerprint and observed two provider plus two
known operator sessions, six shared-lock rows and the derived cluster budget
1200. It created and removed only its generated local reference database; it
made no provider data changes. Check passed with 41 baseline warnings; focused
tests passed 14/14 with 69 assertions; the full unit suite passed 3038/3038
with 12988 assertions across 473 files. No full Worker or PostgreSQL-suite
rerun is claimed for this entrypoint checkpoint.

## Partial execution and recovery, 2026-09-06

Execution at 0cbfa9073cbd369b21833d0440fd0c997f5bf896 against isolated
branch 0ny029b910ob failed after five committed removal batches. The failed
marker reports completedBatches 5 and refuses a new run without contacting
the database. No resume is permitted. The generic error wrapper discarded
the specific cause; neither lock exhaustion nor provider sessions have been
established as the cause. Completed callbacks sampled at most 389 shared locks,
but transient peaks and the failing batch are not covered by that number.

The execution log is retained under the control-plane .state directory at
staging-reset-rehearsal/0ny029b910ob/evidence/execution-0cbfa907.log, alongside
the retained failed marker. Replacement branch persona-reset-recovery-20260906,
id k1d9pj5znk6t, was restored from backup xvvo8r6tcaa5 and reports ready.
Its restore fidelity remains under verification. Its default provider role
credentials were initialized solely to obtain connection metadata; returned
credentials were discarded and existing operator/runtime identities are used
for fidelity checks. This mutation affects only the replacement branch.

Both rehearsal branches remain subject to the 2026-09-07T04:00:00Z review or
deletion deadline. Neither branch is a final fenced staging recovery capture.
Staging main and production were not changed. A real partial failure has
occurred, but successful reconstruction and the deliberate between-replay-batch
failure rehearsal are not yet proven.

At 2026-09-06T05:32:59.970Z the replacement passed the read-only ledger,
ownership, ACL, default-ACL, extension and data comparisons. All 109 ledger
checksums match; 329 tables contain 34520 rows, with 155 nonempty tables and
two sequences. Data fingerprint remains
0b1c97ef5efa0d32eee31cf220e9d5a41f74c7cfecbe782c03f16caaf2628bf8.
Ownership, schema ACL, 5933 ACL entries, both default ACLs and extensions all
match the original capture fingerprints. Original runtime and operator
credentials authenticate on the replacement. The separate rolled-back 0110
evidence-function check remains outstanding; no full recovery sign-off or
successful reset is claimed by these comparisons.

At 2026-09-06T05:42:04.915Z the remaining evidence check passed on k1d9pj5znk6t:
unbound 2, single-community 3, multi-community 1, with digest
85a756a5f36bcbdec2ce55b9cb108baa82a035e9fdec1761d82819e4861f7817.
Only the two pinned evidence functions were installed inside a transaction,
then rolled back; all 109 ledger checksums were rechecked unchanged. This
completes the original-capture fidelity checks after the real partial failure.
The next isolated attempt is fixed to this replacement branch and a new marker
directory with its exact branch id. The old failed marker is retained. No
retry rule, lock-budget change, reset artifact pin or live-staging authority
changed with this target update.

## Second refusal and provider-session classification correction

The b77411a9 attempt on k1d9pj5znk6t committed seven removal batches and then
refused with SQLSTATE null and message fingerprint
b0eb3cf8cba5a4d1666aa09a5f0b8f81da1a4e01f0ae2cd513b8067f9fe96ef0.
This maps exactly to rehearsal_session_baseline_changed. The old combined
guard does not identify the particular session-list difference. Observer
failure was null, with 347 samples and peak sampled own/shared locks 389.
No SQL lock exhaustion, lock timeout or dependency failure is established.

The corrected guard classifies known provider application fingerprints rather
than requiring exactly two processes. Unknown roles/applications and missing
runner PIDs still refuse, with distinct diagnostics. The current session count
recomputes the sampled cluster limit before/after each batch; the 1000 own-lock
ceiling must still fit with the reserved session headroom. Initial admission
also requires observed shared locks plus that ceiling to fit. No retry is added.
Focused tests passed seven tests with 24 assertions and independent review
found no unsafe weakening. Full check passed after correcting an import-order
error; unit tests passed 3041 with 13000 assertions across 474 files, and Node
tests passed 20. The general Worker pipeline was interrupted to enforce serial
execution; the explicit one-worker base suite then passed 11 files/73 tests.
Other Worker suites remain in progress and no new full PostgreSQL result is claimed.

Third restored branch un1u2oawdweg, persona-reset-rehearsal-r3-20260906, is the
new fixed target. At 05:53:46Z its data/ledger/ACL/extensions matched the
original capture; the subsequent rolled-back evidence check matched 2/3/1
and the original digest with all 109 checksums unchanged. Its default metadata
credential initialization was branch-local, with returned secrets discarded.

After that verification, failed branch 0ny029b910ob was deleted at
2026-09-06T05:56:06.141Z and k1d9pj5znk6t at 05:56:08.726Z. Their marker/log
directories and backup xvvo8r6tcaa5 are retained. Exact provider IDs, database
mvydkmmwh5x4 and restore source syu03e00w3ux defined the authorized targets;
the provider metadata production flag was true even on these isolated staging
restore branches and was not treated as the product environment identity.
The remaining third branch keeps the 2026-09-07T04:00:00Z review/delete deadline.

## Third refusal and fourth restored target

The 5f2efc58 attempt on un1u2oawdweg committed five removal batches before
rehearsal_provider_application_changed refused continuation. SQLSTATE was null;
the message fingerprint was
0ffc8508d81bfba185be8faf68c5207f5a08ebcbfd19d517a2f5d2960bd249f7.
The observer reported no failure, 326 samples and maximum sampled own/shared
locks of 389. This was a provider application-label classification failure,
not evidence of lock exhaustion. The failed marker and execution log remain
under the branch-specific staging-reset-rehearsal evidence directory. Never
resume this branch.

The revised guard verifies the exact pscale_admin role and its superuser,
replication, create-role, create-database and login flags on every observation.
Application labels are evidence rather than authority; changed or null labels
do not make a verified provider session into an application producer. Unknown
roles and unowned operator sessions still refuse, both runner PIDs remain
required, and observed session counts continue to reduce the lock budget.
Read-only catalog checks on the failed branch and staging main confirmed all
five role flags. Sixty subsequent read-only observations passed; they did not
observe a label rotation, which is covered by unit tests instead.

The fixed admission lifetime is two hours, determined before execution and
never extended during a run. About 700 removal roots at the measured batch
duration plus 119 replay batches can exceed the previous one-hour window.
Backup retention must cover the full admission lifetime.

Fourth target pxo3svqjoxvn, persona-reset-rehearsal-r4-20260906, was restored
from backup xvvo8r6tcaa5 at 2026-09-06T06:08:16.557Z. At 06:12:15.600Z its
109 ledger entries, 329 tables, 34520 rows, two sequences, ownership, ACLs,
default ACLs and extensions matched the original capture fingerprints above.
The separate rolled-back evidence check reproduced 2/3/1 and the original
digest, with all 109 ledger checksums unchanged. Default-role metadata was
initialized only on this branch and returned credential values were discarded.
This remains an unfenced rehearsal capture, not live-reset recovery evidence.
The review/delete deadline remains 2026-09-07T04:00:00Z.

After the role-classification correction, the full check passed with 41 baseline
warnings and all 3042 unit tests passed with 13014 assertions across 474 files.
Before that operations-only correction, the four Worker configurations passed
serially: 11 files/73 tests, 15 files/48 tests, one file/two tests and six
files/nine tests. Node tests passed 20. No fresh full PostgreSQL or
secret-boundary suite result is claimed. Successful full provider replay and
the deliberate between-replay-batches recovery exercise remain outstanding.

While the fourth attempt runs on its loaded 8aaab120 source, an additional
local failure-injection test exposed a diagnostic ordering gap: after replay
batch one, a rerun refused because a policy routine was absent before reaching
the existing marker. The follow-up checks marker presence before database
inspection while retaining exclusive marker creation as the race-safe gate.
The PostgreSQL 17 test now passes with nine assertions, proving the one-entry
ledger remains unchanged on rerun. Three marker tests pass with 13 assertions,
including malformed files, broken symlinks and filesystem errors. Independent
review accepted the ordering change. Full check passed with the same 41
baseline warnings, and the changed-script gate reports zero findings.
This local test does not substitute for the separate provider recovery exercise.

The fourth attempt stopped after 109 committed removal batches. The retained
failed marker has run a618aadf-48e1-493f-a120-6fcddc53e009 and completedBatches
109. SQLSTATE was null and fingerprint
6d338de8ed578f24e6b98a8822b69e816f145a4c91869534844e7117218c100b
maps to rehearsal_unexpected_session. The observer reported no failure in
2458 samples; maximum sampled own/shared locks were 739/740. The exact
unexpected session was not retained by the diagnostic wrapper. A subsequent
read at 2026-09-06T06:35:21.214Z saw only the two recognized provider sessions
and its own operator connection, so it cannot identify the vanished session.
No lock failure, provider identity or alternative producer is inferred.
The log is preserved in the branch-specific evidence directory as
execution-8aaab120.log. This incomplete attribution does not justify resuming
or relaxing session admission. A further isolated diagnostic attempt must
preserve the exact rejected observation before returning the failure.

The complete local phased suite then passed five tests with 369 assertions,
including both interrupted-replay refusal and data-bearing restore. All 3043
unit tests passed with 13018 assertions. These results do not establish a
successful provider reset. Both remaining isolated branches retain their
existing review/delete deadline; the backup remains unchanged.

Afterward, 180 read-only observations on the failed branch saw no unexpected
session, so the cause remains unidentified. The next diagnostic change retains
PID, owned-PID flag, role hash and application hash at the exact refusal,
without raw names, queries or credentials. All admission checks are unchanged;
nine focused tests passed with 43 assertions and independent review accepted
the diagnostic-only change. A fifth isolated restore was requested from the
same backup for this purpose; it is not a live-staging reset or a recovery
capture taken under a live fence.

The fifth target is abkmnvey02z5, persona-reset-rehearsal-r5-20260906, created
at 2026-09-06T06:42:42.027Z from the same backup at PS_5_AWS_ARM. Branch-local
default-role metadata was initialized at 06:44:23.599Z with returned
credentials discarded. The fixed entrypoint and marker path now name this
branch only. Read-only fidelity remains required before execution. The
review/delete deadline remains 2026-09-07T04:00:00Z; no deadline was extended.
