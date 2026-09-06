# Video publication recovery reasons

The owner ratified recoverable membership loss and non-retryable provider
uncertainty on 2026-09-06. Control-plane commit cb6d70c records the decision;
2992e40 records the two-PR integration order. The execution branch rebased once
onto fetched origin/main 76a95f57872a93fd87c9a1c72ea0c7267d02a546.

## Result and fences

Membership lost after finalize produces processing_failed/membership_required,
with retryable governed by the ordinary three-retry budget. The publication
transaction locks and reloads submission authority, checks the observed event
sequence and creation revision, and records ineligibility atomically without a
Post, reconciliation flag, discarded analysis or automatic continuation. The
Workflow returns stopped and the sweep excludes this terminal author outcome.

An explicit publication-only retry checks current membership in the retry
transaction before consuming a retry or creation revision. Refusal returns
conflict with details.reason_code membership_required. A permitted retry retains
the accepted same-video analysis and decision. Publication independently checks
membership again, so revocation committed after the runner's authority read
cannot bypass the publication transaction. This write uses the existing store
transaction rather than a second failure transaction with a race between them.

Reconciliation takes precedence in projection as provider_submission_unconfirmed
with retryable false. Both retry entry points refuse uncertainty. Confirmed
completion through the existing resolution transaction clears the failure and
returns to analysis. These author dispositions are excluded from generic
technical failure inputs.

## Migration and client ordering

Migration 0125_video_publication_failure_reasons.sql checks existing rows against
the old failure-code set before widening the constraint. It admits the two new
codes only for video, retaining the existing song behavior. The historical-row
fixture bypasses transition triggers only to install preflight data; database
CHECK enforcement remains active. Schema, reset generation and checksums were
regenerated; reset SQL is unchanged.

Client 0.64.0 is immutable and has ten exact operation-scoped clean-break waivers
against the fetched baseline. Reservation creation and part renewal do not return
submission snapshots and therefore are not affected. Retry Conflict details are
open in this tree, not a closed reason-code list; the frozen error catalog did
not need editing. The detector reports the first added enum literal per affected
operation, while both literals are present in the generated contract.

Reasons merge first. Delivery renumbers its unmerged migration from 0125 to 0126,
rebases onto that merge, refreshes its waivers, and cuts the next immutable client
(expected 0.65.0 after a ledger check). Its existing 0.63.0 candidate remains
unchanged. Solid adopts only the delivery version containing both tranches.
The owner reviews the clean/rebased delivery branch before its PR. Participation
remains downstream of that Solid adoption receipt.

## Acceptance evidence

The focused domain/application/workflow suites passed 23 tests, the breaking
policy suite passed 18, and the PostgreSQL shard-manifest suite passed 6. The
focused migration/publication PostgreSQL suites passed 29 tests, 241 assertions.
Both TypeScript projects and the full repository check passed. Script quality
reported zero findings. The final full PostgreSQL gate includes the strengthened
stale-write and reconciliation-resolution assertions.

isolated: 35 passed, exit 0
shard-0: 97 passed, exit 0
shard-1: 97 passed, exit 0
shard-2: 99 passed, exit 0
shard-3: 94 passed, exit 0.

The ordinary gate completed in explicit parts: 3073 Bun tests, 20 Node tests,
and 156 Workerd tests (80 general, 51 HTTP, 2 Self, 9 HNS verifier and 14 source
gateway). The original ordinary command was interrupted with exit 143 during
host memory pressure; the unfinished Workerd pools passed with maxWorkers 1.
This is complete split coverage, not a claim that the monolithic command passed.

The composed gate passed 23 tests through the exported Workflow class and real
queue/application/repository boundaries, with provider transports replaced by
fixtures. Its first run timed out at the unchanged 120-second wrapper limit
under memory pressure; the unchanged rerun passed in 53.45 seconds, and the full
PostgreSQL shard ran it successfully again. This is local Workerd evidence, not
a hosted Workflow or live-provider acceptance.

Named recovery drills include "drill 5: membership loss stops with a recoverable
reason and no continuation" and "drill 5 race: revocation committed with the
decision is rechecked by the publication transaction". The first rejoins and
publishes through the real Workflow without another encode. The PostgreSQL drill
"drill 5: membership loss retains analysis, refuses ineligible retry, and publishes
after rejoin" proves unchanged budget/revision on refusal and exactly one Post.
Existing drill 1, 3, 4 and 7 composed cases remain green. Reconciliation projection,
retry refusal, stale event sequence and completion clearing the reason are covered
by the publication unit and PostgreSQL suites.

Earlier failures are retained as evidence: the draft PostgreSQL run correctly
failed SQLSTATE 23514 before the migration existed; the draft package verifier
correctly refused changed content under immutable 0.62.0. A generator invocation
preceded the checksum update and refused it. The first migration fixture run hit
transition guards and the rejoin fixture used active instead of member; corrected
fixtures passed. The staged migration resolved the untracked-migration gate, and
the new test classification resolved the general-shard inventory refusal. No gate
or immutable release artifact was weakened to bypass these failures.

Required remote checks, PR and merge receipt are recorded after publication.
No deployment, credentials, live provider call or video enablement is included.

## Main update during remote checks

All required remote checks passed on 4661087c, but main advanced to 3727028d3cf1ad0b8e84401c64f4ba330395bba0
through HNS PR 287 before merge. It owns immutable migration 0126. The execution
branch merged that main update in place, preserving the single earlier rebase.
The checksum conflict was resolved by retaining both 0125 and 0126, and all ten
waivers were refreshed against the new baseline. Baseline generation remained
byte-identical. The incoming unit suites passed 13 tests; focused PostgreSQL
validation passed 17 tests and 236 assertions, including foundation and the new
reason migration. The original full PostgreSQL partition gate predates this
main update; renewed remote checks cover the combined tip.

Delivery must now use 0127, not 0126, because HNS merged the latter while reasons
CI was running. Reasons retain 0125 and client 0.64.0. Delivery still makes the
next immutable cut, expected 0.65.0, for the single Solid adoption. No artifact
was overwritten. The first green source and its checks remain captured alongside
the refreshed source rather than being relabelled as the final tip.
