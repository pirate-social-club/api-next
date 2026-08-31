# Production song maintenance observation

This procedure activates only the production jobs-side media and DATA
maintenance surfaces, proves their idle and alert behavior, and returns the
jobs Worker to its disabled configuration. It does not authorize uploads,
provider calls, Queue launches, publication, wallet operations, funding or an
Aeneid transaction.

## Recorded baseline

The read-only preflight on 2026-08-31 found the production control-plane schema
at migration `0092_hns_sale_namespace_active_refresh.sql`. Migration `0093` is
not required by these maintenance readers and is outside this task.

The control plane contained zero dispatchable media rows, zero dispatchable
DATA rows, zero live media operations, zero live DATA operations, zero DATA
reconciliation rows, zero funding requests and zero retained observation
fixtures. Queue topology read-back found both production primary queues and
both production DLQs with their reviewed producers and consumers. The queue
metadata endpoint does not expose backlog depth; persisted collectors and the
database authority checks provide the bounded DLQ proof during observation.

Before activation, `pirate-jobs-worker-production` served deployment
`fd2e7dd0-f759-4704-9800-67ae945b1271` at version
`1248547f-c294-47c6-baad-634cf4f6cf09`, built from source commit
`c5edf7037139298a22a912657a6a223b5afbff6e`. This is the named rollback target
until the explicit disabled rollback deployment supersedes it.

## Activation boundary

The activation overlay installs the minute cron and enables only
`MEDIA_PROCESSING_ENABLED` and `DATA_REGISTRATION_ENABLED` on the jobs Worker.
`COMMUNITY_MAINTENANCE_ENABLED` remains false so the schedule cannot run the
community catalog or purchase-funding jobs. The HTTP upload flag, both event
Worker runtime flags, HNS and Megapot remain false.

The first reviewed activation keeps
`SONG_MAINTENANCE_OBSERVATION_ENABLED=false`. Deploy only a clean source commit
already reachable from `origin/main`, using the provenance-bound deployment
helper. Read back the resulting version, source message, minute schedule and
all named flags. Observe at least one natural scheduled invocation before
introducing the synthetic condition.

The synthetic condition is a second, one-variable reviewed change setting
`SONG_MAINTENANCE_OBSERVATION_ENABLED=true`. Its opaque marker is
`production-maintenance-observation-20260831` at workflow revision 4, mapped to
Workflow identity
`media-production-maintenance-observation-20260831-r4`. The scheduled path calls
only the media Workflow binding's read method. A returned instance fails closed;
the documented missing-instance result emits the real
`song-pipeline:media-replacement-limit-reached` high alert through the normal
Durable Object suppression ledger. The path has no create, Queue, provider,
database-write, publication, wallet or chain capability.

The configuration marker is the entire fixture. No database or Workflow record
is created, so cleanup is the reviewed rollback that removes the marker and
restores the disabled overlay. Read-only database and Workflow checks must
confirm that no fixture or effect row exists after rollback.

## Telemetry proof

Use a newly created user API token scoped to this Cloudflare account with only
Account Workers Observability Write. Give it a short expiry, paste it only into
a mode-0600 temporary file, and never put it in Infisical, shell history,
documentation, logs or repository files. Query persisted production Workers
Logs for:

1. A natural jobs cron event before the fixture flag is enabled.
2. One high `pipeline.alert` event with the opaque operation ID, revision 4,
   replacement-limit key and transition suppression reason.
3. A later, distinct `pipeline.alert.suppression` event for the same condition,
   bounded to the five-minute observation interval.
4. Natural media and DATA health snapshots, no stuck launch or reconciliation
   condition, and no transaction evidence.

Delete the Cloudflare token and its temporary local file immediately after the
persisted queries are recorded. Retain only redacted counts, timestamps, event
keys, version IDs and source commits.

## Explicit rollback

The rollback is a separate reviewed source change restoring production
`crons: []`, `MEDIA_PROCESSING_ENABLED=false`,
`DATA_REGISTRATION_ENABLED=false`, and removing the temporary observation
variable, function and tests entirely. Deploy that exact merged commit; a
source-only revert is not sufficient.

Read back the deployed version, empty schedule and false flags. Re-run the
read-only database authority counts and inspect the two DLQs. If rollback cannot
be proven, stop this lane and do not authorize the canary.

## Evidence ledger

Activation, natural-tick, synthetic-alert, suppression, cleanup and rollback
identifiers are appended here only after each read-back succeeds. Until then,
the recorded baseline above is the latest production evidence.

Activation deployment `49d2c3c9-3dbb-4bed-ba34-fa96d209c69b` placed version
`91d8db41-340d-4b0a-9e90-98a1d7c53e5e` at 100 percent from merged commit
`c243fa5853ce75758904aee3472fa9831530f1d9`. Version read-back confirmed the
production environment, reviewed Hyperdrive and Workflow bindings, community,
HNS and Megapot false, jobs-side media and DATA true, and the synthetic marker
false.

Live-tail read-back recorded a natural scheduled invocation at
`2026-08-31T11:34:10Z`. Its exact version was `91d8db41-340d-4b0a-9e90-98a1d7c53e5e`,
its cron was `* * * * *`, its outcome was `ok`, and it contained no exception or
custom alert log. This natural invocation preceded the reviewed change that
enables the synthetic marker.

Synthetic deployment `28b5008c-bc43-4e7c-9560-d362655e1cfb` placed version
`ad32dbbf-e6d7-49a5-8300-93e92b6e88a1` at 100 percent from merged commit
`7de35ce14218a238e9498abb797771349a5aca3d`. Version read-back confirmed the
same minute cron and runtime boundaries with only the synthetic marker changed
to true.

Persisted Workers Logs query run `109a45pfmh129vdivvxfho52` read 3,763,676
rows and returned 29 retained events matching only the opaque operation ID. On
version `ad32dbbf-e6d7-49a5-8300-93e92b6e88a1`, it proved the high
`pipeline.alert` transition at `2026-08-31T11:52:15.045Z` and the distinct
`pipeline.alert.suppression` event at `2026-08-31T11:53:13.998Z`. Both records
used operation ID `production-maintenance-observation-20260831`, workflow
revision 4, key `song-pipeline:media-replacement-limit-reached`, production
environment, media subsystem, terminal outcome and failure class
`workflow_missing_at_replacement_limit`; the second record was explicitly
`suppressed`. The query retained no credential or unrelated source content.

Read-only database checks after both natural and synthetic observation found
zero media submissions, media attempts, media outbox rows, DATA operations and
DATA outbox rows. No production song row or transaction evidence was created.

Persisted health query run `w0g2xzb101ck6bmvdfandon7` proved 31 natural
`healthy` snapshots for each of the media and DATA subsystems. The first pair
was emitted at `2026-08-31T11:35:10Z` on the pre-synthetic activation version;
the latest observed pair remained healthy with all pending, in-flight,
retrying, exhausted and terminal counts at zero. Balance query run
`9a1hcd7c10oyap0s59jt2h5c` proved 32 natural production snapshots for the
Aeneid DATA signer. Its latest record was `fresh` and `sufficient` on chain
1315 with a reserve ratio of 210,000 basis points. These queries retained only
redacted counts, statuses, timestamps and version identifiers.
