# Safe pilot feasibility

This is a local fork proof for owner-executed shared song-pool custody. It starts
from accepted api-next main `50f50bfa`, independently of the held automated-signer
merge. It does not enable Rewards or install an operational signer.

Twelve tests pass against deployed Base contract code at block 52944896. The
stale-purchase reproduction also uses block 52890000. `fork-evidence.json`
records their hashes, contract identities and the USDC implementation. Two RPCs
agree on both block hashes. Only the primary supplied archive code/state;
PublicNode requires a personal token for those reads, and that limitation is
retained. Safe 1.4.1 identities match its official deployment registry.

Run with Foundry 1.8.3 and solc 0.8.30, from this directory:

```sh
forge fmt --check
forge test -vv --threads 2
```

The configured RPC is read-only fork input. There is no broadcast script, FFI,
managed credential or live wallet. The small fixture signing key is for the
local Safe only. Fixture funding impersonates a token holder inside the fork;
the winning test locally transfers a historical round-211 ticket to the Safe.
Those actions change no public state and do not demonstrate real sponsor
funding, qualification, a new natural win or a participant payment.

## What the proof establishes

A Safe can approve USDC, buy a ticket and own its NFT. It can claim an existing
winning NFT through the actual Megapot contract, receive 5.605799 USDC net, then
execute exact transfers to two fixture recipients. The purchase and historical
claim use different tickets; this is contract compatibility, not one complete
funded product journey. The two fixture amounts test transfer conservation,
not Pirate's equal-allocation policy or Palm acceptance.

Replaying an executed signature fails. Confirmed cancellation at the same nonce
invalidates a queued signature. A failing transfer later in a batch rolls back
its earlier transfer. Safe can also consume a nonce and emit ExecutionFailure
without paying, so an outer successful transaction or changed nonce alone is
not payment evidence. Conversely, a newly signed nonce can pay the same
recipient and amount again. Safe replay protection does not enforce one payout
per Pirate credit; durable credit reservations and reconciliation are required.

The unchanged signature prepared during drawing 211 buys into drawing 212 when
executed on the later fork. Neither the Safe signature nor Megapot buyTickets
binds an intended drawing. A UI deadline or deleting a pending proposal cannot
fix this. Cancellation only works once its competing transaction confirms.

## Small change to the proposed design

`DrawingPurchaseCheck.sol` is a candidate stateless check called first in the
same atomic MultiSendCallOnly batch as approval and purchase. It requires Base,
the fixed Megapot deployment, the expected drawing, open purchases, an unlocked
drawing, an exact positive price and a signed deadline no later than the
provider's drawing time. At or after that deadline it refuses.

Fork tests cover a valid guarded purchase and refusal for a different drawing,
changed price, invalid deadline or expired signed deadline. Refusal leaves no
purchase, spend or allowance. A production batch builder must derive the
deadline from frozen terms and the purchase safety margin, bind the check's
deployed address/code, and require the check before the exact approved calls.

This is one new contract, not a Safe module or settlement contract. It has no
storage, administrator, fund custody or allocation logic. It cannot constrain a
Safe owner who omits the check or signs other calls. Independent contract review
and exact deployment verification remain required; it has not been deployed or
accepted as a release artifact. Existing contracts without this check do not
establish the proposed timing guarantee.

## Integration still required

The current `megapot-v2.ts` receipt validators require an outer transaction
from custody directly to Megapot or USDC. A Safe execution has a different
outer envelope. Add explicit Safe evidence validation; never relabel or
fabricate the receipt's from/to fields to pass the old checks. Bind the exact
chain, Safe, nonce, transaction hash, call list and manifest before exporting
a packet. Reconcile Safe execution and the exact ticket/token events against
that same command. An unknown result keeps its reservation and forbids a
replacement payment until resolved.

Reuse the existing beneficiary freeze, pre-purchase commitment, allocation,
participant-initiated Palm-gated Claim and never-expiring liabilities. Only
accepted claims enter a payout batch. The participant sees awaiting payout
until its transfer confirms. Unclaimed and conflicted credits stay reserved.
Refunds retain the confirmed funders' proportional entitlement.

Confirmed missed purchases close only their original drawing, preserve
learning and unspent pool accounting, and never silently roll shares into
another drawing. Ambiguous purchases remain pending. This proof does not yet
exercise database concurrency, restart recovery, live roles, generated client
intake, Solid Claim/Send, gas provision, four-Worker deployment or phones.

## Smallest next delivery

The workspace_owner rejected the provisional 15–30 focused-day plan on October
22. That range is retained here only as a superseded estimate for the broader
integration, not an accepted launch schedule. Do not substitute a shorter
calendar promise without an executable product slice.

The next delivery is one invited song pool using the existing website and
owner-executed Safe transactions. Run settlement through a focused operator
command before building a dashboard or scheduler. Reuse the existing share,
allocation, accepted-claim and credit-reservation rules. Keep the first payout
command to one accepted credit if batching would delay receipt correctness;
batching is an optimization. Claim remains participant initiated and Palm gated.
No money moves merely because the participant opens the wallet. Onward Send
must work on Base mainnet with usable gas.

The initial code audit found that `reward-payout-repository.ts` already locks
and reserves payable credits, but its prepared/submission states require an
EOA signed transaction and equate its hash with the outer transaction hash.
Safe's signed message hash and execution transaction hash are different.
Changing labels or storing invented EOA evidence is not a reuse strategy.
Adapt that boundary explicitly and retain reservations through unknown outcomes.
The existing receipt validators also require direct EOA calls, as described
above. These are concrete integration changes, not missing pool arithmetic.

The owner has been asked whether the pilot may buy and confirm a ticket before
opening entries. This could remove the late-purchase race and check-contract
deployment, but changes the current lifecycle: the database admits entry-open,
cutoff-frozen, committed and purchase-pending in that order. It also spends the
ticket cost when nobody qualifies. The question is pending. Do not implement
that economic/order change or present it as a proven speed-up without the
answer and a source comparison. Preserve the current purchase order meanwhile.

Dance remains in scope unless it becomes the sole remaining launch blocker;
any Study/singing-only offer would be a new prospective pool version. Telegram
chat participation is v1.1. Restricted-role migration/serving-worker rehearsal
and the real phone journey still establish release readiness. The fork's
historical winner does not satisfy the required real positive allocation.

## Local validation

Foundry: 12 tests pass and formatting passes. The repository's `bun run check`
and `bun run test` both exit zero. The latter reports 6,399 unit tests passing,
four existing skips, 24 storage tests, 22 Node tests and 248 workerd tests.
This source has not had independent review, hosted PostgreSQL qualification or
release acceptance. The repository checks do not automatically run this Forge
suite; invoke it explicitly with the command above. No production source,
configuration, migration, Worker or live fund state is changed by this proof.

## Sources

Contract addresses and interfaces came from the official
[Megapot reference](https://llms.megapot.io/contracts/reference). The historical
ticket was located through its public round-211 wins API and independently
consumed by the deployed contract in the fork. Safe identities came from
[safe-deployments 1.4.1](https://github.com/safe-global/safe-deployments/tree/main/src/assets/v1.4.1).
The batch format follows [Safe Transaction Builder](https://help.safe.global/articles/4180673514-transaction-builder).
