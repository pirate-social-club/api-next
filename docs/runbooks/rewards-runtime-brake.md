# Rewards runtime brake

Migration 0230 seeds an environment as paused. Routine Worker deployments do not
change this database control. The deployment binding must stay on while any
credit, refund, reserved budget or ambiguous chain effect is outstanding. It
may be turned off only after a fresh inventory proves nothing owed and no
ambiguous effects. Pausing never changes either Worker binding.

## Settling existing obligations

The settling-control migration expands the persisted state to `running`,
`settling` and `paused`. New environments still begin paused. `settling`
admits fresh nonce reservations only for a guarded refund, payout or winnings
claim for an already purchased ticket. It refuses new offers, legs, funding
intents, pool shares, asset-bonus claims, ticket purchases, custody approvals
and gas top-up effects. Ordinary Study/Karaoke qualification and streaks still
record; their financial projections create no new benefits in settling or
paused. Previously earned held credits remain visible and payable.

The database locks the control row for the reservation transaction. A settling
nonce increase cannot commit without its exact effect, nonce and guarded
obligation detail. The same detail check covers assigning a nonce to a
previously planned effect. Solvency, historical custody, amount and receipt
checks remain required by the existing repositories and detail triggers.
An observed nonce catch-up may pair an already existing guarded obligation;
it changes the fence bookkeeping and admits no new business. Every effect
INSERT and fresh nonce assignment has its own purpose and detail checks.
Existing allocations and participant claims for purchased tickets can finish.
Gas subsidies that have not reserved a nonce stay held; this mode does not
authorize a new subsidy or user-owned transfer.

An incident operator may use `bun run rewards:control settle REVISION REASON`
after receiving explicit operator authority for the settlement scope. The
command requires EXECUTE on `set_reward_operations_state_v2(bigint,text,text)`
from the migration owner. It reads back the exact state and revision and
reports the already-admitted effect inventory. `pause` stops fresh obligation
reservations as well; `resume` explicitly restores all admission. A transition
increments the revision and appends the authenticated session role and reason.
An identical state is idempotent. No command compensates a failure by resuming.

Entering settling does not cancel an already-reserved ticket purchase, approval
or gas top-up. Reserved, prepared, broadcast and uncertain transactions retain
their existing exactly-once reconciliation. An identity-preserving replacement
can reuse only its actual predecessor's admitted nonce, calldata and calldata
hash. Preparing replacement bytes rechecks that intent after nonce assignment;
fee and signature changes are permitted. Missing predecessor bytes refuse.
A missing or unknown
control never authorizes a fresh reservation. Already-issued sponsor funding
instructions also cannot be recalled; their existing transfer observations may
settle and create refund liability. Inventory that tail before declaring an
incident contained, and keep both bindings on while anything remains owed.

The `paused` column projects true for both settling and paused. Earlier HTTP
code therefore refuses new business during settling. Updated reads validate
both the explicit state and its projection. Jobs relies on the authoritative
database purpose gate: its existing refund/payout/claim repositories can reserve
in settling, while purchase/approval/gas reservations refuse. Binding shutdown
requires the exact persisted state `paused` under its share lock, in addition
to all nine empty-inventory predicates; the projected boolean alone is insufficient.

This is source-only engineering. A separately reviewed release must apply the
forward migration atomically, verify the new restricted operator and read/lock
predicate grants, and deploy both reviewed Workers and operator/shutdown tools
while paused. The old pause/resume function remains usable with its existing
dedicated-role grant, including a real pause from settling. Updated tools refuse
an older schema rather than treating a missing state as authority. Migration
ordinal 0236 is provisional until merge order is fixed. Local PostgreSQL tests
do not close the production gate: measured incident behavior and a separately
authorized live rehearsal remain required. This does not add a settlement
resume to the bounded funded staging window.

The replacement regression seeds a valid admitted pair as fixture-owner
evidence, then exercises the actual chain guards. Migration 0053's immediate
predecessor/replacement foreign keys leave their creation order unresolved;
this change preserves those constraints and adds no operational replacement
creation procedure. That existing recovery gap needs separate engineering.

## Admission boundary

In paused, the nonce trigger refuses INSERT and increases in next_nonce with SQLSTATE
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

Migration 0231 enforces new offer, leg and funding-effect INSERTs inside the
database with the same control-row share lock. Both Megapot and asset-bonus
creation refuse SQLSTATE PR001 after a committed pause. Their repositories map
that refusal to HTTP 503 rewards_paused. The HTTP control read has a five-second
local lifetime and improves error reporting; it is not admission authority.
Production Hyperdrive can cache an older running read after a pause, but the
creation write still executes the trigger against current database state.
An unavailable control read remains provider_unavailable, distinct from a
confirmed deliberate pause.

Recorded funding observations and receipt updates continue while paused, as do
balances, held credits and claim status. Insert guards do not revoke existing
idempotent results or funding intents: instructions already delivered to a
browser cannot be recalled, and the sponsor may still broadcast them. The
funding store preserves exact replay and observes that transfer. HTTP creation
and instruction reads may temporarily refuse those requests when their cached
control read reports pause. This is not a promise that every instruction already
issued has stopped being usable.

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
paused. The unsent drawing closure is exercised under pause. The refund test reserves
a nonce, pauses, and runs the real retry coordinator through signing, submission
and receipt validation against PostgreSQL, using isolated chain evidence. It
confirms without advancing the nonce fence; a fresh reservation is refused.
Full-schema HTTP tests deliberately supply a stale running read and verify that
creation still rolls back. The forward-migration test checks restricted function
execution separately, because the test baseline intentionally omits ACLs.

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
is claimed. The shared staging rehearsal on 2026-09-30 proved pause with active funding,
pause survival across a same-source redeploy, held refund and full refund after
resume. It ended paused with both bindings off and nothing owed. The receipt
confirmed before the attempted tail pause, so it did not prove an admitted send
finishing while paused. No drawing was created and the Worker first receipt-read
gate remains open. The production gate also requires migration 0231 and the
remaining production approvals. The sanitized rehearsal record lives in the
control-plane archive rewards-handoff-review-2026-09-30/STAGING-BRAKE-RESULTS.md.
