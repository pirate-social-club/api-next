# Video master renderer spike — checkpoints 1 through 9

Status: five bounded local evidence checkpoints, 2026-09-02. This is not a runtime
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

- copy eligibility is server-probed and requires H.264, trusted
  `has_b_frames=0`, non-regressing presentation timestamps in decode order, a
  verified IDR access unit at the exact copy start, and a contiguous
  decode-order packet window;
- any reordered source demotes to frame-accurate transcode without changing
  the submitted snapped cut; and
- hidden decode-support packets and edit-list-bounded copied video are rejected.

The pure policy harness in
`scripts/video-master-renderer-packet-policy.ts` preserves the collision as a
regression test and implements the settled copy-eligibility fence.

Checkpoint 3 corrects two over-narrow checkpoint-2 assumptions. PTS does not
have to equal DTS: constant or varying decode/presentation offsets are accepted
when presentation does not regress in decode order and the trusted stream probe
reports zero reorder capacity. Minimum and maximum offsets are retained as
diagnostics and are not eligibility inputs. A generic container keyframe flag
is no longer sufficient either. The exact start packet must also pass a bounded
four-byte AVCC reader and contain H.264 NAL type 5, an IDR slice. The reader
fails closed above 4 MiB or 256 NAL units and on truncated lengths, discontinuous
ffprobe hex output, forbidden header bits, or malformed units. A synthetic
packet marked as a keyframe but containing only a non-IDR type-1 intra slice is
the negative regression fixture and demotes from copy.

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

The fixed stereo audio rule selected the canonical PCM interval beginning at
750 ms, trimmed it to the effective target, and rounded 89,600 target samples
per channel up to 90,112 samples per channel, exactly 88 AAC input frames. Only
512 zero samples per channel, or 1,024 total sample values, were added. The AAC
encoder emitted 89 packets: 88 content/padding packets plus one 1024-sample-per-
channel priming packet marked `Skip Samples`. That priming represents 2,048
sample values and is excluded by the MP4 edit. Decoding all AAC packet payloads
returns 90,112 samples per channel, or 180,224 total sample values.

The first version of checkpoint 2 advertised only 89,568 presentation samples,
or 1866.000 ms, which was 32 samples short of the exact 89,600-sample video
duration. The loss was not an AAC-frame limitation. It came from the MP4
muxer's default 1000-Hz movie timescale: 28/15 seconds is not representable in
whole milliseconds, so the audio edit was written at 1866 ms.

Raising the server-owned movie timescale to 48,000 makes both 56 video frames
at 30 fps and 89,600 audio samples per channel exactly representable. The
corrected stereo master advertises 89,600 samples per channel, or 179,200 total
sample values, and exactly 1866.667 ms for both audio and video. Its audio edit
has media time 1024 and duration 89,600, while its video edit has media time
zero and duration 28,672 video ticks; no video packet is hidden.

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

One checkpoint-3 corrected-template render-only observation on FFmpeg
`6.1.1-3ubuntu5` took 106.0 ms. This is fixture evidence, not a p95 or Container
latency claim. The exact template
uses input seek at the probed keyframe, `atrim`, timestamp reset, AAC-frame
padding, `-t` at the derived video duration, `-shortest`, video `copy`, AAC at
48 kHz stereo/128 kbps with an explicitly pinned `stereo` channel layout,
`+faststart`, `-use_editlist 1`, and a 48,000-Hz MP4
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

Checkpoint 3 probes the exact start packet's bytes rather than trusting its
container keyframe flag. The accepted fixture begins with NAL type 5 at the
submitted 1000 ms start. Its 56 copied packet payloads still match the source
segment byte-for-byte under the same manifest digest, and the master still has
no hidden support packet or edit-list-hidden video. The timestamp policy tests
also prove that both constant and varying PTS-minus-DTS offsets remain
copy-eligible when presentation is monotonic and the trusted reorder-capacity
probe is zero.

## Checkpoint 4: fallback, recovery, and local resources

The credential-free fallback harness generates a 360 by 640 WebM containing
VP9 video, Opus captured audio, and a non-square 4:3 pixel aspect ratio. It
starts the accepted cut at 400 ms, between the fixture's two-second keyframes,
and fully decodes the source rather than rounding the cut. The fixed template
replaces captured audio with a canonical stereo PCM interval beginning at
1,250 ms, renders 54 H.264 frames at 320 by 568 and 30 fps, normalizes the
pixel aspect ratio to 1:1, and writes AAC stereo in MP4.

Both output tracks probe at exactly 1,800 ms, a measured A/V delta of zero for
this fixture. The MP4 exposes exactly 86,400 audio samples per channel. The
decoded AAC payload contains 87,040 samples per channel, so the public edit
excludes the 640-sample terminal AAC-frame padding without extending the video.
A 900 ms poster was extracted from the normalized final master and probed at
320 by 568. This proves the local VP9/Opus fallback, non-keyframe-start
transcode, audio replacement, pixel-aspect normalization, final-timeline poster,
and exact fixture-level A/V bound. It does not prove arbitrary browser WebM,
rotation metadata, or a fleet-wide tolerance.

One direct fallback render on the local FFmpeg build took 305.3 ms wall time,
0.57 user CPU seconds, 0.15 system CPU seconds, and 140,944 KiB maximum resident
set according to GNU time. These are one synthetic observation on the host,
not p95, concurrency, limit-enforcement, or Container evidence.

The isolated compare-and-set model now covers attempt-scoped immutable hash and
probe facts, first-valid-winner selection, a response lost after commit,
winner observation on retry without renderer reinvocation, duplicate and
byte-divergent loser disposition, invalid-probe disposition, and canonical
master replacement rejection. It models the required database transition but
does not claim a PostgreSQL transaction, object-store cleanup, or crash-safe
production adapter.

## Checkpoint 5: remaining host boundaries

A one-second H.264 MP4 fixture is remuxed with a 90-degree display matrix. The
fixed transcode lets FFmpeg apply that display transform during decode, bakes
the result into a 320 by 568 H.264/yuv420p master, normalizes sample aspect to
1:1, and explicitly clears rotation metadata. The input probes as stored 320 by
180 with 90-degree display rotation; the 30-frame output probes as 320 by 568
with zero display rotation. This is host evidence for MP4 display matrices, not
an assertion about every camera or container's orientation metadata.

Canonical-song coverage is now decided in integer 48 kHz sample coordinates.
The half-open interval is accepted when its exclusive end equals the probed
canonical duration and rejected when the song is even one sample short. The
validator also fails closed on fractional, negative, empty, and overflowing
timelines before rendering.

The host-boundary harness gives probe and process failures a fixed public
`invalid_source` response and retains only a SHA-256 of private diagnostics in
the returned evidence. A corrupt MP4 whose path and bytes contain a private
marker is rejected without either value appearing in the public failure. The
same bounded runner kills an intentionally hung process after 150 ms and a
process that exceeds a 1,024-byte diagnostic cap. A 1,025-byte attempt artifact
is rejected against a 1,024-byte fixture limit, and the attempt directory is
removed after the timeout drill.

A local semaphore capped at two permits completed six synthetic jobs while
observing at most two active jobs. This proves the isolated scheduling primitive
and the diagnostic, time, and attempt-disk boundaries. It does not enforce or
prove production CPU, memory, filesystem, or container quotas.

Five repeated direct-FFmpeg fallback renders on the otherwise uncontrolled
development host measured 234.8/267.1/1136.1 ms minimum/median/maximum wall
time. User CPU was 0.50/0.58/0.85 seconds, system CPU was
0.11/0.12/0.22 seconds, and maximum resident set was
140,228/140,736/140,952 KiB. The outlying wall sample is retained. Five serial
synthetic runs are enough to expose host variance, but not to establish a p95,
capacity limit, or production latency budget.

## Candidate feasibility

Direct FFmpeg is now a GO as the reference renderer and initial implementation
candidate for both the accepted copy path and WebM fallback. It can express the
fixed command templates without accepting raw arguments from a caller. This is
not a production-environment GO: the executable must still be pinned and
wrapped with process, isolation, persistence, and cleanup limits.

`@mediabunny/server` is installable and its current typed Conversion API exposes
trimming, automatic encoded-sample copy when compatible, forced transcode, and
composable outputs. Checkpoint 5 created a fresh temporary project outside the
repository and installed exact `mediabunny@1.55.5` and
`@mediabunny/server@1.55.5`, resolving `node-av@6.1.1`. The server package's
resolved integrity was:

    sha512-Yow7q+vIAPIqB1ptWWM5fDmLOsqed/qX1zglibKnYzeAu0fG6Asc3x8cOsa3405gLGfxh1790haa/eJl3M/UOg==

Registration with hardware acceleration disabled succeeded. The benchmark used
two composable conversions targeting one in-memory-fast-start MP4: the WebM
conversion discarded captured audio and forced VP9 video to AVC at 320 by 568,
30 fps, from 0.4 through 2.2 seconds; the WAV conversion discarded video and
forced the canonical 1.25-through-3.05-second interval to 48 kHz stereo AAC at
128 kbps. Output start, both conversions, and output finalize were all owned by
the benchmark.

The operation aborted before producing evidence under both repository runtimes.
Bun 1.4.0 reported `malloc(): corrupted top size` and then a Bun native panic.
Node 24.14.0 reported a fatal glibc `_int_malloc` arena assertion. The temporary
install had two lifecycle scripts blocked by Bun's default trust policy; they
were not enabled or retried. This is a reproducible NO GO for this exact pinned
temporary installation and operation on the local host. It does not establish
that composable two-input output is impossible or assign the fault to
Mediabunny, NodeAV, Bun, glibc, or the scheduling pattern without a smaller
upstream reproducer. No product dependency or lockfile changed.

Current Cloudflare documentation says Containers run Linux amd64 images with
ephemeral disk, typical cold starts often in the one-to-three-second range,
and Durable Object container `exec` has no built-in timeout. A caller must
enforce process termination and independently persist attempt state and sealed
outputs. These facts are compatible with continued evaluation but are not a
GO for the provisional two-second acknowledgement or render p95 targets.
There is no Worker/Container wrapper in this spike and no suitable local
FFmpeg container image was already present. Creating a new deployment topology
or pulling an image solely for this checkpoint would not establish the required
production behavior, so no local Container execution was claimed.

## Checkpoint 6: local container resource enforcement

The environment continuation added a credential-free local Docker harness. It
builds from the locally cached Linux amd64
`oven/bun@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6`
base and installs the distribution FFmpeg package inside the evidence image.
The resulting local image was
`sha256:6bc9adbe4adf3fd9ae2fbe5ac5c2ecca75605f38eaf768426888af950e95961c`.
The installed package and executable both reported FFmpeg
`7.1.5-0+deb13u1`. The local image id is reproducibility evidence for this run,
not a production image pin: the Debian package source is not frozen by this
Dockerfile.

The runtime had no network, a read-only root filesystem, a 512 MiB `noexec`
tmpfs, one CPU, no swap beyond the memory allowance, and explicit memory and
PID cgroups. Two real four-second 640 by 360 H.264/AAC renders started
concurrently. Each FFmpeg command limited filter threads to one and general
threads to two so the process topology was an explicit renderer-owned input.

Two runs with a 64-PID ceiling failed with Docker exit 245, first at 384 MiB
and then at 768 MiB. A complete single render succeeded at 384 MiB with the
same 64-PID ceiling. Those observations isolate the rejection to the
two-render concurrency envelope rather than establish an out-of-memory floor;
the removed failed containers did not retain enough state to assign the exact
child failure. The harness therefore does not label those failures OOM kills.

With only the PID ceiling raised to 128, the two-job run succeeded at 384 MiB.
The container reported `cpu.max` as `100000 100000`, `memory.max` as
402,653,184 bytes, `memory.peak` as 133,926,912 bytes, and `pids.max` as 128.
Both jobs overlapped, both outputs probed at exactly 4,000 ms, and a root write
probe failed as required. This proves that the local Docker engine enforced the
observed cgroup and filesystem envelope for this synthetic concurrency case.
It establishes neither a production budget nor Cloudflare Container behavior,
cold starts, fleet contention, durable attempt recovery, or a latency target.

The executable entrypoint is
`scripts/video-master-renderer-container-evidence.ts`; its focused policy test
freezes the Docker isolation arguments and rejects incomplete or mismatched
cgroup facts. The sibling Dockerfile and harness remain isolated from Worker,
publication, provider, R2, Stream, and DATA composition.

Checkpoint-6 verification passed three focused container-policy tests, all 32
renderer tests, focused Biome, the complete `bun run check`, and
`git diff --check`. The full test command passed 2,858 unit tests, 20 Node
tests, and the 72- and 48-test Workerd groups before one unrelated Self SDK
construction test exceeded its five-second timeout. That exact two-test group
passed on an immediate isolated rerun in 2.03 seconds, and the remaining
nine-test HNS verifier group passed separately. The original aggregate command
therefore remains a failed invocation with a resolved transient test result;
it is not reported as an uninterrupted full-gate pass.

Sources retrieved 2026-09-02:

- https://developers.cloudflare.com/containers/
- https://developers.cloudflare.com/containers/concepts/architecture/
- https://developers.cloudflare.com/containers/platform/limits/
- https://developers.cloudflare.com/durable-objects/api/container/

## Checkpoint 7: immutable image, attributable limits, measured overlap

This checkpoint narrows checkpoint 6's claims and replaces its weakest evidence.
It is still local Docker evidence on the development host. It is not independent
review, a Cloudflare Container selection, a deployment, a production budget, or
live proof. No credential, provider request, R2 object, Stream input, DATA
operation, or production media was used.

### Corrections to checkpoint 6

Checkpoint 6 reported that the container "enforced the observed cgroup and
filesystem envelope". It did not establish that. It read the configured limits
from `/sys/fs/cgroup` and observed that two processes existed at one instant and
eventually succeeded. Reading a limit is not enforcing it, and coexistence at a
single observation point is not overlap. Four specific claims are corrected here:

- the configured limits are now exercised to rejection rather than only read;
- concurrency is now measured across an interval rather than sampled once;
- the accepted canonical-replacement recipe now runs inside the image, which
  checkpoint 6 never did; and
- the read-only root denial is now attributed to the mount rather than assumed.

The two 64-PID failures from checkpoint 6 are also no longer unexplained. That
checkpoint removed the failed containers, so the cause was recorded as unknown
and deliberately not labelled an out-of-memory kill. It is now reproduced with
its state retained, and the cause is established below.

### Immutable image inputs

The Dockerfile no longer installs a rolling distribution package. The base image
stays digest-pinned, package indexes come from the fixed snapshot
`20260901T000000Z` on `snapshot.debian.org` rather than a mutable mirror, and
FFmpeg is pinned to exactly `7:7.1.5-0+deb13u1`. The build asserts the installed
version equals the pinned version and writes both facts into
`/etc/renderer-image-facts`, so an upstream change fails the build instead of
silently changing the renderer under test. The harness re-reads those facts from
a running container and rejects any drift from the recorded pin.

Two limits remain. Docker image ids are not bit-reproducible across builds even
with identical inputs: two builds in this checkpoint produced
`sha256:0428b576...` and `sha256:a36544cb...`. The recorded id therefore proves
which image a given run used, not that a future rebuild reproduces it
bit-for-bit. Reproducibility here rests on the pinned inputs and the asserted
package version, not on a stable image digest. `snapshot.debian.org` is also an
external dependency of the build, though not of the render.

### The accepted recipe inside the image

Checkpoint 6 rendered `testsrc2` and a sine tone inside the container. That is
not the canonical-replacement recipe. The accepted recipe from checkpoint 2 now
runs inside the pinned image, executed from the same
`scripts/video-master-renderer-ffmpeg-evidence.ts` module the host evidence uses,
with the repository mounted read-only so the container cannot alter the recipe it
is proving.

Inside the image the recipe reproduced every checkpoint-2 fact exactly: the same
56 selected video packets, the same source and master packet manifest digest
`576eb4d3516f91149df6fefcfc211b8d3487a41d5e15864ee22d5d641d8a36d7`, matching
copied payloads, 89,600 target and 90,112 padded samples per channel, 512 zero
padding samples, 1,024 priming samples per channel, 89 AAC packets for 88 padded
frames, a 48,000-Hz movie timescale, and 1866.667 ms on both tracks. The master
SHA-256 was `faa814234d417083f980deaf1f1bf9ef8a7bf9cc87b44f6279101abb90e6270b`.

That digest is identical to the host result, which is a stronger observation than
intended: the host runs Ubuntu FFmpeg `6.1.1-3ubuntu5` and the image runs Debian
`7.1.5-0+deb13u1`, so this fixed template produced a byte-identical master across
two FFmpeg major versions. That is one fixture on two builds, not a general
cross-version guarantee, and it does not remove the need to pin the executable.

### Measured sustained overlap

Concurrency is now sampled every 100 ms from `/proc`. A sample counts as overlap
only when both encoders are in a live process state and both accumulated CPU time
since the previous sample, so two processes that merely exist together are not
counted. The final run recorded 19 samples, 19 with both live, and 18 consecutive
busy samples, giving 1,920 ms of measured overlap across a render pair that each
produced exactly 4,000 ms of output. Earlier runs in this checkpoint measured
2,360 ms and 2,270 ms. The validator rejects any run with fewer than two
consecutive busy samples or less than two sampling intervals of overlap, so a
single-instant observation can no longer pass as concurrency.

The same run peaked at 88 PIDs and 134,049,792 bytes against the 384 MiB ceiling.

### Attributable limit rejection

Three drills now exceed a deliberately reduced ceiling and keep the failed
container so the rejection can be attributed. A drill that merely succeeds proves
nothing about a limit, and a discarded container cannot be diagnosed.

Memory: allocating 600 MiB against a 128 MiB ceiling reached the ceiling 37
times, recorded one `oom` and one `oom_kill` in `memory.events`, killed the
allocation with exit 137, and left `OOMKilled` true in the retained container
state. The memory limit is enforced, not merely configured.

Processes: 40 background forks against a 16 PID ceiling recorded one
`pids.events max` event, peaked at exactly 16, kept `memory.events oom_kill` at
zero and `OOMKilled` false, and retained the `Cannot fork` diagnostic.

Concurrent renders at 64 PIDs: this reproduces checkpoint 6's unexplained
failure. One of the two renders exits 245 while the other completes; which one
fails varies between runs. The retained container carries the FFmpeg diagnostic
`pthread_create() failed: Resource temporarily unavailable`, `pids.peak` reaches
exactly 64, `pids.events` records one ceiling event, `memory.events oom_kill` is
zero and `OOMKilled` is false. The checkpoint-6 failures were PID exhaustion
during thread creation, and specifically not out-of-memory kills.

This also explains why raising the ceiling to 128 fixed it, without the earlier
inference from "it worked afterwards". The successful two-render workload peaks
at 88 PIDs, so a 64 ceiling cannot admit it and any production ceiling for two
concurrent renders of this profile must exceed 88. That number is specific to
this profile and its explicit one-filter-thread, two-general-thread topology.

### Read-only root attribution

Checkpoint 6 concluded the root filesystem was read-only from a failed write at
`/`. An unprivileged user's write to `/` fails whether the mount is read-only or
merely not writable by that user, so that observation did not separate the two.
The probe now also writes into `$HOME`, which is owned by the container user
`bun` with mode 700, so a permission denial there is impossible. Both writes
failed as `Read-only file system`, and `/proc/self/mountinfo` reports the root
mount options as `ro,relatime`. The denial comes from the mount.

### Verification

The focused container-policy suite now holds 31 tests, including negative cases
that reject a drifted package pin, a non-digest image id, a diverged packet
manifest, soundtrack sample accounting that does not add up, single-instant
concurrency, a drill that never reached its ceiling, a PID failure that also ran
out of memory, a failure with no retained diagnostic, and a permission denial
presented as a read-only mount. All 60 renderer tests passed, and the complete
`bun run check` passed with exit 0.

### Still open after this checkpoint

Durable recovery is unproven and is the next checkpoint. Nothing here shows that
a crash or a lost render response cannot produce a second accepted master through
persisted database state and object bytes; the compare-and-set model from
checkpoint 4 remains an isolated in-memory model. Cloudflare Container selection,
cold starts, fleet contention, remote bindings, production budgets, and every
provider and live path also remain unproven, as does phase-two device evidence.

## Checkpoint 8: PostgreSQL and persisted-object recovery

The durable-recovery harness replaces the checkpoint-4 in-memory model with a
real local PostgreSQL 17 database and a filesystem-backed immutable object
adapter shared by separate Bun worker processes. The final evidence run used
local image
`sha256:e38411452a464af89e5adadb8d223bf53b898d47d6ef918b2d58c08707350449`.
The database stayed running while renderer processes exited and restarted. The
object adapter wrote actual bytes under attempt-scoped, hash-bearing keys; the
payloads were synthetic evidence bytes rather than encoded video masters.

The harness created five operation winners from six render attempts. Every
attempt, winner, object key, SHA-256, process id, disposition, and render
invocation was persisted and read back from PostgreSQL. Process-event rows show
that the write-before-acceptance crash recovered across two process ids and the
accepted-but-response-lost case used three process ids for write, commit, and
replay. Their render invocation counts remained exactly one.

The write-before-acceptance process exited after persisting its attempt row and
object bytes but before inserting a winner. The next process verified those
same bytes and committed that attempt as the winner without rendering again.
Checkpoint 9 below replaces the two-state model this paragraph describes; the
observed behaviour is unchanged, but the attempt now passes through an explicit
started and sealed transition.
The lost-response process committed its winner and exited before returning a
result; replay observed the persisted winner and verified its object hash
without adding an invocation.

Two processes then raced different hashes for one operation. One serializable
transaction won. The other first received PostgreSQL SQLSTATE `40001`, retried
the transaction, observed the winner, and recorded its attempt as a divergent
loser. The winner row and object key did not change. This is the expected
database concurrency behavior and makes the transaction retry part of the
evidence rather than hiding it behind an in-memory lock.

Loser cleanup deleted the divergent object and then deliberately exited before
recording disposal. A later process treated the absent object as an idempotent
delete, marked the loser disposed, and left the accepted object intact. Separate
accepted winners were then corrupted and removed. Replay returned typed
`winner_bytes_corrupt` and `winner_bytes_missing` results, retained the original
winner rows, and did not render or accept replacements.

The credential-free evidence command is:

    VIDEO_RENDERER_DURABLE_RECOVERY_EVIDENCE=1 bun test \
      scripts/video-master-renderer-durable-recovery-evidence.test.ts \
      --max-concurrency=1

It passed one composed drill with 14 assertions. The full renderer selection
passed 60 ordinary tests with this Docker-dependent drill skipped by default;
enabling it passed the additional test. The complete `bun run check` passed.
Every temporary PostgreSQL container and object directory was removed.

This proves local recovery semantics, not a production adapter. PostgreSQL did
not restart, the object adapter is a local filesystem rather than R2, and no
provider response, Worker, Workflow, Stream, DATA, deployment, credential, or
live media was involved. It does not prove R2 conditional writes, remote object
visibility, production transaction routing, or recovery after simultaneous
database and object-store loss.

Two further limits belong on this list. The drill's termination evidence is a
parent process observing a child exit, which is stronger and cheaper than any
evidence a distributed deployment will have; a real environment must establish
that a stopped worker is conclusively stopped before reusing this abandonment
path, and a lease, fence, or provider-side termination signal is the open design
question. Attempt abandonment also proves absence of output by listing a local
directory, which a remote object store cannot answer with the same certainty.
Repeated observation of an accepted winner with damaged bytes still appends an
integrity event each time; only the pending and sealed-integrity paths are
proven not to grow the log.

## Checkpoint 9: explicit attempt lifecycle and stopped-attempt abandonment

Checkpoint 8 committed the attempt row before writing the object bytes and had
no state between the two. A process stopped in that window left a row whose
object never existed. Recovery selected that row, failed to verify its object,
and threw an untyped error; because the row was never advanced, every later
observation re-selected it, threw again, and appended another recovery event. A
reproduction against the real database ended with three recovery events, zero
winners, and no reachable path to a replacement render. The operation was
permanently wedged. Checkpoint 8 did not cover this window and did not list it.

The ordering is deliberately unchanged. Writing bytes before the attempt row
would move the same ambiguity into an unrecorded orphan window and weaken the
persisted attempt identity. A missing object also cannot by itself distinguish a
worker that stopped before writing from one that is still rendering or one whose
write outcome is uncertain, so a missing object never authorizes a new render.

The attempt now carries an explicit lifecycle. It is recorded as `started`
before the renderer is invoked, so any later stop is attributable to a known
attempt. It becomes `sealed` only after the immutable object is written and
independently verified, with its hash and byte-length probe persisted in the
same transaction, so a sealed row always implies durable verified bytes. A
database constraint enforces that started and abandoned rows carry no object
identity and every other state carries one. Acceptance operates only on sealed
attempts.

Recovery of a `started` attempt returns a typed `attempt_pending` result. It
authorizes no render and deliberately writes no event, so repeated observation
cannot grow the log. The drill observes a stopped attempt three times, receives
the same typed result each time, and measures event growth of exactly zero.

Abandonment is the only path from `started` to a replacement render, and it
requires termination evidence rather than an absent object. In this local drill
the parent process observing the child exit is that evidence; the observed exit
code and observer process id are persisted in a `renderer_terminations` row.
Abandonment additionally refuses whenever completed output might exist. A
stopped attempt whose object write did land is refused as
`attempt_output_present` with reason `object` and stays `started`, and an
attempt that already produced an accepted winner is refused as
`attempt_not_stopped`. Only after a clean abandonment does observation return
`render_required`, and the drill then proves exactly one replacement attempt
succeeds, leaving that operation with two render invocations.

Observation while the original worker is still running returns the same typed
pending result and starts no second render. The drill observes a deliberately
held attempt mid-render, then lets it seal and accept normally; that operation
ends with exactly one render invocation and its original attempt as the winner.

A sealed attempt whose bytes later disappear is now also typed rather than
thrown, as `sealed_bytes_missing` or `sealed_bytes_corrupt`, and is never
replaced. Sealing verified those bytes, so their loss is an integrity failure on
the same rule as a winner with missing bytes rather than an uncertain outcome.
This extends the ruling beyond the transition that was specified, because the
untyped throw there was the same wedge one state over; it changes observability
only, never the no-replacement policy.

The drill now produces seven winners and passes 26 assertions. Recovery of an
accepted winner with missing or corrupt bytes remains an integrity failure that
retains the original winner row and never permits replacement, unchanged from
checkpoint 8.

## Still unverified

Arbitrary container/codec rotation metadata, broader hostile-media parsing,
production timeout behavior, Cloudflare-enforced CPU and memory limits,
persistent-disk quotas, and real cleanup after crashes remain unverified. The
local Docker checkpoint now covers enforced cgroups, a read-only root, and two
concurrent real FFmpeg jobs for one synthetic profile. The MP4 display-matrix
case, corrupt-source redaction, exact
canonical-song coverage rejection, process timeout/kill, diagnostic and attempt
artifact bounds, local semaphore, and five-run host distribution are now
covered in addition to the earlier media cases.

The local PostgreSQL and filesystem-object drill now covers renderer-process
crash recovery, acceptance-response loss, database contention, interrupted
loser cleanup, and missing or corrupt winner bytes. The direct-FFmpeg versus
`@mediabunny/server` comparison ended in a pinned local
native abort before media output, so it has no packet, timing, or resource result
to compare. Cloudflare Container execution, cold starts, remote binding
behavior, staging R2 reads, Stream ingest, and durable PostgreSQL claims remain
provider-unverified and require a separately authorized staging exercise; none
was simulated here.

## Local gates

The post-checkpoint `bun run check` completed successfully. Both Effect
diagnostic passes reported zero findings, both TypeScript projects passed, and
the contract, dependency, migration, and generated-client checks passed. Biome
reported its existing deprecated-configuration notice and 42 existing karaoke
non-null-assertion warnings without failing the gate; no renderer path was in
those warnings.

The complete `bun run test` gate also passed: 2,847 Bun unit tests, 20 Node
tests, and four Workerd groups containing 72, 48, 2, and 9 tests. Workerd
reported that two optional staging RPC variables were absent; no test failed
and no external provider operation was attempted. The final focused renderer
and secret-boundary run passed 36 tests before the full suite.

After checkpoint 5, the complete `bun run check` passed again with the same 42
unrelated karaoke warnings and configuration notice. The affected full
`bun run test:unit` suite passed 2,855 tests across 440 files, and the focused
renderer plus secret-boundary run passed 44 tests. Node and Workerd integration
suites were not rerun after checkpoint 5 because the changes are isolated host
scripts and evidence; their last complete run is the checkpoint-4 result above.
