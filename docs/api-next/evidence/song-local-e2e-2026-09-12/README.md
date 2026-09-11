# Local song onboarding preparation

The API source baseline is 4b9e84e6. The standalone Solid runtime was
exported from b6cf294 without changing its tracked source. The separate
song-onboarding Playwright runner is at ee5811b.

A disposable PostgreSQL 17.11 database on localhost port 55437 applied the
complete pinned migration sequence through 0157. The adjacent receipt contains
the database readback: all 157 version/checksum pairs exactly matched the
pinned repository ledger. This does not attest any provider database. The
disposable container was stopped after collecting the receipt.

The unchanged HTTP Worker failed to start with Wrangler 4.123.0 and workerd:
`Incorrect type for map entry 'HNS_FORWARDER_V3_KEY_REGISTRY_MAX_BYTES': the
provided value is not of type 'function or ExportedHandler'.` Its entrypoint
re-exported application helper functions, objects and constants. The local
correction keeps only the default handler and runtime classes at that boundary;
helper modules retain their own exports. It also removes the now-unused
constant re-export from the HNS composition module. A changed API runtime needs
a new reviewed release pin.

Local configuration uses freshly generated RSA session-signing keys and the
existing staging Privy test application. Application secrets remain in ignored,
mode-0600 `.dev.vars` files; no deployed session-signing key is reused.

The initial run did not reach browser readiness before host memory exhaustion.
Task-owned servers and the disposable database were stopped. Following a host
restart and successful drive check, verification resumed one heavy job at a
time, at reduced CPU priority, with a 2 GB Node heap and one Vitest worker.

A names-only inspection of the staging runtime secret path found ingress
presigning, ACRCloud, ElevenLabs, OpenAI and QEncode credentials present.
`SONG_PLAYBACK_R2_ACCESS_KEY_ID` and
`SONG_PLAYBACK_R2_SECRET_ACCESS_KEY` were absent from that path. No credential
values or provider state were recorded or changed. The upload and playback
signers target R2 HTTPS endpoints; local bindings alone do not establish real
media upload and playback.

`bun run check` passed. `bun run test` passed with 3,855 unit tests, 20 Node
tests and 181 workerd tests (80 general, 74 HTTP, 2 Self, 10 HNS verifier,
15 video-source). Both commands used a 2 GB Node heap; tests used
`VITEST_MAX_WORKERS=1`. Biome excludes the evidence directory, so its targeted
evidence-file command processed zero files; the JSON receipt was parsed and
compared directly instead.

Browser outcomes will be appended after the bounded local run.
