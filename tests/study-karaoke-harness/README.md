# Local Study/Karaoke harness (api-next side)

This directory makes the real api-next HTTP worker, its Karaoke Durable Object,
grading, persistence and completion runnable locally with only the external
provider transport replaced.

What is real: routes, authorization, session state machines, the Study spoken
grader, the Karaoke socket protocol and session host, line scoring, PostgreSQL
writes, completion and duplicate-effect protection. What is scripted: the Study
batch transcriber and the Karaoke streaming STT adapter, both armed per case
through `/__harness__/*` control routes on the harness Worker.

Nothing here deploys, contacts a provider, or reads a staging secret. The
seeded identities, song and audio are synthetic and disposable.

## Files

- `entry.ts` — harness Worker entry: composes `createProductionHttpWorker` with
  the scripted transcriber, exports `ScriptedKaraokeAttemptDO` (protected
  `makeSttAdapter` override), and installs a loopback-only fetch guard.
- `study-transcriber-double.ts` — scripted Study transcripts and provider
  failures, with a call log for auditing.
- `karaoke-stt-double.ts` — scripted `KaraokeStreamingSttAdapter` modes:
  `correct`, `wrong_words`, `omit_negation`, `early`, `late`, `silence`,
  `provider_error`.
- `wrangler.jsonc` — local Worker configuration. Its only external names are
  reserved-TLD hostnames that never resolve; the fetch guard refuses
  non-loopback requests first.
- `keys.ts` — generates the gitignored local RSA session key pair and writes
  `.dev.vars`; runs automatically from `start-local.sh` and `seed.ts`.
- `seed.ts` — seeds the disposable database with synthetic learner accounts,
  their activity personas, and one published song with accepted lyrics, four
  say-it-back exercises and a word-mode timing artifact. It also mints the
  synthetic browser session tokens in `.local/harness.json`.
- `reset-local-db.sh` — recreates the disposable PostgreSQL 17 (1 CPU,
  512 MB) and applies the generated migration baseline into the `api_next`
  schema.
- `reset-local-data.sh` — fast truncate-and-reseed of an existing database.
- `start-local.sh` / `stop-local.sh` — run/stop the Worker on 127.0.0.1:8788.
  `stop-local.sh --keep-database` stops only the Worker.

## Run

```sh
# one disposable PostgreSQL
./reset-local-db.sh
# synthetic fixture and .local/harness.json
cd ../../.. && bun tests/study-karaoke-harness/seed.ts
# harness Worker (foreground)
./tests/study-karaoke-harness/start-local.sh
```

Then run the Solid browser specs from the sibling worktree:

```sh
cd <workspace>/.worktrees/pirate-web-solid/solid-study-karaoke-browser-harness
bun x playwright test -c e2e/study-karaoke-harness.config.ts
```

Reruns need `reset-local-data.sh` (the Study review schedule is per account and
the journeys consume it). `stop-local.sh` removes the Worker and database.

## Notes

- The PostgreSQL container uses host networking bound to 127.0.0.1: published
  docker ports were observed to terminate connections before the PostgreSQL
  protocol handshake on this host.
- The harness Worker serves the same `/karaoke/realtime/:sessionId` socket path
  as production and hands it to the scripted Durable Object.
- `.local/` (keys, manifest) and `.dev.vars` are gitignored and hold only
  locally generated values.
