# M3 reconciliation fairness — current-main adaptation

This tranche ports the retry-fairness semantics from the historical
`m3/installation` review onto current M3 main. It is intentionally not a
cherry-pick: current main retained the newer dormancy/retention migration,
server-plan admission, and journal lease API, while the historical lane used
an obsolete expiry migration and older repository seams.

| Historical behavior | Current-main owner | Adaptation |
| --- | --- | --- |
| Durable attempt metadata | `0019_m3_reconciliation_attempts.sql` and `schema.sql` | Forward-only migration after current `0018_m3_funding_dormancy_and_retention.sql`; no predecessor `0018` or expiry API restored. |
| Due candidate selection | `CommunityPurchaseFundingQueryStore.listReconcilable` and platform repository | Joins the attempt table, requires a transaction hash, accepts absent/due non-escalated state, and orders by journal age. |
| Attempt claim | `recordAttemptStart` | Conditional UPSERT returns `reserved` or `unavailable`; it increments durable `generation` only for absent/due/non-escalated rows. |
| Attempt finalization | `recordAttemptSuccess` / `recordAttemptFailure` | `WHERE operation_id = ? AND generation = ?`; stale finalizers return `stale` and write nothing. |
| Economic transition fencing | Existing journal `lease_owner`, `lease_fence_token`, `lease_expires_at` | Preserved unchanged; retry generation is not a substitute for the journal lease. |
| Failure policy | `packages/domain/src/money/reconciliation-backoff.ts` and application reconciler | Bounded failure classes, deterministic jitter, final-delay clamp, consecutive-failure escalation, and fixed alert key. |
| Parked/hashless handling | query and parked-count repository paths | Hashless dormant/ambiguous/legacy entries do not get attempt rows, RPC reads, automatic counts, or reconciliation alerts. |

The jobs worker now owns the attempt store wiring and includes the attempt table
in its declared read/write set. Unit tests cover poisoned-candidate progress
and stale finalizers. PostgreSQL tests cover due selection, concurrent claim
losers, and no-write stale finalization; the existing sentinel controls whether
the real database suite runs.
