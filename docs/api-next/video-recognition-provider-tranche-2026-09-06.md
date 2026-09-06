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
