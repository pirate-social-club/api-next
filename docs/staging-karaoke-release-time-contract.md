# Release time contract

The release origin, surface operation, signed journal and parent CLI use two
different clocks for different facts. They must not be substituted for each
other. This document makes the distinction explicit for independent review.

The intent's recordedAt is a lower bound on execution under that intent. The
last held-fence observation precedes that intent, and the durable executing
claim must succeed before the first mutation. A cancelled claim establishes
non-execution only through the existing exclusive transition; timestamps alone
do not establish non-execution.

Each surface's releasedAt is the collector's restoration-confirmation time:
the response has been validated and independent readback has proved the
reviewed effect. The operation requires its invocation start to be no later
than that confirmation, and confirmation to be no later than the current
clock. Confirmation is an upper bound on the proved effect, not an exact
provider mutation time. A lost response or failed readback produces no receipt
and no confirmation time, even if later state looks restored.

The operation returns the final surface's retained confirmation time. The
approved order is database, producers, ingress. Recovery requires all three
authenticated, intent-bound receipts and fresh restored-state observations;
it retains their final confirmation time instead of replacing it with the
recovery clock. Missing receipts stay unresolved. A successful current-state
observation cannot recreate a lost receipt or its timestamp.

The released journal entry's observedAt is recording time. It may be later
than the confirmation boundary after interruption. It must remain monotonic
with the signed journal, including intervening entries. The manifest's
releasedAt comes from the authenticated release-evidence artifact, never this
recording timestamp. The verifier still requires exact equality between the
manifest boundary and a receipt's release evidence. The parent additionally
requires its fresh challenge and approved plan digest in the signed entry;
an exit code is not authority.

The verifier's twenty-four-hour interval starts at the end of each target's
last clean retirement baseline. Follow-up additionally requires a recorded
release and its exact release evidence. Neither the journal recording clock
nor a provider request start replaces that baseline. If the live runbook
requires twenty-four hours after release as well, it must wait for that later
boundary; this implementation does not silently redefine the existing
baseline rule. PostgreSQL server version and SQLSTATE are separate execution
evidence, not clock evidence and not an attribution of failure to a version.

Confirmation is not mathematically equivalent to the physical instant of
release. The independent review must explicitly accept the protocol's
confirmation boundary, or require a separately authenticated physical boundary.
The collector's held-fence checks before and after ordinary observations
prevent a release-transition observation from claiming a maintained fence;
the static verifier does not itself prove continuous provider state. This
distinction remains a rehearsal admission review item, not a reason to silently
relax the verifier's equality contract.
