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
any outstanding winnings-claim deadline; this implementation does not establish
that an indefinite claim pause is safe.

## Drawing and refund behavior

When a paused drawing passes its purchase window, a proven unsent committed
purchase closes as closed_purchase_unavailable through the existing prebroadcast
closure. It releases reserved ticket budget and does not project a purchased
ticket. Existing offer expiry rules preserve remaining leg funding and create
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

The public Base Sepolia RPC returned 23,614 bytes for the pinned Jackpot
0x465da3c859f193a3807386387bee941b2a4c3279. Their keccak256 matches manifest hash
0x8d3104deb8a3fb663c67f8d4a2da43a15aaf5ad8b0e1d303ceed09f582dd4bc9.
The runtime metadata identifies Solidity 0.8.28 and IPFS metadata CID
QmYhi81fHfpM3eJU2ni5nV2qJUia7LbFvwqBgcsijchGKV. This establishes code identity,
not a match to the public audit source. Explorer and metadata-gateway reads did
not yield the build metadata. A matching source/compiler/settings/immutables
comparison and a historical winning-ticket simulation remain unproved.

An old claim that succeeds at a pinned head establishes claimability at that
age. It cannot exclude a longer finite deadline. Repeat verification against
the selected, independently attested Base mainnet contract and its calculator
before approving production claim-pause policy. Read-only checks also confirmed
that the parked Base mainnet candidate at
0x3bae643002069dbcbcd62b1a4eb4c4a397d042a2 still matches its pinned runtime hash
0x597f3a8e9360fbfc2e623243507ee9e8a66609003078ffc33d9013cb0607002d
at block 51,963,965. Historical ticket logs were retrieved on both chains.
Owner reads for sampled positive-payout tickets mostly reverted with
0xceea21b6; rate-limit failures also occurred. No unclaimed winner was
successfully simulated. These reads do not establish claim expiry or
claimability. No claim was submitted.
The current production record
still selects no activated mainnet attestation; the parked candidate does not
supply that approval.
