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

An operator command writes a Safe Transaction Builder file for one prepared
effect: chain 8453, one call, `value` 0. The owner imports it in the Transaction
Builder app and executes it. A single call becomes a direct `execTransaction`
with operation 0, which is the only shape the existing Safe receipt validator
accepts. USDC approval is its own command, ahead of purchases, so no MultiSend
batch is needed.

Safe{Wallet} chooses the Safe nonce. Pirate therefore does not reserve Safe
nonces. It binds each command by content: target, calldata, value 0 and
operation 0. When reconciliation finds an `ExecutionSuccess` or
`ExecutionFailure` on the Safe, it decodes the outer `execTransaction` input,
reads the Safe nonce at the parent block, recomputes the Safe EIP-712 hash and
then runs the existing business receipt checks. The Safe message hash and the
outer transaction hash are stored separately.

Content binding needs unique calldata among unresolved commands. Purchases and
claims are unique by construction (derived ticket numbers, exact ticket ids).
A payout is a USDC `transfer(recipient, amount)`, which can repeat, so Pirate
refuses to prepare a payout whose calldata matches another unresolved command.

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

This needs a new allowed-transition set for pilot drawings in
`guard_megapot_pool_drawing`. Existing legs keep their order.

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

## Verification without load

Pure functions (command build, Transaction Builder export, execution decoding,
content matching) get focused unit tests. Database constraints get focused
PostgreSQL cases once heavy local work is acceptable again. The existing fork
proof remains the contract-compatibility evidence.
