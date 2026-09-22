# Current-flow staging rehearsal authorization package

Status: incomplete preparation, not an execution authorization. This package
does not authorize ceremonies, credentialed live reads, paid providers,
bootstrap, flags, deployment, funding, signing, execution or a waiver.
The automated PostgreSQL proof merged at df44b806 is not live evidence.

Disposition: retain this dated file as a non-authorizing review draft only.
The completed, run-specific package and its approval must be attached to
control-plane task `tasks/records/rewards-current-flow-live-acceptance.md` in
pirate-workspace, not filled into this repository document. Use role identifiers
and account ids only there; keep credentials, biometric payloads and raw proofs
out of both repositories. This draft is not a permanent approval or live status.

## Inputs the owner must supply

Identify at least two distinct current staging accounts with community-bound
payout personas, one for Study and one for Karaoke. Each needs a fresh real
Very palm ceremony on rebuilt staging. A third verified participant completing
both activities is optional, not a prerequisite. Add a separate unverified
account that completes a qualifying activity but receives
`ineligible / verification_missing` and no share. Community posting membership
is not an additional activity-admission requirement.

For every account, supply its account/persona ids and confirmed wallet
assignment/address. For verified accounts, supply the actual ceremony reference,
proof session, subject/binding, receipt, assertion identities, observation and
expiry, and accepted revalidation. Keep credentials out of this package. No
current identities or completed ceremonies have been established by this work;
historical accounts and SQL-seeded receipts are not substitutes.

Obtain the song-owning lane's explicit handoff of one public staging song:
community/post/owner persona, audio and lyrics revisions, rights, accepted
lyrics, at least four current Study exercises, ready Karaoke revision with at
least five timed lyric lines and full-mix playback. Confirm that this is not
another lane's single-use fixture. No qualifying current handoff is established.
The September 21 processing submission is not a ready song merely because
lyrics were saved.

For Karaoke, supply reviewed participant vocal PCM, mono signed little-endian
16 kHz, exact duration and SHA-256, consent reference and retention permission.
The harness streams it through the real provider; it never supplies fabricated
transcripts or scores. This is an API/transport rehearsal, not browser microphone
capture proof. Study retains the existing local synthesized-audio driver.

## Limits and timing

All economic values remain unfilled. Supply sponsor account/persona/wallet,
test-USDC funding, maximum ticket price, one-ticket total cap, maximum sponsor
exposure and outstanding participant liability, native gas cap and reserve
floor. Supply Study submission/provider-cost caps and Karaoke attempt, duration
and provider-cost caps. Unlisted moderation, generation and other paid calls
have zero allowance. Old test funding and unrelated song budgets are not approval.

Supply absolute UTC offer start/end, execution start, target drawing and actual
cutoff, completion deadline with safety margin, reconciliation deadline,
closeout start/end and final-disable deadline. The offer must not admit another
drawing capable of purchasing a second ticket. The operator must establish this
from current chain timing before funding; the runner detects a second ticket
as a breach but cannot enforce the scheduler's spending limits from a client.
Gas and monetary provider caps likewise require independently verified operator
controls. Recording a numeric cap in JSON is not enforcement of it.

## Deployment and bootstrap

Supply fresh HTTP/jobs source SHAs, Worker versions and traffic, schema ledger
head/checksum, current policies and disabled flag readbacks. Name an explicitly
reviewed, schema-compatible rollback HTTP/jobs pair and its expected flags.
Retained September 21 observations at source 1f32d595 are historical inventory,
not designated rollback versions or fresh readback. No pair is selected here.

Approve re-bootstrap of `megapot-base-sepolia-v2` only with the final package.
Verify chain 84532, manifest contract identities/code hashes, token admission,
attestation anchor, custody/referrer, current drawing, lock, ticket price,
purchases-allowed state, confirmations, allowance, balances and solvency.
Record secret names only. Bootstrap and deployment are deliberately absent
from the runner.

## Operational decision still required

The registered plan leaves only the authorized reward scheduler running through
terminal reconciliation and the affected-flow 24-hour liveness window, then
disables both flags and reads them back. Immediate disablement after settlement
cannot prove 24 hours of scheduler liveness. The owner must explicitly choose
that bounded enabled window or amend/defer the liveness gate. Preparation makes
neither choice.

Require one share per eligible account, all requested qualifications, no share
for the negative, the exact frozen beneficiaries and custody ticket, and either
terminal no-win with residual refund or natural win with claim, equal split,
confirmed payouts and residual refund. Stop new work on any ambiguous effect;
do not create replacement attempts, transfers or offers. Unresolved effects
remain failed acceptance and require operator reconciliation.

## Approval record

Still missing: approving role and timestamp, exact participant/song artifacts,
all limits and windows, current deployment/rollback evidence, bootstrap and flag
approval references, selected disablement policy and one-run staging-only scope.
The reviewed runner commit and local test results must also be attached before
approval. Production, a second offer, broader rollout and any winning-proof
waiver remain excluded. The waiver requires its own countersigned decision.
