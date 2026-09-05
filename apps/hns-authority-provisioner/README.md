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

This queue renews health for imported activations. It does not adopt retained
operator roots or promote authority-inventory successors. Fresh inventory bytes
in a readiness result are not a persisted inventory promotion. Those gaps must
be resolved before claiming unattended continuity or retiring operator
checkpoints. The continuity command remains the recovery procedure.
