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
`DATA_REGISTRATION_ENABLED=false` and
`SONG_MAINTENANCE_OBSERVATION_ENABLED=false`. Deploy that exact merged commit;
a source-only revert is not sufficient.

Read back the deployed version, empty schedule and false flags. Re-run the
read-only database authority counts and inspect the two DLQs. If rollback cannot
be proven, stop this lane and do not authorize the canary.

## Evidence ledger

Activation, natural-tick, synthetic-alert, suppression, cleanup and rollback
identifiers are appended here only after each read-back succeeds. Until then,
the recorded baseline above is the latest production evidence.
