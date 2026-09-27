# Strict song-video master verifier

This is the first, pure-verifier phase of `api-video-cloudconvert-render-integration`.
It makes no provider request and has no R2 or database binding. The caller must
provide the expected 48 kHz sample count and SHA-256 of interleaved signed
16-bit stereo PCM for the selected source-song excerpt. Those facts must be
derived independently of the provider output.

The verifier limits the master to 24 MiB and 3–15 seconds, checks the admitted
MP4 box and sample-table shape, requires one H.264 track and one 48 kHz stereo
signed-16-bit PCM track with matching zero-based timing, copies its bounded
chunks in sample order and compares the exact PCM digest. It materializes no
per-audio-sample objects and has no MP4 parsing dependency. It does not
establish video-frame identity. The provider remains trusted for video content
until the separately required frame-comparison gate is implemented before
ordinary-user access.

The short MP4 fixture was produced locally by converting the synthetic
CloudConvert FLAC master in `archive/video-cloudconvert-song-master-trial-2026-09-26/`
to PCM while copying H.264. The 15-second fixture is direct CloudConvert
FFmpeg 6.1.4 PCM output from `archive/video-cloudconvert-pcm-trial-2026-09-27/`.
Their byte and expected PCM digests are pinned in the tests. Neither contains
user media. Separate staging Stream probes accepted both PCM-in-MOV and
PCM-in-MP4 and decoded their delivered audio and video; see
`archive/video-pcm-stream-compatibility-2026-09-27/`.

The verifier checks the top-level layout, PCM sample entry, sample-table bounds,
chunk extents and complete media-data coverage independently.

The earlier local Worker probe was for FLAC and does not qualify this PCM
revision. The local V8 allocation comparison is recorded in
`archive/video-master-verifier-memory-2026-09-27/`; a deployed-plan Worker CPU
and memory receipt is still required before merging.
