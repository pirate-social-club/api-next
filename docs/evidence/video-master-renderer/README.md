# Video master renderer spike — checkpoints 1 and 2

Status: two bounded local evidence checkpoints, 2026-09-02. This is not a runtime
implementation or a renderer selection. No credential, provider request, R2
object, Stream input, DATA operation, deployment, or production media was used.

## Result

Direct FFmpeg proves H.264 packet payload copy and AAC soundtrack replacement
are individually feasible, but the brief's exact last-complete-presentation-
packet rule is not a safe general packet-copy rule for H.264 streams with
B-frames. Reordered presentation can place an out-of-window reference packet
before in-window B-frames in decode order. Removing only the reference packet
produces a non-contiguous, potentially undecodable packet sequence.

The workspace owner resolved the condition after checkpoint 1:

- copy eligibility is server-probed and requires H.264, `has_b_frames=0`, equal
  presentation/decode timestamps, monotonic packet presentation, a real
  keyframe start, and a contiguous decode-order packet window;
- any reordered source demotes to frame-accurate transcode without changing
  the submitted snapped cut; and
- hidden decode-support packets and edit-list-bounded copied video are rejected.

The pure policy harness in
`scripts/video-master-renderer-packet-policy.ts` preserves the collision as a
regression test and implements the settled copy-eligibility fence.

## Checkpoint 2: accepted no-reorder copy profile

The executable harness in `scripts/video-master-renderer-ffmpeg-evidence.ts`
generates a video-only fragmented MP4 source and a separate canonical PCM song,
probes eligibility, derives the packet-shaped effective duration, invokes one
server-owned FFmpeg command template, and probes the resulting master. No
caller supplies an encoder, filter, map, codec, or process argument.

The frozen source is H.264/yuv420p at 320 by 180 and 30 fps, with a one-second
GOP and `-bf 0`. The accepted start is the probed keyframe at 1000 ms. For an
author request of 1887 ms, the last complete source packet ends at
2866.666 ms, producing an effective source window of 1866.666 ms and 56 video
packets. FFmpeg reported the copied master video duration as 1866.667 ms, one
15,360-Hz video time-base tick from the calculated value.

The versioned packet-manifest digest covers the ordered SHA-256 of every packet
payload plus its keyframe flag. Source and master both produced:

    576eb4d3516f91149df6fefcfc211b8d3487a41d5e15864ee22d5d641d8a36d7

All 56 source/master packet payload hashes and flags matched in order. The
master video therefore becomes the timeline authority at 1866.667 ms without
requiring whole-MP4 byte identity.

The fixed audio rule selected the canonical PCM interval beginning at 750 ms,
trimmed it to the effective target, and rounded 89,600 target samples up to
90,112 samples, exactly 88 AAC frames. Only 512 zero samples were added. The
AAC encoder emitted one 1024-sample priming packet marked `Skip Samples`, which
the MP4 edit excludes from presentation. Decoding all AAC packet payloads
returns the full 90,112 padded samples.

The first version of checkpoint 2 advertised only 89,568 presentation samples,
or 1866.000 ms, which was 32 samples short of the exact 89,600-sample video
duration. The loss was not an AAC-frame limitation. It came from the MP4
muxer's default 1000-Hz movie timescale: 28/15 seconds is not representable in
whole milliseconds, so the audio edit was written at 1866 ms.

Raising the server-owned movie timescale to 48,000 makes both 56 video frames
at 30 fps and 89,600 audio samples exactly representable. The corrected master
advertises 89,600 audio presentation samples and 1866.667 ms for both tracks.
Its audio edit has media time 1024 and duration 89,600, while its video edit
has media time zero and duration 28,672 video ticks; no video packet is hidden.

The isolation matrix showed:

- the default movie timescale produced 89,568 presented samples even with
  nine-decimal `-t`, manual padding, and `-shortest`;
- a 48,000-Hz movie timescale produced exactly 89,600 samples with or without
  manual padding;
- removing `-shortest` while retaining output `-t` still produced exactly
  89,600 samples; and
- removing output `-t` exposed all 90,112 padded samples and lengthened audio
  beyond video.

Manual 512-sample padding and `-shortest` therefore did not cause the deficit.
Output `-t` is the presentation fence, and the 48,000-Hz movie timescale makes
that fence sample-exact. The fixed template retains explicit padding so the
encoder input frame count is deterministic, retains `-shortest` as a defensive
bound, and asserts that decoded payload samples minus presented samples equals
exactly the terminal zero padding.

One corrected-template render-only observation on FFmpeg `6.1.1-3ubuntu5` took
135.8 ms. This
is fixture evidence, not a p95 or Container latency claim. The exact template
uses input seek at the probed keyframe, `atrim`, timestamp reset, AAC-frame
padding, `-t` at the derived video duration, `-shortest`, video `copy`, AAC at
48 kHz mono/128 kbps, `+faststart`, `-use_editlist 1`, and a 48,000-Hz MP4
movie timescale. Tests assert those fixed choices and reject a probe-reported
or packet-observed reorder.

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

Checkpoint 2 replaced the checkpoint-1 no-B-frame fixture with a video-only
source whose keyframes and timestamps begin exactly on the video time base. It
froze copied video as the master clock and the explicit AAC-frame padding and
MP4 presentation rule described above.

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

The next checkpoint must run the fixture matrix for WebM VP9/Opus to H.264/AAC,
fixed pixel and rotation behavior, poster extraction, decoded A/V drift, wall
time distribution, and peak resources. The no-audio source and a non-zero song
clip start are now covered on the copy path. It must benchmark the same accepted operation through direct
FFmpeg and `@mediabunny/server`, test timeout/kill behavior, and exercise the
attempt winner/replay model. Cloudflare Container execution and cold-start
measurements remain provider-unverified and require a later authorized staging
exercise; they were not simulated here.
