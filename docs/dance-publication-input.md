# Private Dance input and ordinary Post ownership

The optional Post input starts after an accepted passed/public-on verdict. The
private review, its qualification and the ordinary Post have separate lifecycles.
`transferred` means the independent input entered normal video analysis, not that
the Post was published. The ordinary pipeline still owns publication checks.

Migration 0302 retains one input identity, generation and original deadline. The
body producer must trim the frozen recording body interval, exclude the cue,
measure the result and bind its digest, size and duration before requesting a
storage grant. The storage adapter proves the bytes; it cannot prove a trim or
infer permission to publish. Its admitted duration is six through thirty seconds
and its input ceiling is sixteen MiB.

`makeModeratedDancePublicationStorage` awaits the committed plan and one-shot PUT
grant before an R2 conditional write. It supplies the measured SHA-256 to R2.
Recovery verifies the exact key, ownership metadata, size, content type and
service-verified checksum. If the stored checksum is missing, recovery reads the
same version conditionally and checks a bounded body digest. A lost PUT reply or
grant COMMIT never authorizes another upload. A missing object stays unknown.

Migration 0304 gives cleanup one retained fence identity and one committed CAS
grant. The composed maintenance consumer runs with intake and Rewards disabled.
It selects expired, cancelled or invalidated inputs and permanently closes
adoption under the same lifecycle locks. At most two conditional fence writes are
allowed, with the second permitted only after a known conditional refusal. An
ambiguous storage effect or COMMIT only allows observation of the original fence.
Foreign or changed objects remain unresolved; they are never overwritten.

Cleanup acknowledges completion only after observing its fence's version, etag,
size and ownership metadata. The small fence contains no recording, remains at
the input key and prevents a late conditional writer from recreating the video.
An adopted input is excluded because the ordinary Post now owns it. Unresolved
cleanup or an expired unfinished input closes technical readiness. Unknown grant
outcomes may require reconciliation; elapsed time is not deletion evidence.

Local Workerd tests use real local R2 with an offline command journal. Native
PostgreSQL tests cover the real functions, lifecycle locks and restricted roles
with synthetic body identities and a storage stand-in. Neither proves actual
provider processing, production storage or phone acceptance.

The pinned body recipe trims the captured interval, removes recorded audio and
metadata, bounds the rendition, and preserves a partial final frame at a 48 kHz
timebase. Its private five-task provider decoder checks task identities,
dependencies, engine versions and the single output. The bounded output reader
checks the actual silent H.264 MP4 packet timing, edit list, complete media-data
coverage and measured digest before returning a storage plan. This input cannot
pass the ordinary two-track canonical master verifier.

The existing mandatory native media suite runs the actual command strings on
synthetic local FFmpeg 6.1.1. It proves six through thirty seconds, fractional
start/end boundaries, no recorded soundtrack or cue, and every output frame
against the source interval. This is not CloudConvert 6.1.4 conformance or a
phone recording proof.

Migration 0305 and the scheduled consumer connect that body to storage and
ordinary Post adoption. A captured processing-purpose allowance of at least
seven and a separate reservation under the existing account/global spend bounds
are required for the optional Post job. Six-purpose captures do not gain a new
budget implicitly. Every provider create grant commits with its original
liability first; lost replies observe only the same tag or job. A short-lived
source capability stores only its digest and cannot outlive the original
handoff deadline or captured media lease. Erasure and terminal input ownership
close that source. A late job identity can still become historical cleanup
knowledge without authorizing more processing.

Publication jobs have their own cleanup eligibility. The older capture's
screened/terminal state cannot delete a live handoff job. Stored/adopted or
cancelled inputs and the original deadline make that job disposable. Storage
PUT grants also recheck time after current song-rights lock waits. No replay,
timeout or job retry extends the transfer or retention window.

The consumer is composed under the existing Dance/media and video processing
flags; it runs a bounded handoff before longer capture/reference work. Real SQL
tests use provider, measured-body and storage stand-ins to prove one ordinary
analysis input after a lost create reply or storage reply. Separate native
FFmpeg and real local R2 tests prove those boundaries. Actual provider and phone
acceptance, dated operational admission, Post credit/state, connected client
views, cross-community authoring and release acceptance remain required.
