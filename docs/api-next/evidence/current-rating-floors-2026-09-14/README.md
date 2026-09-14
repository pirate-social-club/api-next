# Monotonic current content ratings

Migration 0185 preserves adult floors on posts and comments, extends comment
inheritance to song and video parents, and cascades later raises to replies,
media projections and song-reference video posts. Historical publication
and response snapshots remain immutable. A named successor to each media
transition guard admits only an exact rating-only raise; every other column
is unchanged. The generated account alias is excluded from that comparison
because BEFORE triggers run before it is computed; actor_user_id remains exact.
A rating-only repair does not fabricate a publication event or advance its
sequence. The original transition guards remain intact for every other write.

Song publication reads its current floor rather than replacing it with its
frozen decision. The database tests prove media comment inheritance, rollback,
lowering refusal, rejection of a rating raise combined with a title change,
unchanged historical response/event sequence, and publication using a raised
floor. The original video publication test retains visibility/safety checks
and now tests an adult floor without lowering it afterward.

Baseline regeneration and complete check passed with 181 migrations. The
three PostgreSQL suites passed 83 tests and 1,134 assertions against a bounded
socket-mounted PostgreSQL 17 database. Container/socket cleanup completed.
The separate full component run passed 11 shard tests, 4,165 unit tests,
20 Node tests and all five workerd configurations (82, 74, 2, 10, 15).
Expected runtime cancellation diagnostics remain in the passing workerd log.

Failed attempts are retained: a test leaked its mocked age function, a fixture
lowered an adult rating, the original submission and event guards rejected a
rating-only repair, and PostgreSQL refused a BEFORE-trigger WHEN expression
referencing generated NEW columns. The fixture now restores its function;
named guard successors handle the exact repair without weakening other writes.

This does not implement retained-evidence reconciliation or unknown-evidence
holds. Direct song-to-video cascade acceptance, full PostgreSQL partitions,
trusted remote checks and live staging acceptance remain required. Nothing
was enabled, pushed or deployed.
