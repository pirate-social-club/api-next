# Stream compatibility probe for song-backed masters — 2026-09-10

Authorized by the workspace_owner on 2026-09-10 with a bounded scope: at most two
synthetic, rights-safe clips of at most ten seconds (the actual FLAC-in-MP4
renderer output and a PCM-in-MOV equivalent), existing staging capacity only,
signed playback, a $1 incremental spending ceiling, and deletion verified within
one hour; an uncertain upload is investigated, never repeated. It selects no
production master format and authorizes no substitute AAC input. Feature flags
stay disabled. The tool is `scripts/stream-compat-probe.ts`, run in phases.

## Inputs, proven locally

Both clips come from one render by the pinned FFmpeg 6.1.1 engine: a synthetic
12 s song (a quiet 440 Hz tone with full-scale 2 ms clicks) and a synthetic 8 s
capture (a test pattern with full-white frames, and a 220 Hz tone the master
must not carry). The interval starts at sample 96 123 and lasts 288 777 samples
(6.0162 s). Markers are placed so a click and a white frame fall at the same
master instants, 1.0 s and 4.0 s.

| Input | Bytes | SHA-256 | Video / audio | Duration (samples) | Decoded audio |
| --- | --- | --- | --- | --- | --- |
| FLAC-in-MP4 (renderer output) | 699 785 | `4375a842e32cc94c21a3c7506973c684ddbd9a693575fe6ff1c2c8c7149e24bc` | h264 / flac | 288 777 / 288 777 | 288 777 samples |
| PCM-in-MOV (same samples) | 1 772 051 | `7a8fa8760411291aba8b64d1e3106de6d00a608ea89343a628ad885fe0095b65` | h264 / pcm_s16le | 288 777 / 288 777 | 288 777 samples |

Both decode to `0c6cda304b27ad3e7bbb5206ca5a204ddb1375376b9452d5c162720e65e81300`,
which is the digest of the canonical interval decoded independently from the
song. Both carry 181 video frames. In both, the click onsets are at 1.000000 s
and 4.000000 s and the white frames are frames 30 and 120, so the inputs have
zero audio-video offset at the markers.

## Upload: blocked before any byte was sent

The staging credential available to this probe, `CLOUDFLARE_API_TOKEN` in
Infisical `staging:/services/api-next`, belongs to the canonical account but is
refused by Stream: read-only `GET /stream/storage-usage` and `GET /stream`
both return 403 with Cloudflare error 10000, "Authentication error". No other
staging folder holds a Stream token (`/services/api-next/operator` has none), and
`VIDEO_STREAM_API_TOKEN` exists only as a Worker secret, which cannot be read
back. No upload was created, so nothing needs deleting.

Needed to continue: a Stream-scoped staging token placed where the probe can
read it, for example `VIDEO_STREAM_API_TOKEN` in `staging:/services/api-next`.
Creating a token, or using another environment's, was not attempted.

## Corrections before any upload — 2026-09-11

The workspace_owner specified the token (Account, Stream, Edit, restricted to
this account, stored as `VIDEO_STREAM_API_TOKEN` in `staging:/services/api-next`)
and five corrections to the script, all made before any upload. The probe reads
`VIDEO_STREAM_API_TOKEN` only. Cleanup counts a video as gone only when Stream
answers 404 with a not-found error; a 403, a server failure or any other refusal
leaves it unaccounted for. Frame rows from FFprobe drop blank lines before
numeric conversion, and the delivered end is the last frame's timestamp plus
that frame's own reported duration. The upload phase records its creation
intent before calling `/stream/direct_upload`; a lost or ambiguous creation
response is recorded as uncertain and sends the next run to `investigate`,
which looks the upload up by name, rather than creating again. Only a definite
4xx refusal may be retried. Failed tools no longer put their stderr in an
error; a copy with every URL removed goes to `tool-errors.log` in the probe
directory, because a failed HLS request can name its signed playback URL.

The FFmpeg phase is now called `decode` and reports `decoded`, not `playable`.
Decoding the delivered HLS with FFmpeg establishes decoding and timing. It does
not establish browser or phone playback. The `browser` phase is the playback
check in the probe's acceptance: headless Chromium plays the signed HLS through
hls.js with sound, as the web player does, reading frames at their media time
and audio through Web Audio. It is desktop browser playback, run under Node by
`scripts/stream-compat-probe-browser.mjs` because Playwright's browser pipe is
unreliable under Bun. A phone is not covered by either phase and remains its
own check.

As of 2026-09-11 the token is still absent from `staging:/services/api-next`
(checked by name only), so nothing has been uploaded.

## Offline rehearsal of the measuring tools

The `rehearse` phase checks the tools without Stream: the proven FLAC-in-MP4
master is packaged locally as HLS with AAC audio, served on loopback with
permissive cross-origin headers, then measured by the same `decode` and
`browser` code the live run uses. It says nothing about Stream.

The first rehearsal attempts failed with the browser closing mid-evaluation.
The cause was Chromium 148's local network access rules: a page from another
address space may not fetch loopback, so the manifest never loaded, and calling
`play()` on a media source without a manifest then took the headless browser
down. The helper now stops and reports when no manifest parses, and lifts the
local network rules only when the rehearsal asks for loopback delivery; a live
run fetches Stream's public delivery under the normal rules.

The rehearsal then passed both halves. FFmpeg decoded 181 frames and 290 816
audio samples (the AAC re-encode pads and primes, so this is not the input's
exact count), with clicks at 1.000000 s and 4.000021 s, white frames at 1 s and
4 s, and sync errors of 0 ms and 0.021 ms relative to the first delivered frame.
Headless Chromium 148.0.7778.96 played to the end with no hls.js failure: 181
frames presented, none dropped, audio decoded, white frames at media times
1.021333 s and 4.021333 s, and clicks heard at 1.021362 s and 4.051070 s. Audio
is read one analyser window at a time (about 43 ms), so browser click times are
coarse; the offset of about 21 ms common to both markers is the AAC priming of
the rehearsal's own encode.
