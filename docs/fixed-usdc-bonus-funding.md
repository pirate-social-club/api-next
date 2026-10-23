# Fixed-USDC pilot funding foundation

This is the first internal source slice of the invited Safe-funded bonus.
It supplies private custody-policy records, solvency observations and durable
song-budget reservations. It exposes no HTTP endpoint or Worker binding and
does not activate a reward, transfer money or emit a participant credit.

The asset identity is native USDC on Base, chain 8453, with six decimals and
the exact address published by [Circle](https://developers.circle.com/stablecoins/usdc-contract-addresses),
verified on October 23, 2026. The narrow policy is named
`base-native-usdc-fixed-bonus-v1`. Other tokens, chains and the existing
plain-ERC20 bonus-admission rules are not generalized by this slice.

## Accounting

One immutable custody policy owns one Safe address and one finite opening
USDC cap. A second custody ID cannot assign the same Safe again. The policy
records its review reference and the hash of the separately reviewed Safe
code, implementation, owner and threshold binding. Those references are not
proof that a review occurred. An ordinary participant or HTTP role receives
no authority to publish them.

An observation records exact chain, asset, Safe binding, block/hash, head,
time and balance facts. The database requires current timestamps, the declared
confirmation bound and the original custody binding. A known conflicting
block hash latches a durable hold. A deficit closes new reservations; a later
healthy observation can recover solvency but cannot increase the original cap.

All song-budget allocations serialize on the custody row. Their cumulative
amount is bounded by that fixed cap and their count by the admitted policy.
Each amount is an exact integer product of USDC atomic units and maximum
accounts, including above JavaScript's exact-number range. The public song,
audio revision and active community are checked under real authority locks.
Time and solvency freshness are checked after those locks. Participation can
start only after funding reservation, and no later than the policy window.

Budgets are accounting reservations inside an operator-controlled Safe, not
an onchain restriction on its owner. This foundation conservatively retains
the whole allocation against the lifetime cap. Releasing unused budget,
paying awards or increasing funding must use their later reviewed accounting
paths; a fresh balance snapshot is never another deposit.

Original command documents, hashes and receipts are immutable. Exact replay
returns the historical receipt before today's freshness, expiry, visibility
or solvency gates. A changed body with the same command identity conflicts.
An old positive observation receipt is not current readiness. The persistence
adapter does not retry a command or turn an unknown commit into a new purpose.

## Evidence and remaining integration

Native tests cover concurrent capacity, duplicate Safe/custody identities,
exact arithmetic, stale observations after real row-lock waits, hidden songs,
expiry, immutable history and a real commit followed by an injected lost
acknowledgement. Restricted SCRAM access is tested on an actual populated
0307-to-0308 migration, because the generated test baseline intentionally
omits ACLs. No baseline-only test is substituted for that access evidence.

The observation inputs in these tests are synthetic. A production chain
observer, reviewed operator execution/approval workflow and current Safe
binding verification remain to be implemented before real observations can
be admitted. Database connectivity and a caller-supplied acceptance reference
do not authorize an external operation. No production role grants are made
by this migration or by this work.

This foundation still needs the default-off independent runtime switch,
immutable Study/singing/Dance qualification bindings, Palm-before-earning
admission, first-account credit deduplication, Safe payout preparation and
reconciliation, participant pending/paid views and Base Palm-gated Send.
There is no separate participant Claim. The existing production lottery
refusal stays in place. None of those missing capabilities is represented as
complete by a custody or budget receipt.

The bonus PR is stacked on Funding36c28b49 and changes no public contract.
Its current breaking-change policy is empty: the inherited eight Dance
declarations apply only to the parent PR's50f50bfa baseline and would be stale
against this branch's actual base. Their exact original bytes remain in a
historical test fixture, with the complete addition/removal and extra-break
refusal tests retained. This does not retire the parent PR's declarations or
approve that separate transition. The historical0306-to0307 native rehearsal
also pins its terminal at0307 rather than silently applying later migrations.
