# Nationality and adult gates upstream refresh

This evidence covers the final local API candidate after integrating
`origin/main` at `b5b98344152a1096617204bfe3046a2237f6ffe7`. The merge commit
is `87650ec47faead693ceca07d94c6dade5d0517e0`. The exact code candidate is
`5fcd0f0086287dc8e3f2b8456734713873df607f`.

The three upstream commits added the governed staging reset, exact migration
chain enforcement and Megapot request-start pacing. The only merge conflicts
were in the Megapot pacing implementation and tests. The resolution retains
the implementation already published on `origin/main`.

The first complete `bun run test` stopped after 4,360 passes and one failure
in the PostgreSQL discovery unit test. The added upstream suites moved the
song-video render-host sentinel from shard 1 to shard 2. The workflow pin was
updated to the freshly computed owner, and the focused discovery suite passed
11 tests.

At the exact code candidate, `bun run test` passed 4,361 unit tests, 20 Node
tests and all five workerd configurations with 82, 74, 2, 10 and 15 tests.
`bun run check` also passed, including the 187-migration consistency check,
contract freshness and immutable api-client 0.79.0 verification. Existing
lint advisories remain warnings.

The merge changed no database migration or generated baseline. The complete
PostgreSQL partition evidence at parent candidate
`edd957c713f8654d341ac4ec1a956d26ba63f428` remains applicable to the
unchanged database feature tree. Hosted pull-request gates and real provider
acceptance remain outstanding.

Nothing was pushed, enabled, deployed or applied to a shared database.
