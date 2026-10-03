# Song-video frame comparison gate

Policy revision 1 is defined before the watched production canary. The gate
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
