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
