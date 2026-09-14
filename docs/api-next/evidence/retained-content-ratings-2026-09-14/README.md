# Retained content rating reconciliation

Migration 0186 adds private retained-evidence assessments, immutable operation
and event history, guarded current pointers and unresolved-publication holds.
The operator command defaults to a read-only bounded plan. Apply requires its
exact hash in a serializable transaction and never republishes hidden content.
Current adult floors are raised without rewriting submission responses, original
moderation decisions, or prepared DATA metadata. Unknown evidence stays held.

The PostgreSQL proofs cover valid adult/general categories, malformed or missing
bindings, complete versus incomplete video input evidence, immutable text
response hashes, old adult signals with a general publication rating, a hidden
post whose source still records its original publication, blocked moderator
release, dry-run/apply through the actual CLI, exact replay, stale-plan refusal,
and complete rollback. Fourteen tests passed with 124 assertions. The generated
baseline is current at 182 migrations; full check, all 4,167 unit tests and all
20 Node tests passed. All five Worker configurations passed (82, 74, 2, 10 and 15 tests). Expected negative-path runtime diagnostics remain in the separate workerd log.

The first migration draft had a CASE expression syntax error; the corrected
baseline succeeded. A later checksum edit used the wrong manifest key and the
next generator correctly refused the mismatch before writing. Another inventory
check ran before the new suite was marked intent-to-add and correctly rejected
the tracked-file mismatch. Those failed attempts and their successful successors
are retained, rather than counted as passing gates.

The source manifest identifies the validated product and operator files. The
schema dump moves existing tables to satisfy the new view dependencies; it does
not remove them. The exact text rating-only repair bypasses the publication
relation recheck only when every other transition field is unchanged, allowing
an already-hidden resource to retain its historical submission status.

No production database was reconciled. Full PostgreSQL partitions, additional
database-bound media/derivative proofs and real-provider staging acceptance
remain separate release obligations. Nothing was pushed, enabled or deployed.
