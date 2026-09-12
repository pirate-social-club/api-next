# Local pair launch configuration

Preserved from the 2026-09-12 song onboarding preparation. No credential
values are included. Launch scripts read secrets from ignored, mode-0600
`.dev.vars` files or from Infisical at start, and the overlay generators print
only key names.

## Tested revisions

The full journey ran on API `64f56114` (worktree head `5d400e45`) with the
Solid `ee5811b` production build. The resume playback verification ran with
the same API revision and a Solid build of `c320fe6`, which carries the
playback and composer fixes listed below. The intended b6cf294 Solid export
was never built or served; the runner worktree was always the served runtime.

## Files

`run-api.sh` starts the HTTP worker without media uploads. `run-api-media-e2e.sh`
starts it with the prepared media overlay: remote `MEDIA_INGRESS` and
`MEDIA_IMMUTABLE_ORIGINALS` bindings to the staging buckets, uploads and
playback enabled. `run-api-resume-e2e.sh` starts a playback-only overlay with
uploads disabled, so no remote binding session is needed for playback
verification.

`prepare-media-e2e.mjs` and `prepare-resume-api.mjs` generate the API overlays
under `.tmp/local-pair/`; `prepare-processing-workers.mjs` generates the jobs
and media processor overlays. `wrangler.local-e2e.json`,
`wrangler.resume-e2e.json`, `jobs/wrangler.json` and
`media-processor/wrangler.json` are the generated outputs for reference.

`run-processing-workers.sh` starts the jobs worker and media processor in one
multi-worker session with a shared persist directory so the
`pirate-media-processing-development` queue connects. The jobs worker entrypoint
re-exports plain constants that workerd rejects locally, so `jobs/entrypoint.ts`
is a local-only shim exporting just the default handler and the cron lock class.
`media-processor/entrypoint.ts` wraps the real entrypoint with the provider
budget guard.

`run-wt-preview.sh` serves the Solid production build on 8787. The Solid
worktree holds the matching runner scripts and the resume spec
`e2e/song-onboarding-playback.spec.ts`.

## Provider budget

`provider-budget.md` specifies and `media-processor/entrypoint.ts` enforces a
per-session cap of ACRCloud 2, OpenAI 3, OpenRouter 1, ElevenLabs 1 with JSON
`provider-request` and `provider-budget-exhausted` evidence. Session restarts
reset the guard, so `provider-ledger.json` holds the cumulative exercise
counts: two ACRCloud and two OpenAI requests, with ceilings of four and six.
The resume playback verification makes no provider calls.

## Provider changes

`PROVIDER-CHANGES.md` lists the two additive provider changes and rollbacks.
The ingress CORS addition was applied for the run and its before/after
readback is `cors-evidence-2026-09-12.txt`; `ingress-cors.rollback.json`
restores the original rule. The Privy staging allowed-origin entry belongs to
the workspace owner.

## Solid fixes committed with this preparation

`a6d3c9e` keeps the composer observing after a transient status failure,
`ef4706a` lets the song player survive feed re-renders and permits signed R2
audio in the CSP `media-src`, and `c320fe6` adds the resume playback spec.
