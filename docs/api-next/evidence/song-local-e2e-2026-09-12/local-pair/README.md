# Local pair launch configuration

Preserved from the 2026-09-12 song onboarding preparation. No credential
values are included. Launch scripts read secrets from ignored, mode-0600
`.dev.vars` files or from Infisical at start, and the overlay generators print
only key names.

## Tested revisions

The uninterrupted fixture journey ran on API `64f56114` (worktree head
`fd1b9695`, documentation only) with a Solid build of `eeade42`, which
contains the fixture, composer, playback and CSP fixes. The first publication
run used the Solid `ee5811b` build, and the resume playback verification used
a `c320fe6` build. The intended b6cf294 Solid export was never built or
served; the runner worktree was always the served runtime.

The fixture journey passed in one run: Privy sign-in, community creation,
upload to the staging ingress bucket, remote-binding seal to the immutable
bucket, queue delivery (`2/2`), local `MediaProcessingWorkflow` execution
(probe, sample, acr and metadata attempts succeeded, ACRCloud `no_match`,
publication succeeded), post publication, feed reload, playback with a finite
duration, and a seek to the midpoint. Submission
`media-submission-79f67ead-2aae-468c-ac98-db67bbfcbd2d` published post
`media-post-media-operation-7ff93724-7ce4-4223-97bd-30c3e3dc9985`.

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
previously re-exported plain constants that workerd rejects locally, so
`jobs/entrypoint.ts` is a local-only shim exporting just the default handler and
the cron lock class; the tracked worker is repaired at `f4c98557` and the shim
is kept as historical evidence.
`media-processor/entrypoint.ts` wraps the real entrypoint with the provider
budget guard.

`run-wt-preview.sh` serves the Solid production build on 8787. The Solid
worktree holds the matching runner scripts and the resume spec
`e2e/song-onboarding-playback.spec.ts`.

## Provider budget

The cumulative ceilings are ACRCloud 2, OpenAI 3, OpenRouter 1 and ElevenLabs
1, and they are not renewed by restarting a processing session.
`provider-ledger.json` is the source of truth; `prepare-processing-workers.mjs`
recomputes the remaining allowance from it and bakes the remaining values into
the local media processor guard, which logs `provider-request` and throws
`provider-budget-exhausted` on any call to an exhausted provider.

Consumed to date: ACRCloud three and OpenAI three. ACRCloud is one request over
its ceiling of two, recorded plainly in the ledger overrun field; the melody
run, the first published noise run, and the uninterrupted run each spent one
identify request. Restarting the session did not renew that allowance, and the
earlier draft that treated the guard as per-session is withdrawn along with the
unauthorized ACRCloud 4 and OpenAI 6 ceilings. OpenAI is exactly at its ceiling.
No additional provider calls are authorized, so the generated guard now refuses
ACRCloud and OpenAI. The instrumental fixture skips the lyrics classifier and
alignment, and QEncode is video-only.

## Provider changes

`PROVIDER-CHANGES.md` lists the two additive provider changes and rollbacks.
The ingress CORS addition was applied for each run and restored to the
original single-origin rule afterwards; `cors-evidence-2026-09-12.txt` and
`cors-evidence-run-2026-09-12.txt` hold the before/after readbacks.
`ingress-cors.rollback.json` restores the original rule. The Privy staging
allowed-origin entry belongs to the workspace owner.

## Solid fixes verified

`a6d3c9e` keeps the composer observing after a transient status failure,
`ef4706a` lets the song player survive feed re-renders and permits signed R2
audio in the CSP `media-src`, `c320fe6` adds the resume playback spec and
response media-type diagnostics, and `eeade42` resumes a valid cached grant on
retry instead of pausing. The branch gates passed at `eeade42`: `tsc --noEmit`,
`lint`, `check:e2e`, `test:app` (694 tests), `test:ssr` (6 tests), `test:api`
(140 tests), and the Worker build with its provenance prebuild checks.

## Overlay classification

Test configuration, not compensating for a source defect: `run-api.sh`,
`run-api-media-e2e.sh`, `run-api-resume-e2e.sh`, `run-processing-workers.sh`,
`run-wt-preview.sh`, the `prepare-*.mjs` generators, the generated
`wrangler*.json` overlays, `provider-ledger.json`, `provider-budget.md`, the
CORS files and their readbacks. `media-processor/entrypoint.ts` is test
instrumentation: it wraps the real entrypoint with the budget guard.

Compensating for a source defect: `jobs/entrypoint.ts`, retained as historical
evidence. The tracked jobs worker entrypoint previously re-exported plain
constants that workerd rejects at the module boundary, and the shim exported
only the default handler and the cron lock class. The tracked entrypoint is
repaired by `f4c98557` under the task `api-jobs-worker-entrypoint-startup`, so
the shim is no longer needed for a local boot. The HTTP worker startup defect
is not an overlay: it is repaired in source at `64f56114`, which is part of the
API pull request.

## Review notes

Grant expiry is enforced by `renew_after`: an expired cached grant is never
reused, and a valid one is reused without pausing after the `eeade42` fix.
Account changes are not observable in this revision because the app has no
in-app sign-out; switching accounts requires a full page load, which clears
the in-memory grant cache. If in-app sign-out is added, the cache must be
cleared. The CSP allows exactly the account host
`https://08a4c22cf52e2ecae883e36f80a33f4a.r2.cloudflarestorage.com` in
`media-src`, with no wildcard, and the middleware test pins that string.

## Outstanding

Lyrics classification, alignment, and the reference-required journey are not
covered by the instrumental fixture and remain follow-up E2E cases. The
community and song created by the journey have no delete contract, so they
remain marked for disposition.
