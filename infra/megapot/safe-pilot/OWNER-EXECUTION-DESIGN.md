# Owner-executed Safe pool: implementation design

Status: working design for task `v1-safe-pilot-feasibility-20261022`. It is not
a spec amendment and adopts no unresolved owner terms.

## Roles

The workspace_owner controls a dedicated Base Safe that holds the pool's USDC
and ticket NFTs. Pirate never signs or broadcasts for that Safe. Pirate prepares
exact calls, the owner executes them in Safe{Wallet}, and Pirate reconciles what
the chain shows against what it prepared.

The Safe must be dedicated to this pool. Unrelated Safe transactions are
tolerated by reconciliation but make operator review harder.

## How the owner executes a command

`scripts/safe-pool-export-calls.ts` writes one Safe Transaction Builder file
for each prepared call: chain 8453, one call, `value` 0. The owner imports a
file in the Transaction Builder app and executes it as its own transaction. A
single call becomes a direct `execTransaction` with operation 0, which is the
only shape the Safe receipt validator accepts; a call executed inside a MultiSend
batch is not recognized.

The owner sets the Safe's USDC allowance for the Jackpot once, directly in
Safe{Wallet}. Pirate prepares no approval call: before each purchase it reads
the allowance and the Safe's USDC balance and prepares nothing while either is
short.

Safe{Wallet} chooses the Safe nonce. Pirate therefore does not reserve Safe
nonces. It binds each command by content: target, calldata, value 0 and
operation 0. When reconciliation finds an `ExecutionSuccess` or
`ExecutionFailure` on the Safe, it decodes the outer `execTransaction` input,
reads the Safe nonce at the parent block, recomputes the Safe EIP-712 hash and
then runs the existing business receipt checks. The Safe message hash and the
outer transaction hash are stored separately.

Content binding needs unique calldata among unresolved commands. Purchases and
claims are unique by construction (derived ticket numbers, exact ticket ids).
A payout is a USDC `transfer(recipient, amount)`, which can repeat, so the
database refuses a second prepared, confirming or held Safe call with the same
target and calldata until the first resolves. Each call also records its first
eligible block, the block after the mined head when it was prepared (or the scan
cursor, if later), and only an execution from that block on can bind to it. An
identical transfer already mined when the call was prepared cannot have been that
call.

## Effect machine mapping

`reward_chain_effects` gains `execution_mode` (`eoa` default, `safe_owner_v1`)
and explicit Safe columns: `safe_address`, `safe_nonce`, `safe_transaction_hash`,
`safe_execution_status` and the executing owner address. The shape constraints
are rewritten per mode. Existing EOA rows keep their exact constraints.

| State | Safe meaning |
|---|---|
| planned | effect exists, calldata not yet fixed |
| prepared | calldata fixed and exportable; no signed bytes, no nonce |
| confirming | a matching Safe execution was found; outer hash, block, nonce recorded |
| confirmed | execution success plus the business receipt validated with confirmations |
| reverted | the Safe emitted `ExecutionFailure` for the matching call; nonce spent, no business effect |
| reconciliation_required | ambiguous evidence; reservation kept |
| terminal_failed | ended before any calldata was fixed |

A prepared call is never withdrawn by Pirate. An exported Safe transaction can
still execute later, so a prepared effect only moves forward on an observed
execution, and the pool drawing that needed it closes around it while the
effect keeps its reservation.

The purchase, claim, approval and payout repositories keep their business
confirmation steps (inventory, receipt evidence, leg spend, allocation, credit
transitions). Only the sign and broadcast steps branch by mode.

## Ticket-first pool order

The 0053 machine purchases after the beneficiary commitment. The pilot pool
version reverses that, following the October 22 owner clarification:

1. The pool's Safe purchase is prepared for the next drawing that has enough
   time left for a full entry window.
2. Reconciliation reads the actual drawing from `TicketPurchased`. A ticket for
   the intended drawing confirms it and opens entries for that drawing. A ticket
   that landed in a different drawing is held for review and opens nothing.
3. Entries close at `drawingTime − entry_cutoff_seconds`. The frozen snapshot is
   committed before the drawing instead of before the purchase.
4. Sweep, winnings claim, `equal_v1` allocation, credits, participant Claim and
   payout follow the existing order.

Migration 0311 adds that transition set for ticket-first drawings. Existing legs
keep their order, and every work listing serves one purchase order, so the EOA
cycle never touches a ticket-first pool.

A ticket-first commitment is published unsigned under the key id
`unsigned_owner_safe_v1`, which the database admits only for ticket-first pools.

A purchase not bound by its deadline (`entry_cutoff_at` minus the minimum entry
window) closes its drawing as `closed_purchase_unavailable` but keeps both the
prepared call and its reservation. If the owner's execution is bound later, the
effect goes to `reconciliation_required` and the reservation stays, so the leg
cannot refund it; the Safe holds a real ticket for a closed drawing. Resolving that
case is an owner procedure that is not yet built. To keep the scan from being the
cause, a purchase is prepared only when the scan can catch up to the settled head
and bind one more cycle's executions before the purchase deadline; otherwise
preparation returns `scan_lagging`. The October 23 chain rehearsal produced three
such late purchases while its scan was stalled and then catching up.

## Claims

A winning drawing's `claimWinnings` call is recorded alone when it is prepared.
When reconciliation binds the owner's execution, settlement validates the claim
receipt and reads the Safe's USDC and referral balances at the execution's
parent block and at its block, because the Safe may execute other calls between
preparation and the claim. One transaction then reserves the ticket, records the
claim detail with those balances, and confirms the claim with the EOA claim
ledger code. An `ExecutionFailure` reverts that attempt and leaves the drawing
`winnings_detected`; up to three attempts are prepared before the drawing is
held. Megapot burns a claimed ticket, so no attempt can pay twice.

## Payouts

An accepted participant Claim no longer becomes payable automatically. It makes
the credit eligible for a prepared Safe payout. The participant sees "Awaiting
payout" until the transfer confirms. An unknown or ambiguous outcome keeps the
credit reserved; a confirmed `ExecutionFailure` releases it for a new command.

## Not changed

Share keys, the entry window, Dance/Study/singing projection, the beneficiary
snapshot, `equal_v1`, claim-time Very verification, never-expiring credits and
the held automated-signer worktree.

## Spec amendments needed before a real pool

Spec 015 requires the commitment before purchase and no spend for an empty
pool. Ticket-first reverses both. Spec 015 §5.4/§9 also describe server-signed
custody. Both need a dated amendment. Empty-entry winnings disposition, the
Safe identity and threshold, the entry cutoff and spend/gas limits remain
owner inputs.

## Running the pilot

The `safe-pool-pilot.cycle` step runs every minute when `SAFE_POOL_PILOT_ENABLED`
is set; it is off by default. It shares reward legs and credits with Study
recovery and with contribution funding recovery, so it runs as the financial step
of their serial job, the place the EOA rewards cycle takes when that lane is on,
and contribution recovery runs with it. In order, it observes
the drawing, scans the Safe, settles bound purchases and payouts, confirms
pending funding transfers into the Safe, closes unexecuted purchases, prepares
tickets, freezes, publishes commitments, sweeps,
settles and prepares claims, allocates, observes the Safe's solvency and
prepares payouts for accepted participant credits. It never signs or sends.

Enabling it needs `SAFE_POOL_ATTESTATION_ID`, `SAFE_POOL_RPC_URL`,
`SAFE_POOL_COMMITMENT_PUBLIC_ORIGIN`, `SAFE_POOL_MINIMUM_ENTRY_SECONDS` (at least
60) and the `MEGAPOT_COMMITMENTS` bucket, and production attestations also need
`SAFE_POOL_PRODUCTION_ENABLED`. It shares tables with the EOA rewards job, so
configuration with `MEGAPOT_REWARDS_ENABLED` also set is refused. Production
reward work still requires the run lease and an unpaused brake, and a production
leg must carry `legal_activation_gate = 'production_approved'` to be active (see
Production activation below).

The HTTP worker serves the offer, funding, Claim and credit routes for the
pilot's attestation when its own `SAFE_POOL_PILOT_ENABLED` is set, with
`SAFE_POOL_ATTESTATION_ID` and `SAFE_POOL_RPC_URL`. It refuses that together with
`MEGAPOT_REWARDS_ENABLED`, and serves a production attestation only when
`SAFE_POOL_PRODUCTION_ENABLED` is also set; otherwise the routes stay mounted and
answer that rewards are unavailable. In pilot mode it confirms funding into the
Safe and offers no gas top-ups or winner sends: winners send onward with the
sponsored Wallet Send, which production serves only when
`PRIVY_SPONSORED_SEND_PRODUCTION_ENABLED` is set and then only for Base USDC.

A leg is created through the offer API (`OpenSongRewardOffer`,
`AddMegapotPoolLeg`) on the active attestation; migration 0312 makes it
ticket-first because its custody is the Safe. Its funder sends USDC from their own
persona wallet into the Safe and submits the transfer (`ObserveMegapotPoolFunding`);
the pilot cycle confirms it and the leg becomes active once it holds one ticket's
price. Shared-song contribution legs also name Dance and cannot be created until
Dance is active.

### Staging rehearsal on Base Sepolia

Safe custody is admitted on Base Sepolia outside production, so staging can run
the whole pilot with test funds: retire the staging EOA attestation (one active
attestation per environment), turn `MEGAPOT_REWARDS_ENABLED` off in both
workers, register a Base Sepolia Safe with
`API_NEXT_ENV=staging bun scripts/register-safe-pool-custody.ts --apply`, set the
pilot variables in both workers, then open and fund a leg through the staging
API. Onward Send already works on Base Sepolia. The workspace_owner authorized a
throwaway Base Sepolia owner key for the test Safe on 2026-10-23. Applying
migrations 0309 to 0312 to staging before this branch reaches main would fork
staging's migration ledger from main.

### Production activation

Spec 015 section 13 defines a dated, per-environment production activation gate,
and migration 0053's `legal_activation_gate` records it on each pool leg. The
pilot writes it: behind `SAFE_POOL_PRODUCTION_ENABLED`, `AddMegapotPoolLeg`
creates a production leg only on owner-executed Safe custody with `no_purchase`,
recorded `production_approved`, so turning that switch on is the pilot's
activation. Every other production leg is still refused. A production offer labels
its empty legal-eligibility rules `production_empty_v1`.

Requirements with a source. Section 13 asks, before production activation, for the
deployment attestation (the custody registration script records it), Base 8453
admission (in place for the pilot), live custody solvency observation (the pilot
cycle), exercised kill switches (the reward operations brake exists and has not
been exercised in production), a real testnet-to-mainnet claim-and-payout proof or
a countersigned bounded-risk waiver, and an evidence-based 24-hour staging closeout
under Spec 004 section 15. Its legal disclosure and counsel sign-off items are not
current launch gates: the workspace_owner excluded Megapot legal, licensing,
nationality, counsel and jurisdiction work until after launch (record
rewards-mainnet-megapot-runtime, 2026-10-21). Its external-sponsor referral item
does not apply, because pilot legs have no funder fallback.

Unfinished implementation. Solid has to take api-client 0.134.0, which admits
chain 8453 on pool legs, pool funding and the pool projection under a declared
deprecation, and its winnings Send has to accept Base. Privy's own gas sponsorship
has to be enabled for Base mainnet. The staging rehearsal and closeout have not
run.

Owner choices that remain are the Spec 015 amendment's terms: empty-drawing
disposition, the Safe and its threshold, the entry cutoff and minimum entry
window, and ticket, spend and gas limits.

## Verification

Unit tests cover the pure functions, the coordinators' admission rules and the
cycle's order. `reward-safe-ticket-first.pg.test.ts` drives one pool on
PostgreSQL with a fake chain from purchase through participant payout (legs,
shares and identities seeded), plus the failure, deadline, wrong-drawing,
empty-drawing, export, custody-order, planned-drawing and Safe funding cases;
`reward-safe-payout.pg.test.ts` covers payouts from seeded credits, and
`reward-safe-pilot-routes.pg.test.ts` composes the HTTP worker against PostgreSQL
and shows the pool route served for an admitted Safe attestation and unavailable
otherwise. These run on
Base; the Base Sepolia rules are covered by unit tests. The fork
proof remains the contract-compatibility evidence. None of this has run against
a live chain.
