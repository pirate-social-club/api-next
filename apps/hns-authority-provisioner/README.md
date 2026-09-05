# HNS authority provisioner renewal

Migration 0120 recovers retryable health-renewal failures under the existing
job identity. Unknown observation exceptions retry; invalid retained requests
and authority mismatches remain terminal. The database also recognizes explicit
revocation, invalid delegation, inactive sessions, and superseded generations
as terminal. A retry never relaxes evidence validation or serving fences.

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
