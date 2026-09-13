# Operator reprocess checkpoint

This is an uncommitted implementation checkpoint, not a completed recovery lane.
The user selected an operator-only command using existing database-admin access.
The command and usage procedure are in scripts/media-operator-reprocess.ts and
docs/runbooks/media-operator-reprocess.md. The database login supplies the audit
principal; request JSON cannot supply it. Preview is the default. Executing a
live queued recovery still requires the scoped operation and provider budget.

The transaction, atomic audit/event/outbox pairing, request replay/conflict and
revision fences are implemented. PostgreSQL tests cover concurrent requests,
rollback, audit tampering, preserved historical counters, continued decision
numbering, renewed analysis, and the actual command's admin denial and preview.
The automatic retry branch remains unchanged. Published authority is refused
rather than reopened. Existing publication/alignment reconciliation remains the
path for already-committed outcomes; a Workflow revision does not enter attempt
identity and must not be treated as a new provider allowance.

The public terminal failure reason was missing from the domain and response
contract. It is now wired through both, with a generated immutable 0.73.0 client
artifact and handoff. The existing 0.72.0 artifact is untouched. Solid adoption
is required before a paired release can expose the new reason to strict clients.

Exact receipt scope is in receipts.json. Raw logs remain at its named /tmp paths;
the digests identify those bytes but do not claim permanent log preservation.
No source commit was made because the full required test command is incomplete.
Do not report the clean 56-test receipt as a 57-test final-head receipt.

Resume with enough host headroom: verify the CI shard pin, run the combined
57-test media PostgreSQL suite, then complete check and test serially under a
memory cap. Restart only the owned disposable database if needed. Its existing
image is pinned PostgreSQL 17.11, host port 55439; no live database was used.
Record any migration/client-version collision before eventual integration.

DATA transaction/receipt reconciliation, the remaining recovery matrix and
composed effect-reuse evidence remain open. The broader lyrics/alignment and
karaoke, Study, and DATA acceptance on one song lineage remain open as well.
