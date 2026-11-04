# Mainnet Rewards Claim and Send source handoff

The owning API source lane is draft PR406. Production Rewards remains disabled. This document assigns no Solid writer, deployment, signing authority, custody backend, numerical production cap or gas policy. Backend and local-fork results cannot establish browser wallet control or user spendability.

## Existing boundary

Accepted API main already includes participant Claim, gas-top-up requests and durable winner-send records. Standalone Solid already has `src/api/reward-claim.ts`, `reward-winnings-send.ts`, `reward-wallet-session.ts`, the wallet winnings UI and its send/recovery model. These are Base Sepolia paths. `RewardWinnerSend` pins84532; the generated reward/send contracts use84532 literals; Solid's provider switch, public chain reads, record validation, send eligibility and explorer links also select Sepolia. The generic sponsored-send UI is not an implicit mainnet Rewards integration.

Claim is the account's eligibility ceremony, distinct from the platform's on-chain Megapot winnings claim. It consumes current server-verified evidence and preserves account-level uniqueness. Payout requires accepted Claim authority and the credit's original persona/wallet destination. An allocated or pending credit remains owed; it is not a confirmed wallet balance.

## Coordinated API/client intake

The API coordinator must publish reviewed mainnet reward, Claim, paid-credit, gas and winner-send contracts and generated client artifacts before the Solid lane consumes them. Preserve existing Sepolia behavior. Bind chain8453, the exact attested USDC token and decimals, confirmed payout destination and credit identity throughout the send record. Never derive authority from a browser-supplied token/address or a display balance.

Existing endpoint families are `/rewards/credits`, `/rewards/credits/:creditId/claim`, `/rewards/claim-verification-intents`, `/rewards/gas-topups`, `/rewards/credits/:creditId/send` and `/rewards/winner-sends/:sendId/{transactions,cancellation}`. Extend their reviewed contract rather than inventing a parallel client or bypassing durable send records. Any frozen phase0 contract/port proposal remains coordinator-mediated.

All authenticated API calls stay behind Solid's same-origin `/api` proxy and host-only session. Unsafe requests retain exact Origin and CSRF checks. No browser bearer exchange, server use of the user's wallet secret, wallet delegation or automatic sibling-persona consolidation is implied.

## Solid implementation sequence

1. Extend the generated-client consumers and network descriptors explicitly for the reviewed mainnet contract. Select chain, token, decimals, RPC reads and explorer from validated server identity. Reject an unsupported or mismatched chain before signing.
2. Resolve the authenticated account's exact original payout persona and active wallet assignment. Verify the embedded provider/account/index and chain match the confirmed payout destination. Login alone does not prove wallet signing authority.
3. Preserve the durable send protocol: reserve one credit/send attempt and sender nonce before wallet interaction; sign the exact recorded recipient, token, atomic amount, nonce and zero native value. Attach every accepted transfer/replacement/cancellation hash. Refresh state after interruption or reload before another signature.
4. Integrate only the separately selected and bounded mainnet gas mechanism. Keep any gas wallet separate from Megapot custody. Missing sponsorship or gas must produce an honest unavailable state. This source handoff selects neither paymaster nor top-up amount, limits, signer or funding.
5. Preserve `retryable`, `pending`, `confirmed`, `reverted`, `cancelled` and `settled_unverified` handling. Wallet rejection is not transaction failure. Unknown or pending outcomes cannot release a nonce or create a second spend. Cancellation requires verified same-nonce consumption, and late hashes must reconcile the existing attempt.

## Acceptance and separate release evidence

Focused component/provider tests cover wrong account/persona/network/token, tampered recorded instructions, exact atomic arithmetic, insufficient USDC, missing/insufficient gas, user rejection, same-nonce replacement/cancellation, concurrent clicks/tabs, restart before and after broadcast, failed attachment, late receipts, reorgs and duplicate callbacks. Wallet balance alone cannot prove the recorded send.

The product acceptance sequence is: exact allocation becomes an accepted Claim; its payout canonically reaches the assigned persona wallet; the same authenticated user authorizes an onward USDC transfer to a chosen destination; a canonical receipt proves sender/token/recipient/amount and matching source/destination balance deltas. Gas use and failure/recovery are recorded separately. No backend test or inbound transfer alone satisfies this sequence. Public-chain acceptance requires its own later authority and reviewed live packet; none is granted here.

Solid owns focused tests, type/lint/unit, SSR/hydration, Worker build, session/CSRF and generated-client provenance acceptance in its separately admitted worktree. API gates and disabled production posture remain independently mandatory.

## Versioned Safe source intake

The current implementation adds the internal application subpath
`@pirate/application/rewards/safe-settlement-v1`. This is a local-only backend
port, not a published HTTP or generated-client release. Existing generated
Sepolia contracts and client0.119 remain exact; client0.120 belongs to another
candidate. The coordinator selects any eventual release version and mediates
frozen contract changes separately. Solid must wait for that reviewed intake.

The source distinguishes collection-root-to-Safe backing from the relayer's
outer transaction to the credit module and the Safe's inner USDC transfer to
the immutable original persona/wallet assignment. An independent fake issuer
signs EIP712 chain8453, module, root, token, original recipient, amount and expiry.
The module bytes32 credit ID is `keccak256(UTF8(ledger credit_id))`; this mapping
is versioned with the module domain. Database states are `authorized`, `signing`,
`signed`, `broadcast_unknown`, `submitted`, `confirmed` and `held`. Unknown signing
uses lookup of the original key; unknown broadcast never starts another send.
Only matching canonical finalized module and token Transfer logs mark a credit
paid. A held or uncertain credit remains reserved and owed.

The eventual consuming receipt must expose a discriminated settlement family,
ledger credit ID, chain/token/decimals/atomic amount, original account/persona/
wallet assignment and destination, outer relayer/module/nonce/hash, inner Safe
root and matching Transfer/module log indexes, canonical block/hash and finality.
An EOA payout sender field cannot stand in for the Safe root. Current gas-top-up
and winner-send repositories still derive authority from the historical direct
payout receipt and Sepolia contracts; they do not yet consume this new journal.
No browser may infer a spendable mainnet credit from `state=sent` alone.

Local persisted proof covers funding, approval, observed drawing, cutoff,
commitment, actual purchase, controlled win and loss, finalized on-chain claim,
1001 gross = 100 referral accrual + 901 net, deterministic450/451 allocation,
accepted original-wallet participant Claim, journaled Safe backing and settlement,
refund and zero remaining credit/refund liability. Activity/uniqueness evidence
is an explicit offline prerequisite. The controlled draw and capability-guarded
local expiry clock do not establish deployed randomness or wall-clock live
operation. Actual user wallet control, gas availability and onward canonical
receipt remain separate Solid acceptance requirements.
