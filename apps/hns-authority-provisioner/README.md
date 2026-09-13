# HNS authority provisioner renewal

Migration 0120 recovers retryable health-renewal failures under the existing
job identity. Unknown observation exceptions retry; invalid retained requests
and authority mismatches remain terminal. The database also recognizes explicit
revocation, invalid delegation, inactive sessions, and superseded generations
as terminal. A retry never relaxes evidence validation or serving fences.

Claim-time evidence refusals that an operator can repair are delayed, not
terminal. A missing or mismatched retained plan binding
(`plan_binding_missing`, `plan_binding_mismatch`), missing accepted readiness
(`readiness_evidence_missing`), a missing session ownership binding
(`ownership_evidence_missing`), or a missing activation operation
(`activation_evidence_missing`) persists `state='delayed'` with the named
reason, a persisted `next_attempt_at` and the existing 30-second to six-hour
retry schedule; no new policy value was required. The named codes are outside
the terminal whitelist in `hns_root_health_renewal_terminal_failure_v1`, so the
same job identity retries in place once the operator restores the evidence
through its supported writer or recovery path, and the scheduler requeues the
same row when it is due instead of inserting a replacement. Only
`session_not_activated` and `generation_superseded` remain terminal at claim
time, because obsolete work has no repair path under that job identity.

Every retry records state delayed and next_attempt_at. The first two failures
wait thirty seconds; the third waits thirty minutes, followed by one, two,
four, and at most six hours. The thirty-minute scheduler requeues due delayed
rows; the provisioner can also claim them directly once due. Both paths retain
the job identity. Expired leases enter the same backoff before reacquisition.
The attempt counter saturates at 1024, while the independent lease fence keeps
advancing. A prolonged outage therefore does not exhaust recovery permanently.

The forward migration converts existing failed rows using the same explicit
terminal classification. It preserves the original failure reason. A terminal
job is never automatically reopened. A new DNS or health generation has a new
job identity, and late completions cannot advance its health.

The status projection counts delayed and terminal jobs for active imported
roots at their current DNS and health generations. Historical superseded jobs
remain retained but do not keep the current generation in an alert state.
Remaining serving validity is the earlier of pinned inventory expiry and
health expiry. Healthy observation flags do not override expired inventory.

Apply the reviewed forward migration before upgrading the jobs Worker and
provisioner together. The private driver release is independent. Verify the
live scheduler tick, delayed and terminal counts, remaining serving validity,
and a real completed renewal after release.

Migration 0121 and the matching provisioner promote imported-root inventory
successors as well as health. Scheduling uses the earlier serving expiry.
Each observation attempt has a distinct inventory identity. Completion locks
the job, session, DNS, app-host and sale-namespace predecessors, then inserts
the immutable inventory and advances every serving dependency in one
serializable transaction. It shares the maintained continuity command's
promotion body. Existing username grants keep serving through the current
sale namespace after the generation advances.

An expired predecessor does not prevent recovery when ownership remains
current and fresh authenticated evidence validates. The successor must retain
the deployment environment and structural authority identity. Document 012's
September 5 erratum caps evidence at 604,800 seconds; shorter leases remain
valid and no waiting period is required. Changed app or sale generations
require a new observation attempt. A lost commit acknowledgement is reconciled
from exact retained completion bytes through a new database connection; it
must never be converted into an observation failure or a second mutation.

Apply 0121 before deploying this provisioner. Older provisioners continue to
write health only, so migration alone does not enable inventory continuity.
Read back an early successor and both app and existing username serving paths
before claiming production acceptance. Retained operator roots remain outside
this queue until adoption; their manual checkpoints and certificate renewal
remain required.

## Single-owner readiness cutover execution

The reviewed cutover endpoint is
`0172_hns_cutover_evidence_consistency.sql`. It drops the retired
three-argument probe overload, records the attempt-bound six-argument probe,
and owns the runtime privilege contract for the service identity table and the
probe function in deployment order. A deployment that applies the role template
before the migration receives the blanket default table privileges when 0171
creates `hns_lifecycle_service_identity`; the migration must therefore revoke
those writes itself rather than rely on the template's later revoke. The
template grants the six-argument probe signature; the three-argument overload
no longer exists in the deployed schema. When the runtime role lacks EXECUTE on
the probe, the service reports the named startup outcome `probe_forbidden`
with a bounded, redacted cause, and it never falls through to serving. The
template's lifecycle observation grant was also corrected to the live
twelve-argument `record_hns_root_import_lifecycle_observation_v1` signature.

Artifact measurement covers only the deployed single entry-file bundle
(`pirate-hns-authority-provisioner.mjs`): the service hashes the file it is
actually running and compares it with the staged deployment manifest digest.
Preloaded modules, dependencies and any sidecar files are outside that proof,
and a changed preload or sidecar without a changed entry file is not detected
by the digest check.

The deployment sequence seeds the controlled probe after the removal batch and
starts the compatible service. A recorded attempt identifier is conclusive as
soon as it appears, including a recorded failure: `artifact_mismatch`,
`attempt_mismatch`, `probe_absent` and `lease_conflict` are reported
immediately instead of waiting out the poll deadline. The poll waits only for
the requested attempt's own result, and reports stale evidence as
`stale_attempt_result` at the deadline. Explicit attempt-ID reuse is restricted
to the 120-second probe freshness window: reusing an attempt identifier replays
its completion only while that completion is fresh, so a deployment that
re-runs after the window must generate a new attempt identifier. For
stale-attempt recovery, confirm the previous service process is stopped before
reseeding the probe, so it cannot record an identity row after the reseed and
satisfy the new attempt with the previous attempt's outcome. Synthetic probe
rows are excluded from the normal lifecycle claim selector. Their exclusion
from operational phase counts is a requirement for the forthcoming
observability implementation, not an existing reporting feature; the partial
index on `hns_root_import_lifecycle` marks operational rows for that work.

## Wallet-independent provisional imports

Spec 012's September 6 amendment permits a community manager to obtain a
complete resource before proving root ownership. Migration 0129 admits one
open import per community, three new provisional admissions per actor over
24 hours, and 32 held community reservations deployment-wide. Exact replay
consumes no new admission. The parent-chain TXT and delegation observations
remain required; provisioning does not grant ownership or activate serving.

Deploy the forward migration and explicitly grant the executor role
`EXECUTE ON FUNCTION lock_hns_root_zone_mutation_v1(TEXT,TEXT,BOOLEAN,TEXT,TEXT,BIGINT)` before
this provisioner. Deploy this provisioner before enabling the new HTTP start
path, and deploy HTTP before the matching frontend. Older provisioners cannot
consume provisional teardown requests. Resolve the reviewed migration prefix
explicitly; this release does not authorize unrelated video migrations.

PowerDNS stores a reservation marker in the zone account at creation. A retry
may reconcile only the matching reservation, including after a lost create
response. Provisional teardown validates that marker, deletes the zone, and
reads back absence. Database job and session locks cover the provider mutation
so a competing completion cannot release and reuse the reservation mid-write.
The executor aborts provider requests if its lock connection is lost.

The existing teardown queue is populated on the first provisional execution,
including attempts that never retain a successful provision result. Failed
attempts retain capacity until confirmed cleanup; a two-minute drain window
precedes cleanup of a failed provision. Expired, never-attempted preparations
can release capacity without DNS work. Cleanup exhaustion keeps the reservation
held for operator reconciliation rather than silently refunding it. Provisioning
and teardown requests remain individually bounded; no retry is performed by
the mutation-lock wrapper after an ambiguous transaction acknowledgement.
