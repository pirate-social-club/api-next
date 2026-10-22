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

The production body-processing consumer, source capability and provider effect
budget/disposition still need implementation. Post credit, connected application
states, cross-community authoring and release acceptance remain separate work.
