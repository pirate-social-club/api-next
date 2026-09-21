# Offline preparation handoff

This dated document is an archived, non-authorizing preparation draft. The
paragraphs below describe the initial September 21 handoff, not current Git,
test or release state. Current lifecycle and approvals belong to control-plane
task `tasks/records/rewards-current-flow-live-acceptance.md` in pirate-workspace
and draft PR #391. Do not fill live participant details or execution approvals
into this historical document.

The rewards preparation coordinator implemented the multi-participant golden
runner in the isolated `rewards-current-flow-live-acceptance` worktree on
`ops/rewards-current-flow-live-acceptance`, based on df44b806. This is local,
uncommitted preparation pending checkpoint/publication authorization, not live
acceptance. Origin main advanced to 3c62a4d4 during the work; rebase and recheck
before publication. No runtime source, migration, deployment or flag changed.

The runner retains the v1 single-Study interface and adds v2 participant-array
execution, separate credentials, an actual read-only v2 artifact collector,
reviewed-vocal PCM over the production Karaoke transport, persisted completion
checks, and ordinary-scheduler settlement observation. Its journal prevents
automatic repetition after ambiguous activity outcomes and binds the funding
transaction. Both natural outcomes require exact admission, frozen beneficiaries,
whole-leg one-ticket bounds, residual refund and no unresolved money effects.
A win additionally requires every beneficiary's confirmed equal-share payout.

The preparation package and command procedure are in
[the authorization package](rewards-current-flow-authorization-2026-09-21.md)
and [the runner guide](megapot-multi-participant-runner.md). Missing current
identities, real ceremonies, song handoff, caps, windows, deployment/rollback
pair and closeout policy remain missing. The package is not ready for an
execution signature. It does not propose using seeded evidence or random-win
waiting as an acceptance plan.

## Verification

The final focused run passed 27 tests and 172 assertions across the original
golden/preflight suites, v2 artifact assembly, mixed orchestration, journal and
settlement checks, and Karaoke transport. The final PostgreSQL 17.11 run passed
both composed suites: 3 tests, 108 assertions, 15.25 seconds. This includes
executing the new observation, exact-witness and current-content SQL against
the real composed settlement schema. Chain outcomes and identity evidence in
these PostgreSQL tests remain fixtures, not live proof.

The manifest, shard-balance and sentinel suites passed 58 tests and 173
assertions. Final `bun run check` passed with existing baseline warnings and
the existing unrelated scripts typecheck deferral. All new tests are explicitly
included in the scripts typecheck configuration. Script quality reported zero
findings. `git diff --check` was clean before this documentation handoff.

The broader `bun run test` completed with exit zero: 4618 unit tests passed,
one skipped, 27688 assertions; 20 Node tests passed; all six Worker test
configurations passed. Its unit phase preceded the last v2 collector addition;
the complete check, six focused suites and both PostgreSQL suites were rerun
after that addition. No claim is made that a live ceremony or chain action ran.

Host-to-container PostgreSQL connections initially failed with
`Connection terminated unexpectedly` and `ECONNRESET`. Running the pinned Bun
binary inside the disposable PostgreSQL container with this worktree mounted
read-only succeeded. Every owned database used
`max_locks_per_transaction=1024`; all three owned containers and their anonymous
test volumes were removed with `docker rm -f -v`. Test source recreates their
discarded contents. Other lanes' containers were untouched.

Two read-only review agents checked the source/operational inventory and the
implementation. Review corrections added per-activity qualification checks
without requiring a duplicate admission decision, pre-funding Study-cap
sufficiency, consecutive beneficiary ordinals, funding-hash and torn-journal
fences, mixed-participant orchestration coverage, and a v2 collector instead
of requiring hand-built JSON. Client-side monetary cap declarations still do
not enforce independent scheduler gas or provider spend; the authorization
package explicitly requires operator controls.

## Workspace handoff

The old rewards remote-tracking ref was pruned in the canonical api-next
repository as requested. No live remote branch was deleted by that fetch.
The rewards lane has no product-runtime changes and has not been published.

Other agents continued writing and committing the control plane during this
run. Their files were left untouched. The authoritative task remains active
with its command-owned worktree activation pending a coordinated bookkeeping
checkpoint; this local handoff must not be mistaken for closing that task.
Workspace checks reported no api-next blocking breach, with the shared dirty
control-plane checkout and unrelated lane warnings remaining outside this
lane. Refresh all point-in-time checks before integration.
