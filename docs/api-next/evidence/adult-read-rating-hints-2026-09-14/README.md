# Adult read rating hints

Authorized adult post responses now project the existing `age_gate_policy`
field as `18_plus` in feed, detail and community threads. Anonymous and
unqualified reads still receive the content-free lock before projection.
This lets the client request renewed document age verification after a media
capability expires without guessing from a failed delivery request. No wire
shape or immutable client artifact changed.

The three PostgreSQL suites passed 21 tests with 108 assertions against a
bounded task-owned PostgreSQL 17 database over a Unix socket. The feed suite
adds a direct anonymous-lock versus authorized-adult-hint case. Detail and
community-thread adult cases assert the same hint. Database cleanup completed.
The subsequent complete `bun run check` passed, including 179-migration
consistency and client 0.78.0 verification. Biome reports existing warnings;
the check exits zero. This is not a new full unit or workerd run.

The prior full API component evidence remains at 757581d2. Final PostgreSQL
partitions, broad delivery/cache coverage and live acceptance remain open.
The compressed log is sanitized text; the source manifest pins the six tested
files. No feature was enabled, pushed or deployed.
