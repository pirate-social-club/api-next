# Spec 015 §5.2b draft: owner-executed Safe ticket-first pool

Status: draft proposed by the implementing session on 2026-10-23, not ratified.
Its authoritative home is `docs/specs/api-next/015-activity-rewards-community-tokens-megapot.md`
in the control plane; it lives here until a control-plane worktree is free. The
owner's October 22 ticket-first clarification is recorded in
`tasks/records/v1-safe-pilot-feasibility-20261022.md`. Nothing here decides the
open owner inputs listed at the end.

## Scope

This amendment applies only to a new `megapot_pool` leg version with
`purchase_order = ticket_first_v1` and `custody_kind = owner_safe_v1` on Base
8453. Existing legs, their purchase order and their server-signed custody are
unchanged. The pilot is one invited song pool.

## Custody (replaces §5.4 for these legs)

Custody is one dedicated Safe controlled by the workspace_owner. It holds the
pool's USDC, ticket NFTs and unclaimed or unpaid winnings. Pirate holds no key
for it and never signs or broadcasts for it.

Pirate prepares one call per effect: USDC approval, ticket purchase, winnings
claim and each participant payout. The owner executes that call in Safe{Wallet}.
Pirate does not choose the Safe nonce or gas limit. It binds an execution to a
prepared call by target and calldata, derives the consumed Safe nonce,
recomputes the Safe EIP-712 hash and then validates the business receipt. The
Safe hash and the outer transaction hash are recorded separately.

A Safe `ExecutionFailure` for a prepared call is a known non-payment: the nonce
is spent and no value moved. Any other ambiguous or nonconforming execution keeps
its reservations and goes to reconciliation. Because an exported call can still
execute later, nothing Pirate does alone ends a prepared call. Two unresolved
calls with identical target and calldata are refused, so one execution can never
settle two effects.

`pool_entries_off`, `pool_purchases_off` and `payouts_off` stop Pirate from
preparing new calls. They cannot stop the owner executing a call already handed
to them.

Allocation is Pirate's ledger, not a contract rule. The owner can move custody
funds. Participant-facing terms must say so plainly.

## Lifecycle (replaces the §5.2 order for these legs)

```
ticket_pending -> purchase_pending -> entry_open
purchase_pending -> closed_purchase_unavailable
entry_open -> cutoff_frozen -> committed -> drawing_pending
           -> no_win | winnings_detected -> claim_pending -> claimed
           -> allocated -> credited
any -> operational_hold
```

1. The purchase is prepared for the next drawing that leaves a full entry window
   before cutoff. Ticket numbers keep the §5.2 deterministic derivation.
2. Entries open only after reconciliation confirms the ticket in that intended
   drawing, owned by the Safe. Participants are never promised a drawing before
   its ticket exists.
3. `buyTickets` takes no drawing id, so a late execution lands in whatever
   drawing is current. A ticket confirmed in any other drawing is `needs_review`,
   opens no entries and never carries shares between drawings.
4. If the purchase has not executed before the latest time that still leaves a
   full entry window, the drawing closes `closed_purchase_unavailable`. The
   prepared call stays watched and keeps its reservation; a later execution is
   recorded and its ticket is `needs_review`.
5. Cutoff freeze is unchanged: `drawingTime − entry_cutoff_seconds`, the same
   canonical ordering, one share per `(account_id, pool_leg_id, drawing_id)`.
6. The beneficiary commitment is published with an external timestamp after the
   freeze and before `drawingTime`, instead of before purchase. It still fixes
   beneficiaries before the outcome is known. Pirate publishes it; the Safe does
   not sign it.
7. Sweep, winnings claim, `equal_v1` allocation and credits follow §5.2, with
   the winnings claim executed by the owner as a prepared Safe call.

The ticket is bought before anyone qualifies, so its cost is spent even when no
one qualifies. This replaces the `closed_no_entries` no-spend rule for these
legs.

## Zero shares at cutoff

The drawing still proceeds through sweep. If the ticket wins, the winnings are
claimed into the Safe and the drawing moves to `operational_hold` with reason
`empty_entry_disposition_pending`. No allocation, rollover or refund is applied
until the owner ratifies a disposition. A disposition is prospective: it never
changes a drawing that was already settled.

## Funding

The pilot leg is funded by the owner depositing USDC into the Safe, observed as an
operator funding effect. Participants never fund and never pay to qualify. Open
contributions by other sponsors remain for a later version.

## Payout (amends the §5.2a payout step for these legs)

Claim is unchanged: the participant initiates it on one credit and passes
claim-time Very verification. An accepted claim makes the credit eligible for a
prepared Safe payout to the persona wallet; it is not paid automatically. The
participant sees an awaiting-payout state until the transfer confirms. There is
at most one confirmed payout per credit. An unknown outcome keeps the credit
reserved; a confirmed `ExecutionFailure` releases it for a new prepared call.
Onward Send from the persona wallet stays Palm-gated and must work on Base.

## Unchanged

Share keys, the entry window, Study, singing and Dance qualification, freeze
ordering, `equal_v1` with deterministic remainder, claim-time verification and
never-expiring credits.

## Open owner inputs before a real pool opens

1. Disposition of winnings from a drawing with no qualifiers.
2. The Safe address, its owners and threshold.
3. `entry_cutoff_seconds`, the purchase safety margin and the minimum entry
   window.
4. Ticket, spend and gas limits for the pilot.
5. The commitment venue (§14.4 is already open).
6. The participant-facing custody and allocation wording.
