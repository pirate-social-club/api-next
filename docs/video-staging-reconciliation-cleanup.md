# Accepted analysis markers and uncertain Stream delivery

The marker operator resolves stale probe or frame reconciliation markers only
after the same analysis revision is already accepted. It does not resume a failed
submission or finish its render. The Stream inspection records current provider
evidence while preserving uncertain historical acceptance. Neither operator
deletes artifacts, releases claims, dispatches workflows or sends provider jobs.

## Marker preview and repair

Use `scripts/video-accepted-analysis-cleanup.ts` with the exact staging runtime
credential in `CONTROL_PLANE_POSTGRES_RUNTIME_URL`. Credentials belong in the
process environment, never arguments or evidence. The CLI refuses any database
role or schema other than the staging runtime role and `api_next`.

Run the read-only preview with `--submission SUBMISSION --request FRAMES_REQUEST
--request PROBE_REQUEST`. Only one or two explicit, unique requests are accepted.
The JSON output is the exact fence for review, containing request and operation
identities, event sequence, revisions, source hash, and hashes of the complete
submission, attempt, immutable source binding and accepted stage fact. Provider
job values, stage snapshots and artifact references are omitted.

The preview requires an unpublished failed video submission with reconciliation
required. It verifies the exact submission, operation, source ownership and
accepted analysis lineage. The already accepted probe or frames must match the
immutable stage fact at the same analysis revision; ordinary pending analysis
belongs to the existing reconciliation operator instead.

Before live use, the runtime executor coordinates the staging resource handback
and reviews the exact implementation and freshly generated fence. The separate
cleanup task does not allocate gateway, Media, phone or rewards control. Source
preparation does not grant permission to integrate the canonical API checkout
while another release still holds its source pin.

The apply command is `--fence REVIEWED_FENCE.json --apply`. It accepts no target
arguments alongside the fence. It locks the exact submission, attempts, source
bindings and stage facts, verifies every fence again, then resolves only the
selected reconciliation markers in one transaction. Before committing, it verifies
the target marker state and unchanged authority, accepted facts and other attempt
fields; a failed verification rolls back all selected markers. It retains the historical
provider job identity and phase, failed submission and render state, all accepted
facts, source artifacts, outboxes and revisions. The new observation cites the
immutable accepted stage fact; it does not assert a new provider response.

An error after COMMIT can leave acknowledgement uncertain. Do not repeat the old
fence or infer no mutation from a failed exit. Read the exact marker and preserved
state first. A completed repair refuses the original preview because its marker
no longer has the required state. There is no rollback that reopens accepted
facts or permits a failed render to replay.

## Stream evidence without a terminal decision

Use `scripts/video-stream-reconciliation-inspect.ts --operation OPERATION` with
the staging database credential and `VIDEO_STREAM_API_TOKEN` privately supplied
in the environment. This CLI has no apply mode. Its narrow scope is an accepted
song-reference master whose Stream state remains `reconciliation_required` with
reason `acceptance_unknown`, failed enrichment and no bound provider UID.

The database reader verifies accepted master, publication, rights, source hash,
claim fence and ingest revision. It hashes the durable outbox, projection, rights,
master and source-grant authority before and after provider I/O. A changed
authority refuses the observation. It verifies the scoped account token is
active before listing; this says nothing about which credential the Worker has
installed or whether a release's required lifetime buffer is satisfied.

The provider reads use exact creator search followed by a complete current
account search, across all dates and statuses. The creator is the full SHA-256
of `pirate-video-v1:OPERATION`. Matching creator, operation metadata or source
hash retains a candidate for review, never chooses or adopts it. Current search
coverage requires counts equal to the returned unique identities, fewer than
1000 rows, and agreement between the independent creator and account listings.
Requests are GET-only, bounded to 20 seconds and two MiB, with redirects refused.
The include-counts response shape observed on staging is
`result.{videos,total,range}`. Parameters are documented in the
[Cloudflare Stream list reference](https://developers.cloudflare.com/api/resources/stream/methods/list/).
An unavailable credential or partial listing is a refusal, never an empty match.

The output omits unrelated identities, metadata, names, capability URLs and raw
provider bodies. No current match establishes current absence during the
observation window; it does not establish historical noncreation. The result
always denies copy permission and terminal-failure authority. A null UID cannot
be invented to satisfy a failed-ingest row constraint. Historical rejection or
adoption needs retained exact provider evidence and a separately reviewed valid
domain transition. Until then the operation stays unresolved and replay remains
prohibited. Historical cleanup source remains separate from the selected 7cdf
release and does not block its deployment or reopen the completed backend
milestone. XState owns which cleanup is required for reconciliation acceptance.
The frontend reconciliation task closes only after its required cleanup,
acceptance and Rewards handback; this separate source preparation waives none
of those closure requirements.
