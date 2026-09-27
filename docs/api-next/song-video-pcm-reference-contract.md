# Song-video PCM reference contract

Status: accepted implementation direction for the video CloudConvert lane on
2026-09-28. This document specifies work still to be implemented; it does not
claim that CloudConvert dispatch, song PCM generation, or the readiness API is
deployed.

## Reference identity and trust

For each canonical song audio revision, create one immutable stereo 48 kHz
signed 16-bit little-endian PCM reference. Bind its object key, R2 version and
ETag, byte length, SHA-256, decoder recipe, song post ID, audio revision, and
canonical compressed-audio SHA-256 in durable state. Creation verifies the
whole PCM SHA-256 and that the byte length is divisible by four and agrees with
the admitted duration in sample frames. A changed or missing object fails
closed; never overwrite a reference in place.

On staging, the existing pinned workstation FFmpeg may backfill references for
the admitted catalog. Production starts without songs, so it needs no
workstation backfill or workstation access to production R2. Before production
song release, the song pipeline must create references for newly admitted
songs. For v1, a bounded CloudConvert job decodes the canonical song once and
the pipeline checks its source binding, format, duration, count, checksum,
idempotency, and uncertain outcomes. This is explicit song-level provider
trust: later master verification proves exact use of the admitted reference,
not that CloudConvert decoded the compressed song correctly.

## Excerpt and master

Use integer 48 kHz sample-frame coordinates from the frozen song-video plan.
Each frame is four bytes. A clip starting at frame `start` and lasting
`duration` frames reads the reference R2 range at byte offset `start * 4`
for exactly `duration * 4` bytes. Read against the recorded object identity,
reject short or changed reads, and hash only those PCM bytes. Never buffer the
whole song in the media Worker. Bound a video excerpt to 3–15 seconds, at most
2,880,000 PCM bytes.

Write a unique, short-lived excerpt object containing a standard 44-byte WAV
header followed by exactly those bytes. The header declares RIFF/WAVE PCM,
two channels, 48,000 Hz, 16 bits per sample, four-byte block alignment, and a
data length equal to `duration * 4`. Check its sample-data digest before
issuing an exact-object, expiring GET URL for CloudConvert. Do not expose the
whole-song reference or an R2 write credential to the provider. Redact the
URL from diagnostics and clean up the excerpt after a conclusive outcome.

The provider imports that WAV and the frozen source video, stream-copies the
WAV audio into the PCM-in-MP4 master, and applies the existing two-pass video
timing recipe. It does not decode or resample the canonical song in a render
job. The strict master verifier compares decoded packet bytes to the excerpt
PCM digest, excluding the WAV header, and applies its structural and timing
checks. Video-frame identity remains a separate pre-opening gate.

## Readiness and rollout

PCM readiness gates new song-video reservations, not ordinary song playback,
Study, or Karaoke. The song-reference API must expose video readiness bound to
the current audio revision. The composer song picker offers only ready songs;
the song page's make-video entry observes the same state. Reservation checks
the reference again because a picker result can go stale. An unready or
changed reference is refused before recording, never after an upload.

The order is: implement the contract, WAV excerpt recipe, reservation and
entry-point gates; backfill the staging catalog and prove a real MP3-derived
CloudConvert master on staging with CPU and memory measurement; add and prove
new-song PCM generation in the staging song pipeline; only then retire the
workstation renderer. Production song release follows the pipeline proof, and
the watched video canary and frame comparison remain separate release gates.
