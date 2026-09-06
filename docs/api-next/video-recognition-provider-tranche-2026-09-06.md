# Video recognition provider tranche

Phase one resolves only external provider matches. Provider identifiers are not
Pirate song identifiers, and no title/artist lookup or fingerprint registry is
introduced. Self-owned and Pirate-song branches remain unreachable here.

The audio job keeps its M4A and adds primary/alternate MP3 outputs at 128 kbit/s,
44.1 kHz stereo, using mediaTransformSampleWindow. Each clip is capped at
4,000,000 bytes. Each has a deterministic creation-bound .mp3 key, sealed digest,
size and requested window. The M4A records its full duration and zero offset.
Stage acceptance and recovery require all three artifacts. MP3 sniffing accepts
ID3 or MPEG layer-three sync; independent decoding is a live fixture obligation.

Qencode's [transcoding reference](https://docs.qencode.com/api-reference/transcoding/)
documents per-output start_time and duration in seconds. The implementation uses
those fields; exact trimming/MP3 output behavior remains an assumption until the
fixture measures both windows, independent decoding, payload and recognition.
Requested windows are not claimed as provider-observed timestamps. No live
provider calls or enablement occur in this tranche.

Audio checkpoint: bun run check exited 0. The five focused transform, Workflow,
stage schema, artifact HEAD and disabled-transform suites passed 44 tests with
470 assertions, exit 0. Initial check failures identified an unused type export
and stale test snapshots; both were repaired without changing assertions or
timeouts. PostgreSQL and composed provider fixtures remain for the final gate.

Recognition uses the existing conditional-GET sample reader and verifies the
canonical clip digest before ACR. Each variant has a creation-bound request id.
The primary is followed by the alternate only after no-match or inconclusive;
any match is external, and any genuine inconclusive prevents a combined no-match
claim. Provider failures exhaust into a soundtrack hold, not inconclusive.

The ACR adapter bounds each request but has no internal retry loop. This video
composition permits three requests per clip, with one- then two-second sleeps
for retryable outcomes, at most six calls and six seconds of backoff. Each
request has the existing 120-second bound and each clip read a 30-second bound.
The maximum planned work is 786 seconds within the recognition step's existing
fifteen-minute timeout. Permanent/malformed outcomes exhaust immediately.

Private bounded normalized evidence lives inside the existing immutable
recognition stage-fact snapshot. This avoids a duplicate evidence table. The
decision bundle receives only the hashed evidence reference and external match
identity. Stage replay skips recognition; infrastructure failure before the
immutable fact write may repeat identification requests, never an encode.

Recognition checkpoint: focused provider, Workflow and closed-schema suites
passed 21 tests with 462 assertions, exit 0; bun run check exited 0. A first
schema-load failure used the wrong pinned Effect filter signature and was
corrected to the checked object-form API. No provider response was fabricated
to bypass the failure.

Binding checkpoint: song and video share makeIdentification with the existing
host, credentials, limits and redirect-safe fetch transport. Video constructs
all providers without adapter arguments; missing ACR configuration produces
acr_skipped. Qencode, gateway and Workflow bindings still require valid
configuration. VIDEO_ANALYSIS_ENABLED remains false in every environment.
Composition/provider suites passed 12 tests, 98 assertions, exit 0, and bun run
check exited 0. Live credentials and provider acceptance remain unproven.

## Composed acceptance

The queue worker and exported Workflow class run with real application commands
and PostgreSQL stores. Qencode and OpenAI transports are fixture boundaries;
ACR uses the shared concrete adapter with a fixture fetch. The moderation
endpoint uses the real HTTP transport, contract decode, application command and
moderator store with fixture authentication. This is not a hosted Workflow or
a browser/session acceptance claim, and no test calls the publication store.

The composed suite passed all 22 cases, exit 0, including these named cases:

| Test | Result |
| --- | --- |
| recognition: both MP3 clips no-match publish after safety approval through the moderation endpoint | passed |
| recognition: primary inconclusive and alternate external match require soundtrack evidence approval | passed |
| recognition: throttling exhausts into a soundtrack hold | passed |
| recognition recovery: all three sealed audio artifacts survive a failed fact write and expired outputs | passed |

The matching case rejects soundtrack approval without evidence with HTTP 400
and observes no Post before valid approval. It proves ACR code 2004 followed by
an external match, with normalized title retained only in private stage evidence.
The recovery case checks three sealed receipts and only three total encode
starts: probe, audio and frames. Existing drills 1, 3, 4, 5 and 7 remain green.

The first composed run passed 21 cases and failed one test-side query for a
nonexistent snapshot column, after publication had succeeded. It was corrected
to fact_snapshot. The alternate-match fixture was also tightened from an empty
success response to the explicit inconclusive status 2004 before the green run.
No runtime workaround, timeout increase or publication shortcut was introduced.

The Workerd source-gateway suite passed 14 cases, exit 0, including video
recognition reads sealed clips and uses the real Workerd ACR fetch path. It
exercises conditional R2 reads, multipart MP3 samples, signed requests and
manual redirect handling without following Location. The affected publication
and reconciliation PostgreSQL suites passed 33 cases, 253 assertions, exit 0.
The owned database harness is stopped. Full PostgreSQL and remote required
checks are still owed at pull-request preparation; these focused results do
not substitute for them.

Final local gate: bun run check and bun run test both exited 0. Ordinary coverage
is 3,066 Bun, 20 Node and 156 Workerd tests. The pre-existing Workerd pump-canceled
diagnostic remains visible with passing assertions. No migration, wire contract,
client release, deployment, credential mutation or live provider call occurred.

After integration, execution's remaining scope is reservation lifetime/cleanup
and the cross-store platform-hold tooling follow-up. Staging still requires the
configured gateway to be deployed, the read token and authorized Infisical
mutation, Qencode/ACR fixture acceptance, the combined reason-code waiver and
delivery's ingest/thumbnail path. The hostname targets are already recorded;
DNS/deployment readiness is separate. Clean video remains manually reviewed
until a separately accepted visual minor-safety provider and gate exist.

## Integration review clarifications

The shared ACR context overloads song-era field names: audioRevision contains
the video revision and analysisRevision contains the creation revision. The
returned-context check verifies both alongside operation, request id and clip
digest. Interpret these private observations as video attempts using their
creation-bound stage-fact identity, never as song analysis revisions.

A failed clip digest check currently resolves to acr_exhausted with private
artifact_unavailable evidence. This fail-closed integrity/infrastructure-to-
provider classification asymmetry belongs on the same follow-up as safety
availability classification; this integration changes no public reason codes.


## Pull-request preparation gate

The authorized rebase against fetched origin/main at
ca492404588d73c08bc5b21eb80c6a79cdc9bf6b was a no-op. No migration or runtime
change followed the reviewed source 515cc016. This preparation adds only these
evidence clarifications and validation results.

The host-network PostgreSQL 17 run used the repository's isolated partition and
all four general shards, serially. The isolated suite passed 35 tests, exit 0;
general shards 1, 2 and 3 passed 79, 89 and 124 tests respectively, all exit 0.
The initial isolated invocation failed all 35 tests with connection refusal
while the database was starting. The successful rerun followed pg_isready.

General shard 4 passed 89 tests and failed the composed wrapper at its unchanged
120-second timeout, exit 1. The direct composed continuation passed all 22 drills
in 52.65 seconds, exit 0. A rerun of the exact PostgreSQL wrapper then passed,
including all 22 drills, in 51.06 seconds, exit 0. No timeout, assertion or runtime
was changed. This is complete partitioned coverage with an explicit continuation,
not a clean unsplit invocation. The cause of the one wrapper timeout is not
established. Both failed logs remain part of the integration capture.

The earlier check and ordinary suites remain green on this exact runtime.
Required remote check, postgres17 and secret-boundary results are still required
before merge and will be recorded with the merge receipt in the execution record.
No deployment, enablement, credential mutation or live provider call occurred.


While PR 283 was opening, main advanced to b8fd2a4b through HNS monitor PR 282.
The strict up-to-date rule required a base refresh. The branch merged that base
cleanly as 0e328e84, preserving the single earlier rebase and the reviewed video
commits. There is still no video migration or implementation change in this
preparation. Refreshed check and ordinary suites passed, exit 0: 3,075 Bun,
20 Node and 156 Workerd tests. The newly added HNS PostgreSQL snapshot test
passed one case with 13 assertions, exit 0. Prior full partitioned PostgreSQL
coverage remains recorded above; fresh required remote checks cover the merged
base. The owned database harness was stopped after the added test.
