# Knip hygiene baseline

Knip runs as `bun run knip`. It is advisory, not part of `bun run check` or the
required CI gates, and it exits nonzero while findings remain. This document
records the reviewed baseline and the rationale for every class of retained
finding, so a later ratchet has something to measure against and does not treat
static unreachability as a product-deletion signal.

## Status

At branch base the report showed 1 unused file, 113 unused exports, 114 unused
exported types, and 8 duplicate-export groups. The hygiene lane reduced that to
0 unused files, 64 unused exports, 81 unused exported types, and 0 duplicate
groups. The remaining findings are intentional package and future-lane surface,
described below.

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

## Ratchet rule

Findings may decrease, never increase without a new documented rationale here.
A finding is removed only when its owning lane lands its consumer and the
export becomes reachable, or when a spec amendment removes the module. The
intentional findings are not hidden behind a broad `ignoreIssues` block; the
only exemption is the compile-only fixture, which the dependency gate requires.

## Baseline numbers

Unused exports: 64. Unused exported types: 81. Unused files: 0. Duplicate
exports: 0.
