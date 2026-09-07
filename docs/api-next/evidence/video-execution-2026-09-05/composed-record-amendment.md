# Pending execution record amendment

Append to tasks/records/api-video-execution-completion.md after the control-plane writer handoff. Do not apply the older resolution-stage-facts-sweep patch without reconciling its historical claims. The source of this amendment is feat/video-execution-completion and its committed composed-workflow-validation.json evidence.

## Durable Workflow tranche checkpoint — 2026-09-05

Commits 2693f9f4, 534bc4c8, b1f9d6d5 and f529eeb4 establish capped continuations, the durable executor, dormant class and bindings, and transactional publication wakeups. The following composed-drill commit drives the real queue composition and exported Workflow class against PostgreSQL, using controlled step replay and fixture provider boundaries. All 14 composed cases pass, including success without test-side publication and drills 1, 3, 4 and 7. The lane evidence includes exact test names and exit statuses. Focused tests, full ordinary local tests and bun run check passed.

The continuation key uses the same creation revision and a durable sequence capped at two. The sweep only schedules; queue delivery remains the sole launcher. Accepted facts, allocated tokens and confirmed started tokens continue safely. An ambiguous submitting token enters reconciliation, and exhausted continuations require operator reconciliation regardless of phase. Required-reconciliation observation tooling remains a named follow-up.

The unmerged video migration candidate was amended in place. Main now owns HNS migration 0120, so the final ordinal must be repaired during the single PR-preparation rebase, using the then-current inventory. Full PostgreSQL validation runs at that integration boundary. No merged migration was edited or applied.

Video remains disabled. Concrete providers, grant table and gateway Worker, the read token in Infisical, the reason-code waiver and the delivery lane still separate this from staging. Drill 2 remains ingestion-owned; drill 6 remains Solid-owned. This local harness does not constitute live provider qualification or physical hosted-Workflow crash testing.
