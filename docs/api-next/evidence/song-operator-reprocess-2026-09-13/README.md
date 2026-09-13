# Operator reprocess checkpoint

The implementation was preserved in WIP commit 916a499c, not declared complete.
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
The workspace_owner authorized checkpoint commits with incomplete verification.
Do not report the clean 56-test receipt as a 57-test final-head receipt.

The subsequent budget correction records an explicit before/after reset to zero,
requires audited zero-sequence launches, and lets finished workflows reconcile or
escalate even at the automatic replacement ceiling. Its two new PostgreSQL cases
bring the planned suite to 59 tests. They have not run. The correction passed the five migration-manifest tests and
eleven sweep unit tests (16 total, 35 assertions, exit 0) under a 512 MiB, one-CPU
scope; Biome passed on the five touched TypeScript files. Earlier receipts do not
verify this changed SQL or its behavior. The generated schema and reset baseline
still reflect the earlier checkpoint and must be refreshed before database proof.

In a coordinated heavy-job window, refresh the baseline, verify the CI shard pin,
run the combined 59-test media PostgreSQL suite, then complete check and test
serially under a memory cap. The sentinel shard edit remains unverified until a
hosted CI run passes; local discovery is insufficient. Restart only the owned disposable database if needed. Its existing
image is pinned PostgreSQL 17.11, host port 55439; no live database was used.
Record any migration/client-version collision before eventual integration.

DATA transaction/receipt reconciliation, the remaining recovery matrix and
composed effect-reuse evidence remain open. The broader lyrics/alignment and
karaoke, Study, and DATA acceptance on one song lineage remain open as well.

DATA prevention checkpoint after 6915ae65: the adapter now distinguishes finished
and indeterminate instances from confirmed absence. Both the scheduled sweep and
the replacement helper's second status read refuse to replace either. The budget
ceiling limits replacement writes, not terminal inspection. The new adapter and
sweep assertions failed before the change; the three focused suites now pass
14 tests with 63 assertions and exit 0. Biome passes on the six touched files.
This is prevention only. Receipt reconciliation and full integrated gates remain
open, and no database or provider was called for this checkpoint.

Final integrated recovery receipt — 2026-09-13. The recovery repair is complete
on this branch at 2c174aa0. DATA terminal reconciliation is implemented at the
store and sweep seams. A finished Workflow is never replaced: the sweep calls
reconcileTerminalWorkflow with the candidate's exact operation and workflow
revision, and the store resolves the durable row from its persisted transaction
identity and receipt observations. A reverted receipt records the
receipt_reverted failure. A confirmed receipt escalates to
reconciliation_required through the existing failure commit, because the
observation does not carry the completion evidence the fence needs: a song's
attached terms are written with the registration itself, and the
media_publication_projections update guard compares canonical_audio_sha256
against the DATA operation while the video projection shape requires NULL, so
receipt-only completion is inadmissible for both media kinds today. Pending and
unavailable evidence leave the durable row untouched and never authorize a
replacement; a moved workflow revision is stale; repeats and concurrent calls
return the same disposition with exactly one committed transition. The
maintenance counts report reconciled, reverted, escalated, pending and
unavailable separately.

Migration allocation was rechecked at integration time. origin/main and the HNS
entry lane reach 0172; the nationality lane holds 0173-0175 and the telegram
lane holds up to 0175. The lane migrations are 0176
(media_workflow_terminal_escalation), 0177 (media_operator_reprocess_actions)
and 0178 (media_operator_reprocess_transition); the checksum manifest carries
exactly those three digests and the manifest suite passes 5/5. The 0178 guard
carried a stale check requiring the operator transition to advance the
replacement sequence while the same function required the budget reset to zero,
so every operator update was rejected on first database contact. The corrected
guard requires the zero reset and binds it to the audit, event and launch, with
the automatic retry branch unchanged. The schema and test-reset baselines were
regenerated from the full sequence, and check:baseline:fresh exits 0 after the
foundation table catalog was brought up to date.

PostgreSQL receipts at 2c174aa0 against disposable PostgreSQL 17.11:
scripts/postgres-migrations.ts applied 0001-0178 to a fresh database with exit
0 and current version 0178_media_operator_reprocess_transition.sql;
media-persistence.pg.test.ts ran 60 tests with 0 failures, 1001 expect calls
and exit 0 in 107.71 s, covering operator reprocess concurrency and replay,
atomic audit/terms/event/launch rollback, command admin authorization, the
spent-budget reset with unchanged historical outboxes and attempts, the
database-level concurrent replacement fence, terminal reconciliation, launch
eligibility and egress; data-registration-repository.pg.test.ts ran 6 tests
with 0 failures, 104 expect calls and exit 0 in 19.87 s, covering the DATA
unavailable, pending, reverted and confirmed dispositions, stale authority,
replay, concurrent recovery and the existing pin, attempt, receipt and parent
fences.

Repository gates at the same head: bun run test:unit ran 4,043 tests across 588
files with 0 failures and 25,122 expect calls; bun run check exits 0 through
knip, the effect diagnostics, Biome, both TypeScript programs, the binding and
persona programs, the dependency and boundary lints, the migration worktree
check, contract freshness and api-client verification. The CI sentinel shard
pins were recomputed to shard 3 for both song-video suites; only a hosted run
can verify them on CI, and no publication, deployment or paid provider call
occurred.

Still open outside this lane: the operator resolution surface for DATA
reconciliation_required rows (no command or endpoint yet), the confirmed-video
projection fence gap recorded above, and the broader song acceptance evidence
on one song lineage for lyrics/alignment/karaoke, Study and DATA.

Confirmed recovery completion — 2026-09-13. Review held the earlier completion
claim too broad: confirmed DATA evidence escalated instead of completing and
the escalation had no executable resolution. Both gaps are closed on this
branch.

Migration 0179 persists the terms a confirmed song attached with the receipt
observation that carries its registration, makes the publication projection
guard and the store's confirmation projection update follow the media kind,
and adds the data_operator_resume_actions audit with its binding triggers.
Terminal reconciliation now completes a confirmed song from its persisted terms
and a confirmed video through the media-kind fence, through the existing
confirmation fence. The attempt keeps its exact transaction identity, no
signing or broadcasting occurs, and no replacement launch is emitted. A
confirmed observation recorded before the terms were persisted still escalates;
terms are never invented.

reconciliation_required rows have an executable, authorized resolution.
scripts/data-registration-operator-resume.ts requires database-operator
authority, previews by default, and returns the existing attempt to observation
under a fresh workflow revision with a pending replacement launch. The audit
row, attempt state, revision and launch commit together behind the binding
trigger; the audit is append-only; repeated requests replay their original
result; changed contents conflict and stale revisions are refused. The runbook
is docs/runbooks/data-registration-operator-resume.md.

PostgreSQL receipts at 824cdab5 on disposable PostgreSQL 17.11:
data-registration-repository.pg.test.ts ran 10 tests with 0 failures, 135
expect calls and exit 0 in 62.64 s. It proves confirmed song completion from
persisted terms with exactly one launch and one attempt and six append-only
transitions, confirmed video completion through the media-kind projection
fence, legacy confirmation escalation, operator resume concurrency (one
resumed and one replay) with one audit and one launch, unauthorized transition
and orphan audit rejection, stale revision, idempotency conflict, append-only
enforcement, and the existing pin, attempt, receipt, replacement and parent
fences. media-persistence.pg.test.ts ran 60 tests with 0 failures, 1001 expect
calls and exit 0 in 179.79 s against the same projection guard. The integrated
sequence through 0179 applies cleanly and the generated baseline passes
check:baseline:fresh.

Repository gates at the same head: bun run check exits 0, and bun run test
covers the non-unit phases as well as the unit phase (test:unit 4,045 tests,
0 failures; test:node 20 tests; test:workerd five pools). The workerd pool
needed a missing alias for the orchestration classifier that this lane added;
that alias is fixed. The CI sentinel shard pins were recomputed to shard 2 for
both song-video suites and remain unverified until a hosted run. No
publication, deployment, live migration, key rotation or paid provider call
was performed.

Still open outside this lane and not claimed here: hosted verification of the
CI shard pins and the separate song acceptance evidence for
lyrics/alignment/karaoke, Study and DATA on one lineage.
