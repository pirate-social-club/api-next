# Video master renderer spike — checkpoint 1

Status: bounded local evidence checkpoint, 2026-09-02. This is not a runtime
implementation or a renderer selection. No credential, provider request, R2
object, Stream input, DATA operation, deployment, or production media was used.

## Result

Direct FFmpeg proves H.264 packet payload copy and AAC soundtrack replacement
are individually feasible, but the brief's exact last-complete-presentation-
packet rule is not a safe general packet-copy rule for H.264 streams with
B-frames. Reordered presentation can place an out-of-window reference packet
before in-window B-frames in decode order. Removing only the reference packet
produces a non-contiguous, potentially undecodable packet sequence.

The current recommendation is therefore conditional:

- make the browser copy profile prohibit reordered frames and prove that on
  each accepted encoder, or
- revise the master policy to retain required decode-support packets while an
  edit/timeline fence bounds visible presentation, or
- demote every reordered source to frame-accurate transcode.

The second amendment should not ratify the current B-frame wording until one
of those outcomes is accepted. The pure policy harness in
`scripts/video-master-renderer-packet-policy.ts` preserves the collision as a
regression test rather than silently treating a filtered packet list as valid.

## Local inventory

The checkpoint ran on Linux amd64 with Bun 1.4.0 and Node 24.14.0.

- FFmpeg and ffprobe: Ubuntu `6.1.1-3ubuntu5`, libavcodec 60.31.102,
  libavformat 60.16.100, with libx264, libvpx, and AAC support.
- Docker: 29.7.2. No container image was built or started.
- Mediabunny and `@mediabunny/server`: 1.55.5, installed only under `/tmp` for
  the probe. `registerMediabunnyServer()` succeeded under both Node and Bun.
  The extension depends on `node-av ^6.0.0`, peer-depends on Mediabunny, and is
  MPL-2.0.

The repository dependency graph was not changed for this checkpoint.

## Frozen synthetic recipes and observations

The local fixture uses `testsrc2` at 320 by 180, 30 fps, four to six seconds,
one-second GOPs, and a lyrics-free sine soundtrack. The reordered fixture uses
libx264 with three B-frames. The canonical replacement uses a different
lyrics-free sine frequency. A second H.264 fixture disables B-frames. These are
recipes, not checked-in binary media.

The source was probed with `ffprobe -show_packets -show_data_hash sha256`.
FFmpeg stream copy preserved every observed H.264 packet payload hash and
keyframe flag in its contiguous copied decode-order sequence. That establishes
that packet-payload identity is measurable without requiring whole-file byte
identity.

For the reordered fixture, an input seek at the exact probed keyframe plus
`-c:v copy` and an output duration of 2.866667 seconds produced a video track
reported as 2.933333 seconds. The copied sequence contained a packet presented
outside the brief's requested half-open window so later in-window reordered
frames retained their decode dependency. FFmpeg's ordinary CLI `-ss`/`-t`
template therefore does not implement the brief's filtered-presentation-set
rule.

The no-B-frame fixture demonstrated a contiguous payload-copy sequence, but it
also exposed timeline details the next checkpoint must freeze. Seeking to the
exact probed keyframe produced a small non-zero rebased start, FFmpeg shortened
the final packet's declared sample duration, and the AAC track ended at
1.888000 seconds while the copied video ended at 1.866667 seconds. AAC frame
padding and container edit/timestamp behavior require an explicit master
duration and A/V tolerance; “trim audio to the same duration” is not by itself
a byte-level rule.

## Candidate feasibility

Direct FFmpeg is a useful reference oracle and can express the fixed command
templates without accepting raw arguments from a caller. It is not selected as
the production adapter by this checkpoint.

`@mediabunny/server` is installable and initializes on the repository's Node
and Bun runtimes. Its current typed Conversion API exposes trimming, automatic
encoded-sample copy when compatible, forced transcode, and composable outputs.
This checkpoint did not yet prove a two-input conversion that copies video from
one source while encoding canonical audio from another, nor compare its packet
and timestamp behavior with the direct CLI.

Current Cloudflare documentation says Containers run Linux amd64 images with
ephemeral disk, typical cold starts often in the one-to-three-second range,
and Durable Object container `exec` has no built-in timeout. A caller must
enforce process termination and independently persist attempt state and sealed
outputs. These facts are compatible with continued evaluation but are not a
GO for the provisional two-second acknowledgement or render p95 targets.

Sources retrieved 2026-09-02:

- https://developers.cloudflare.com/containers/
- https://developers.cloudflare.com/containers/concepts/architecture/
- https://developers.cloudflare.com/containers/platform/limits/
- https://developers.cloudflare.com/durable-objects/api/container/

## Still unverified

The next checkpoint must run the executable fixture matrix for WebM VP9/Opus
to H.264/AAC, non-zero song clip start, source with no audio, fixed pixel and
rotation behavior, poster extraction, decoded A/V drift, wall time and peak
resources. It must also benchmark the same accepted operation through direct
FFmpeg and `@mediabunny/server`, test timeout/kill behavior, and exercise the
attempt winner/replay model. Cloudflare Container execution and cold-start
measurements remain provider-unverified and require a later authorized staging
exercise; they were not simulated here.
