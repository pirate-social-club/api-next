# Private activity completion and progress

This source slice closes the five missing API facts in the October 16 shared
activity UI handback. It adds five authenticated, `private, no-store` GETs:

| Operation | Path |
| --- | --- |
| GetStudyCompletionState | `/communities/:communityId/study/v2/sessions/:sessionId/completion` |
| GetKaraokeCompletionState | `/communities/:communityId/karaoke/sessions/:sessionId/attempts/:attemptId/completion` |
| GetSongActivityProgress | `/communities/:communityId/posts/:postId/rewards/progress` |
| GetCommunityActivityProgress | `/communities/:communityId/rewards/progress` |
| GetActivityPresentationPersona | `/communities/:communityId/rewards/presentation-persona` |

The application port lives in `rewards/activity-completion.ts`, separately from
the frozen phase-0 ports. No frozen contract/port changes are proposed or needed.
Existing Study v2 exercise controllers, answer receipts, Karaoke attempt receipts,
Karaoke scoreboard and qualification policies are unchanged.

## Completion decisions and immutable receipts

Completion reads bind the authenticated account, community, session, performing
persona, post and accepted audio revision. Karaoke additionally binds both the
session's attempt and the qualification's attempt. Policy and completion time
must match. Reads apply the existing active-persona/community binding and song
access authority. Unavailable or foreign resources return the same 404.

An exact persisted qualification proves `qualified`. It does not follow from
score, rank, a current policy reference, or reward admission. Active sessions are
`pending`; an explicitly incomplete/cancelled Karaoke completion is `refused`.
Future completed producer transactions without a qualification receive an
append-only `not_qualified` observation (`producer_not_qualified`). This means the
producer did not admit a qualification; it does not invent a numerical failure
reason or describe a provider refusal as a grade. Provider uncertainty while a
session remains active stays `pending` under the existing runtime lifecycle.

Provisional migration `0269_activity_completion_decisions.sql` attaches deferred
observers to the existing terminal Study v2 and Karaoke session transitions. The
observer runs after all writes in the producer transaction, including its
qualification. It changes no grading, reward admission or financial projector.
The observer's owner and schema path are pinned; runtime readers inherit only
existing explicit private qualification SELECT grants, and the table has no
runtime mutation grants. The migration also removes direct EXECUTE grants
inherited from function defaults; ordinary trigger invocation needs no caller
EXECUTE on the observer. Parent release verification must include its actual
runtime role. The ordinal is branch-local and must follow actual merge order.

There is no historical backfill. An older completed session without a recorded
qualification or terminal observation reports `unknown` with
`historical_decision_unavailable`. GETs never insert missing facts. Historical
qualifications remain readable from their existing authoritative rows.

The immutable song/community day ledgers already retain `first_qualification_id`.
The completion signal uses that exact qualification ID as `signal_id` and compares
it separately with each scope's first qualification. Retries return the same
signal and booleans. A later same-day completion has both booleans false; a first
song completion in an already-earned community day has only the song boolean
true. Missing day evidence reports `unavailable`, never manufactured booleans.
The signal is not a promise that this browser has not already displayed it.

Old command receipts remain byte-for-byte immutable. The UI should read this
separate current state after completion/replay and fence it by the returned
attempt, persona, community, post and audio identity. Reading does not resubmit
the activity. The signal grants no reward or monetary entitlement.

## Private progress, days and presentation

Progress uses the account's current pinned IANA timezone, or explicitly reports
the accepted UTC default with `timezone_pinned: false` before the first pin.
`observed_at`, `today`, and the inclusive Monday–Sunday ISO-week bounds are
server-owned. Exactly seven canonical dates and earned marks come from one SQL
snapshot and the authoritative day ledger. There is no browser-clock expansion
of streak aggregates and no calendar backfill. Existing accepted session zones
and historical day keys are never rewritten after a prospective timezone change.

Activity-keyed counts count all recorded Study/Karaoke qualifications in the
requested scope, including multiple qualifications on the same day. They do not
count attempts, resolved cards, days, money, or public ranking rows. The counting
period is explicitly `all_recorded_qualifications`. Empty progress is zero counts
and a zero streak. Expired streaks retain private best, total days and date
history with current zero. A null standing explicitly means no admitted live
ranking; private progress still exists. Competition ranking uses the existing
current/best score tie semantics with active community-bound presentation.

The initial presentation GET is independent of rankings and never chooses a new
default. It returns `selected`, `unset`, or `unavailable`; an ineligible selected
persona's identifier is hidden. Changes continue through the existing PUT and
its immutable idempotency receipt. No public endpoint gains account, sibling,
attempt, wallet, evidence, answer or recording details.

Current community authority follows the accepted `communities.status='active'`
boundary. The current schema has no private-community visibility mode; membership
mode gates posting, not own activity reads or public-song participation. Hidden
or archived communities are unavailable. Individual song reads retain
`can_account_access_activity_song` (published/public song plus the account's
content-rating access), and completion reads also require the exact active
performing persona binding. Private community aggregates preserve the account's
earned ledger history after an individual song becomes unavailable, while
returning no inaccessible post, attempt or evidence identifiers. This does not
grant access to that song. Presentation lookup and changes continue to require
active account/community authority; a selected inactive persona is hidden.

## Verification and parent integration

Focused tests cover schema invariants, generation, private transport/cache and
authentication, identity propagation, status distinctions, read-only behavior,
signal replay, independent private progress and presentation. The PostgreSQL
regression uses the actual Study and Karaoke repositories and existing local
fixture helpers, with no funded legs or provider calls. It covers committed
decisions, replay, same-day cross-activity deduplication, zero/no-standing,
historical unknown/no GET backfill, timezone/DST reads, and lifecycle refusal.
Its execution requires the parent's exact isolated database handoff.

The forward-ACL regression installs the maintained, checksum-verified migration
prefix through268 into a fresh schema, establishes existing qualification SELECT
and old application grants, seeds accidental table/function defaults, then applies
269 through the normal migration runner. A separate disposable restricted LOGIN
asserts both session and current identity. The real application DB layer reads
completion/progress/presentation as that login with the accepted access locks.
Direct decision INSERT/UPDATE/DELETE/TRUNCATE and observer EXECUTE are denied.
The existing controlled ordinary-account Study producer completes four actual
cards as that login, and its deferred SECURITY DEFINER observer records the
qualification. Replay and GETs preserve every table's rows in the disposable
schema, including decisions, receipts, private evidence and day history;
foreign-account errors remain redacted. This proves restricted
Study completion, not restricted Karaoke completion or deployed role configuration.

The resumed source proof runs only on the parent's dedicated loopback54389
PostgreSQL17.11 fixture in random `activity_completion_*` schemas and task-local
`activity_completion_acl_*` logins, all removed after the case. The maintained
test suite now belongs to `freshSchemaPostgresTestSuites`, participates in the
general/audited CI partition, and writes its established-style completion sentinel
only after both tests and their cleanup succeed. CI clears and uploads this
marker, and `verify-postgres-test-sentinels.ts` requires it. The parent has indexed
the suite for tracked-file discovery; the writer does not own the index.
`postgres-foundation.pg.test.ts` now includes
`activity_completion_decisions` in its exact catalog; parent baseline regeneration
must follow the corrected provisional migration checksum. The parent's earlier
generated baseline/reset remain untouched by this lane.

The parent regenerated the baseline and verified freshness using separate fresh
empty disposable databases after the migration269 ACL correction. It prepared
immutable client0.120.0, updated generated OpenAPI/client provenance, and verified
the package and all118 historical artifacts. Existing method/path OpenAPI
operations are unchanged. The versioned handoff is
`api-next/api-client-v0-120-0-handoff.json`.

The parent full `check` and `test` runs passed after repairing test-only typing
and routing HTTP imports through the owned application use-case facade. The test
run includes6082unit passes with3skips,24storage passes,22Node/entrypoint passes
and247Workers passes. The parent independently reran both PostgreSQL completion
and forward-ACL tests with143assertions and a task-owned completion marker.
These local checks do not replace the required exact-commit hosted PostgreSQL,
HNS, source and secret-boundary checks. Source publication remains a draft while
those checks and consuming Solid integration are reviewed.

The Solid integration checkout has the exact0.120.0 candidate for local consuming
work; this does not release the API or UI. Forward migration/grants, real deployed
role checks, paired runtime acceptance and actual consuming-route behavior remain
release requirements. Production Rewards remains off. The old0.119.0 package and
handoff are unchanged. No source or test result proves a production deployment.

The five source facts require no further product ruling. Historical missing
decisions cannot be recovered honestly. Dance admission, UI result routing and
financial results remain in their owning lanes.
