# Video ACR sampling: owner input

This is a decision brief, not an accepted policy. No recognition implementation,
provider request or fixture acceptance was performed. Video remains disabled and
its enabled composition refuses missing recognition. Staging approval method and
visual minor-safety provider selection remain independent owner decisions.

## Existing policy and provider evidence

The song helper mediaTransformSampleWindow in application/media/transform.ts
chooses L=min(D,12000) milliseconds, with primary offset floor((D-L)*0.25)
and alternate floor((D-L)*0.75). Video can reuse that pure policy if ratified;
it cannot reuse MP3 frame slicing on arbitrary bytes of the sealed M4A.

Qencode documents MP3 and M4A audio outputs and per-output start_time and duration
in seconds. Its format array permits both clips alongside the full soundtrack
in one audio task. MP3 needs output=mp3; the documented M4A example uses
output=m4a, audio_codec=libfdk_aac. Independently encoded clips contain their own
container metadata. The tutorial has stale wording restricting audio outputs to
MP3/HLS despite its M4A examples, so fixture proof remains necessary.
[Audio outputs](https://docs.qencode.com/tutorials/transcoding/audio-outputs/),
[Transcoding reference](https://docs.qencode.com/api-reference/transcoding/).

ACRCloud lists MP3, M4A and MP4 among supported inputs. Its API table says sample
size must be below 5M bytes; an example comment recommends below 1M and the page
recommends samples shorter than 15 seconds. These are different statements, not
a documented hard 15-second limit. The repository adapter's accepted limits must
remain enforced: current composition caps the sample at 4,000,000 bytes.
Documentation does not authorize widening that ceiling. Whole-file
upload is not evidence that the service scans every instant. A live AAC-in-MP4
fixture has not been run here.
[Identification reference](https://docs.acrcloud.com/reference/identification-api/identification-api).

## Options and calculated transfer cost

Numbers below are estimates at an illustrative 128 kbit/s, not a selected bitrate
or quoted provider price. Container overhead is additional; actual bytes must be
measured and capped. Costs exclude the existing full soundtrack output, original
video fetch, metadata, status polls and retries. Two outputs can be created in
one existing Qencode audio job; the ACR alternate invocation policy is itself
owner input, not automatically a second call after every primary.

| Option | Incremental encoded payload at D>=12 seconds | ACR calls | Coverage |
| --- | --- | --- | --- |
| Two independently encoded MP3 clips | About 192,000 bytes each, 384,000 total | One primary, at most one alternate before retries | At most 24 seconds of selected windows |
| Two independently encoded M4A/AAC clips | About 192,000 bytes each, 384,000 total | Same | Same windows; direct container acceptance needs fixture |
| Existing whole M4A | No additional Qencode output; up to current 8,000,000-byte artifact cap transferred to ACR | One per attempt | Whole file submitted, recognition coverage unproven; large artifacts exceed API ceiling |

With both clips downloaded and sealed, approximate incremental Qencode-to-R2
payload is 384,000 bytes. ACR upload adds about 192,000 bytes for primary only or
384,000 for both, giving roughly 576,000 or 768,000 transferred payload bytes
across those legs. Add R2 reads, multipart overhead and any retries separately.
Per-request billable rates depend on the account; no monetary estimate is claimed.

For a 180-second video, windows are 42–54 and 126–138 seconds: 12/180=6.7%
coverage for one, 24/180=13.3% for both. For shorter videos windows may overlap;
union length is L+min(L,alternateOffset-primaryOffset), not always 2L. At D<=12
seconds both offsets are zero and the alternate adds no coverage. Sampled no-match
cannot certify the absence of copyrighted material elsewhere in the soundtrack.

## Evidence needed before selection

Use known recognizable audio at each selected offset, silence at the other, and
a recognizable segment outside both windows. Confirm independently decodable
outputs, measured offsets/durations, content type, size, ACR result and alternate
trigger behavior. Run the same fixtures for MP3 and M4A candidates. Confirm the
actual accepted adapter sample/request ceilings and bound retries separately from
logical request counts. Do not send owner media as an unapproved fixture.

The owner chooses container, bitrate/channel settings, whether to adopt song
windows, alternate trigger and no-match interpretation after these fixtures.
MP3 maximizes reuse of the current song sample path; M4A may avoid a second codec
but still requires separate clipped outputs. Neither is ratified by this brief.
