# Song-video frame comparison gate

Policy revision 1 is a one-time qualification of the exact CloudConvert recipe
and independent decoder, defined before the watched production canary.
Ordinary posting does not run this workstation decoder per video. The gate
compares every decoded frame of an accepted CloudConvert master with its own
sealed video source, independently of the audio verifier. A passing staging
verdict qualifies the implementation on real accepted output. The production
release record must link this passing verdict before ordinary-user access. A
changed renderer recipe or decoder requires fresh qualification.

## Inputs and normalization

Read the accepted master, its frozen interval and its source binding from one
read-only database snapshot. Retrieve the exact immutable objects and verify
their recorded length, SHA-256 and ETag. Preserve the sealed source
object version separately: the API read exposes its ETag, not the binding
version. The master verifier uses a normalized ETag as its object version,
which is checked directly. No claim of a source-version readback is made. The comparator accepts local
files only and rechecks the lengths and hashes before and after processing.
An absent or changed object is a refusal, never a request to render again.

The provider recipe decodes source video, applies `fps=30`, trims to
`ceil(clip_duration_samples / 1600)` frames and resets video timestamps. It
encodes H.264 with libx264, `veryfast`, CRF 23, yuv420p and no B frames. The
comparison applies that same frame selection to the source and converts both
inputs to yuv420p. FFmpeg's normal display rotation is applied to both; neither
input is resized, cropped, mirrored or searched for a best matching offset.
The song's excerpt start selects soundtrack samples, not a source-video offset.

FFmpeg and ffprobe 6.1.1 are the pinned independent decoder on this workstation.
Their binary hashes and version output are retained. This does not restart or
reintroduce the workstation renderer. Source frame selection follows the
actual frozen FFmpeg 6.1.4 provider recipe; the independent decoder version is
reported separately. A future decoder change requires requalification.

The master must contain exactly the expected number of decoded video frames,
with a 1/48000 timebase and exact presentation timestamps `n * 1600` ticks.
The duration of every frame is 1600 ticks except the final frame, which ends
at the exact frozen sample duration. Dimensions must match the selected source
frames. A declared non-square sample aspect ratio is refused. An absent SAR
is the decoder's unspecified square-pixel display default, not missing timing
evidence. The actual provider masters omit SAR; this is retained in the probe. Counts, timestamps and duration are checked separately from similarity
so framesync cannot hide a short track or retimed output. Replacing a frame
with a duplicate at the same timestamp is judged by the content tolerance,
which can accept an indistinguishable duplicate in a static scene.

## Tolerance and its justification

Every frame must have SSIM All at least 0.95 and each Y/U/V plane at least 0.90.
Every frame must have PSNR All at least 30 dB and each Y/U/V plane at least
28 dB. A single violating frame refuses the master; a high average cannot mask
it. Missing, duplicate, non-finite or noncontiguous metrics refuse the result.
Positive infinite PSNR represents exact pixels and is accepted; SSIM must be
finite. The report retains all per-frame metrics and the worst values.

The H.264 CRF 23 recipe is lossy, so exact decoded-pixel hashes are not an
appropriate content-equivalence test. SSIM measures local image structure;
PSNR adds a separate pixel-error bound, including both chroma planes rather
than checking luminance alone. 30 dB bounds whole-frame mean squared error to
0.001 of the squared 8-bit range (RMS error about 8 code values); 28 dB gives
about 10 code values per plane. These conservative limits are an explicit
qualification policy, not a universal perceptual-quality standard. They are
frozen before evaluating provider outputs and must survive positive local
recipe controls and negative altered-frame controls. Failure must be retained;
do not relax a threshold to make the historical canary pass.

The gate establishes full temporal coverage and bounded decoded content
fidelity for the exact qualified master. Lossy tolerance cannot cryptographically
exclude small alterations, prove the provider's intent, or generalize from one
fixture to all device codecs. Input hashes prove provenance; comparison proves
the stated tolerance. Other production content, device and safety gates remain.

SSIM and PSNR statistics follow the [FFmpeg filter documentation](https://ffmpeg.org/ffmpeg-filters.html#ssim)
and [PSNR documentation](https://ffmpeg.org/ffmpeg-filters.html#psnr). These
sources define the metrics, not this project's numerical acceptance thresholds.

## Measured localized-alteration limitation

The qualification also measured opaque magenta corner squares against one
exact accepted-master frame, using lossless raw yuv420p so a second H.264
encode cannot blur the experiment. The frame is zero-based 225, at 7.5 seconds,
1080 by 1920 pixels, from the October 2 backend completion canary. Its
unaltered SSIM All is 0.988207 and PSNR All is 48.94 dB, exactly matching the
same frame in the full comparison. The original selected source stays fixed.

| Corner square | Frame area altered | SSIM All | PSNR All | Unchanged policy |
| --- | ---: | ---: | ---: | --- |
| 16 by 16 | 0.0123457% | 0.988123 | 46.31 dB | Pass |
| 32 by 32 | 0.0493827% | 0.987957 | 42.60 dB | Pass |
| 64 by 64 | 0.1975309% | 0.987412 | 37.41 dB | Pass |
| 128 by 128 | 0.7901235% | 0.985519 | 31.70 dB | Pass |

All plane limits also pass. A two-pixel square passes too. These are measured
accepted alterations, not evidence that the picture is unaltered. No universal
size boundary is inferred: contrast, location, source texture and color all
matter. The 64-pixel control is 4,096 altered luma pixels; the 128-pixel control
is 16,384. The numerical floors remain unchanged. Raw statistics and agreement
with the published frame-policy function are retained in the staging
qualification package's `localized-alteration-controls/` directory.

The release coordinator selected this user-delegated scope as one-time
recipe/decoder qualification, recorded in production task commit
`4915ba614fb6266530e54b73ee04812b39103016`. It does not replace provider trust
with cryptographic frame identity or add a decoder to every ordinary user's
video path. The production
record must preserve this residual trust when linking the passing verdict.
Requalify when the exact recipe or decoder changes. These limitation controls
are evidence, not a new production prerequisite.

## Execution and verdict

Run the offline comparator with a reviewed identity manifest. The manifest
binds submission, plan, attempt, accepted revision, source/master object
versions, hashes, byte lengths and sample duration. It contains no capability
URL or credential. Output goes to a new directory; historical evidence is
never overwritten. Non-zero exit means the gate is not passed, including tool
failure, malformed evidence or an incomplete comparison.

Retain the manifest, policy and code hashes, tool identity, raw probes,
per-frame SSIM/PSNR, summary verdict and positive/negative control receipts.
The owning task records the staging qualification. The production coordinator
links the passing qualification verdict before an ordinary-user access decision.
No deployment, database write, provider job, retry or access opening is an
operation of this command.
