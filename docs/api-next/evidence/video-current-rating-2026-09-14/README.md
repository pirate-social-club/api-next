# Current video rating and retained media proofs

Video publication now reads the current floor while holding its source lock,
composes it with the frozen decision and the current parent song floor, and
writes the resulting post and projection rating. Neither original nor
song-reference publication substitutes the old decision for a raised floor.
Historical decision and response snapshots remain unchanged. DATA authority
reads the raised video rating.

The video suite passed 28 tests with 283 assertions. The retained-evidence and
song suites passed 53 tests, including a database-bound accepted video signal
and an accepted song signal with a historical general rating. The derivative
proof runs its case both during rendering and after publication with all rating
guards active. It passed in both cases. The shared instrumental-song fixture
now records not-applicable language/alignment alongside no lyrics; its previous
ready/no-lyrics mismatch caused the first guarded test to fail. The old test
had disabled database guards, which the proof no longer does.

Full check and the single complete bun run test invocation passed on the
pre-integration candidate: 4,167 unit tests, 20 Node tests and all five workerd
configurations (82/74/2/10/15). The first static attempt caught a missing optional
fixture-field guard; it is fixed. Failed attempts and exact commands are retained.
The shared fixture changed after the earlier 28-test video run; the final
combined fixture was exercised by the derivative proof and must also pass the
complete PostgreSQL partitions. Script-size growth is recorded as the bounded
integration-proof exception in the authoritative task, without raising a baseline.

Fresh upstream e9d6e6c7 introduces recovery work and a published-client version
collision. This is pre-integration evidence, not final union acceptance. The
local client draft is separately preserved before integration. No push,
production reconciliation, enablement or deployment occurred.
