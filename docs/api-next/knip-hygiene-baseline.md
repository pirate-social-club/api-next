# Knip hygiene baseline

Raw Knip runs as `bun run knip` and exits nonzero while reviewed findings
remain. The enforcing `bun run check:knip` ratchets the tracked categories and
is part of `bun run check`. This document records the reviewed baseline and the
rationale for every class of retained finding, so the gate does not treat
static unreachability as a product-deletion signal.

## Status

At branch base the report showed 1 unused file, 113 unused exports, 114 unused
exported types, and 8 duplicate-export groups. The hygiene lane reduced that to
0 unused files, 62 unused exports, 81 unused exported types, and 0 duplicate
groups. The remaining findings are intentional package and future-lane surface,
described below.

The 2026-08-29 ratchet lane reproduced 0/71/90/0 at pinned audit commit
`6bca114194f7ac3bae95a2a94ed5c1138d166f3d` and again at implementation base
`0208464`. It removed or de-exported only proven-unowned or file-internal
surface, reducing the baseline at that checkpoint to 0/58/80/0. At the 2026-09-05
planning base `origin/main@6190357f4489ffcdeca041c01592418f0883b316`, the
measured report was already 0/53/79/0: five exports and one type of headroom
had accumulated through accepted changes after the ratchet record. This lane
removed 16 reviewed export findings and leaves the current baseline at
0/37/79/0; its type count is unchanged at 79. The machine-readable counterpart
is `knip-hygiene-baseline.json`; `bun run check:knip` requires the two records
to agree and rejects increases.

## Retained findings and rationale

The compile-only verification provider fixture is exempted in `knip.json`
because `scripts/check-deps.test.ts` walks it by name and the dependency-matrix
gate fails without it. It is coverage, not dead code.

The media lane accounts for the largest share. `media-provider-contracts`,
`media-identification-provider`, the `ipfs-pinning` port, the
`filebase-ipfs-pinning` and ACRCloud and ElevenLabs and OpenRouter adapters, and
the media outbox and submission repositories export provider-neutral seams that
the media processor and upload lanes will consume. Their lane tasks are
`planned` or `blocked` in the workspace register, so the exports have no caller
today by design, not by accident.

The verification provider modules were reclassified during the hygiene lane.
Their clock, identifier, digest, and presentation constants are internal
implementation exports used only within their defining modules, not consumed
through the provider registry. The registry uses static imports and reads only
the provider factories, transports, and a few manifest types. Where a provider
constant or type had no concrete external consumer it was de-exported or
removed; what remains in the Knip report is the provider factories and manifest
surface the registry and tests actually import.

The domain feed constants are completed Lane B ports. Video scoring and
selection are recorded complete in spec 002 and remain staged domain core even
though the active home-feed use cases are separate.

The three remaining domain media-submission exports, `mediaSubmissionInvariant`,
`assertMediaSubmissionInvariant`, and `mediaSubmissionMachine`, are the reducer
invariant suite and machine shape for the media submission state machine. They
belong to the media lane and are exercised by the media-submission test.

The generated `route-table.ts` re-exports the contracts `registry`, and the
test scaffold exports `ADAPTER_ABORT_CASES` and its two companion types. The
scaffold manifest is future adapter-test input; the generated file is codegen
output. Neither is a hand-editable deletion candidate.

## 2026-08-29 regression classification

Every finding added after the reviewed `c0df014` baseline was compared by file
and symbol rather than inferred from the net count. Later implementation work
had added 27 export findings and 22 type findings while consuming 18 and 13
older findings respectively.

The following exports were file-internal and lost only an unnecessary export
modifier: `runHnsCommunityAppGateway`; `PIPELINE_SNAPSHOT_INTERVAL_MS`;
`isPipelineSnapshotBoundary`; `SONG_PIPELINE_HEALTH_INTERVAL_MS`;
`ALERT_SUPPRESSION_OBSERVATION_INTERVAL_MS`; `isMediaProcessingIdentifier`;
`decideMediaPublication`; and fixture-local `attempt`. Five otherwise-unused
fixture values were removed: `classifierResult`, `classifierFailureResults`,
`malformedBcp47Tags`, `hostileAuthorityFields`, and `hostileTranscript`.

The following added types were likewise implementation-local and were
de-exported: `HnsCommunityAppGatewayDeploymentManifestV1`,
`HnsCommunityAppGatewayStagingDeploymentManifestV1`,
`HnsCommunityAppGatewayDeploymentManifest`, `MegapotPublicCommitmentObject`,
`MediaProcessingLyrics`, `MediaProcessingAttemptStart`,
`MediaProcessingWorkflowOptions`, `MediaTransformSource`,
`MediaTransformRetryableReason`, and `MediaTransformProgress`.

The retained added export findings are intentional DATA or media processing
seams: `IPFS_GATEWAY_VERIFICATION_VERSION`; `MEDIA_LYRICS_MAX_LENGTH`;
`MediaLyricsIdentity`; and `MediaTransform`. They define owned media/DATA
pipeline contracts. The MP3 parser remains in `media-mp3-sample.ts` with its
direct tests; only the redundant `media-processing-runtime.ts` re-export was
removed. None of these findings is made reachable by widening Knip entry
points or ignores.

The retained added type findings are the domain `LyricsAnalysis` state and
repository workflow inputs `AuthorLyricsSnapshot`, `BeginFinalizeInput`,
`BeginFinalizeOutcome`, `LyricsInput`, `ProcessingAttemptDeferInput`,
`ProcessingAttemptLookupInput`, and `WorkflowReplacementInput`. These are
structural inputs to the staged media processor. No added finding was
classified as a Knip configuration false positive, and `knip.json` gained no
ignore.

## Ratchet rule

Findings may decrease, never increase without a new documented rationale here.
A finding is removed only when its owning lane lands its consumer and the
export becomes reachable, or when a spec amendment removes the module. The
intentional findings are not hidden behind a broad `ignoreIssues` block; the
only exemption is the compile-only fixture, which the dependency gate requires.

## Baseline numbers

Unused exports: 37. Unused exported types: 79. Unused files: 0. Duplicate
exports: 0.
