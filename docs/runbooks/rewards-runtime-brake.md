# Rewards runtime brake

Migration 0230 seeds an environment as paused. Routine Worker deployments do not
change this database control. The deployment binding must stay on while any
credit, refund, reserved budget or ambiguous chain effect is outstanding. It
may be turned off only after a fresh inventory proves nothing owed and no
ambiguous effects. Pausing never changes either Worker binding.

## Admission boundary

The nonce trigger refuses INSERT and increases in next_nonce with SQLSTATE
PR001. Its migration-owner SECURITY DEFINER function takes FOR SHARE on the
singleton control row. The operator function takes FOR UPDATE on the same row,
so a committed pause waits for admitted reservation transactions and refuses
later reservations. Runtime roles need no UPDATE privilege on the control.
Missing control rows and database failures cannot authorize reservations.

This stops new custody approvals, ticket purchases, winnings claims, payouts,
refunds and gas top-ups. Existing nonce reservations can still be prepared,
submitted, retried with identical bytes and reconciled. A successful pause is
an admission cut-over, not evidence that no more transactions can be sent.
The jobs summary reports paused_hold_count separately from failure_count.
Database outages remain failures rather than deliberate holds.

HTTP refuses new offers, new legs and unbroadcast funding instructions. Its
successful control reads expire five seconds after the read starts. An expired
running value is never used after an error. Recorded funding observations and
receipt status remain accessible, as do balances, held credits and claim status.
Instructions already delivered to a browser cannot be recalled; a sponsor may
still broadcast them. Observing that transfer must remain possible.

User-owned persona-wallet transfers and their winner-send records remain
outside this control. Privy Wallet sponsorship keeps its separate flag and
limits. Requesting a credit or gas top-up can create a held obligation; the
nonce trigger blocks the platform send until admission resumes.

## Operator authority

The migration revokes inherited grants on both control tables and the operator
function. Only its owner can execute it until the migration owner approves an
explicit EXECUTE grant to the dedicated operator role. That role also needs
SELECT on the control, its event table and reward_chain_effects for readback.
Runtime roles receive SELECT only on the control tables. The release preflight
requires INSERT, UPDATE, DELETE and TRUNCATE to be denied and operator-function
EXECUTE to be denied to runtime roles. No script grants authority itself.

Before an operation, read the singleton row and its revision using the operator
connection. Supply the connection through REWARD_OPERATIONS_OPERATOR_DATABASE_URL;
do not put credentials in command arguments or evidence. Then run, for example:

```sh
bun run rewards:control pause 1 incident_review
```

The revision is an optimistic concurrency guard. A stale revision, missing row
or invalid reason refuses the operation. An identical mode is idempotent and
retains its original reason and revision. A state change increments the revision
and appends an event with the authenticated database session role. A readback
must match the requested mode and returned revision. The script also reports
counts of nonce_reserved, prepared, broadcast_pending, confirming and
reconciliation_required effects that already have a nonce.

A timeout or lost database response can leave the outcome uncertain. Read the
control and event trail through an independent connection before taking over.
No failure path restores running. A readback failure can mean the pause already
committed. Resume always requires a separate explicit command and current
revision, with an incident-owner reason. Its operator authorization must include
the contract identities and any outstanding winnings-claim deadline. The
contract evidence below applies only to the exact deployments checked.

## Drawing and refund behavior

When a paused drawing passes its purchase window, a proven unsent committed
purchase closes as closed_purchase_unavailable through the existing prebroadcast
closure. The cycle performs this cleanup even when approval is paused or
pending. Cleanup never reserves, signs or resumes a transaction and leaves any
existing purchase progress for reconciliation. It releases reserved ticket
budget and does not project a purchased ticket. Existing offer expiry rules preserve remaining leg funding and create
refund liability when appropriate; refund sends wait until resume.

An admitted or ambiguous purchase must reconcile before its budget is released.
The brake does not authorize treating a nonce reservation as unsent. Existing
purchase reconciliation and custody integrity holds continue to govern it.

## Rehearsal and evidence

Local PostgreSQL tests exercise the actual migration with inherited broad table
and function grants, confirm their removal, and verify trigger INSERT/UPDATE
coverage. A reservation holds the control share lock while an operator pause
waits. A later queued reservation is refused after the first commits. Paused
bookkeeping remains allowed. Missing control and forbidden runtime control
writes fail closed. Existing production repository fixtures exercise pause
holds for all six reservation paths, and an admitted gas top-up finishes while
paused. The unsent drawing closure is exercised under pause.

A staging rehearsal still needs separate release and operator authorization.
Apply the migration with its owner, run both runtime-role preflights, and deploy
the reviewed HTTP and jobs code with bindings on only when the owed inventory
requires it. Verify the initial paused row before any explicit resume. Record
the pause request time, committed revision, independent readback time, HTTP
cache bound and admitted effect counts. Reconcile the admitted tail and compare
nonce/effect inventories before and after. A routine deployment while paused
must leave the row, revision and both runtime admissions paused. Inventory all
liabilities before the binding can be turned off. These are rehearsal acceptance
criteria; local tests do not claim a live rehearsal or a closed production gate.

## Contract verification boundary

The source-verification route is complete for the pinned Sepolia deployment and
the parked Base mainnet candidate. Independent Solidity 0.8.28 builds of both
Jackpots, both ticket NFTs and both payout calculators matched their public RPC
runtime bytecode at pinned blocks. Immutable Jackpot addresses were accounted
for explicitly. Both current drawings use the calculators checked. Historical
drawing 1 payouts remain stored on both chains.

The matching claim, ownership/burn and tier-payout source has no time-based
claim deadline. Holding claims during a pause does not hit a protocol claim
expiry in these exact deployments. Recheck identities and each obligation's
calculator for the attestation chosen at activation; this does not choose or
approve the production attestation or signing backend.

The compilation inputs came from Sourcify's v2 endpoint. The public audit
checkout differed from the deployed source. Fingerprints, pinned blocks,
immutable references, primary URLs and reproduction steps are in
[the contract verification evidence](../evidence/rewards-runtime-brake/README.md).
The separate historical-winning-ticket probe did not find a successfully
simulated unclaimed winner. No transaction was sent and no behavioural success
is claimed. The live brake rehearsal remains open.
