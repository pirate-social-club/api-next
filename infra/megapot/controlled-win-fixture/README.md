# Controlled Megapot winning fixture

This contract is only for isolated Base Sepolia acceptance. It is not a
Megapot production deployment and does not test the public contract's
randomness. Every ticket it sells pays tier 1 after the drawing closes. The
operator must fund the contract with enough test USDC and arm the drawing
before any ticket is bought. The outcome and payout amount cannot be changed
after arming. Each drawing accepts one ticket, and old unpaid winnings remain
reserved when the next drawing is armed.

The contract implements the Megapot V2 reads and writes used by api-next. It
mints a separate ticket NFT, emits the purchase and order logs, burns the NFT
on claim, emits a zero-value referral log, and transfers the configured USDC
from the jackpot to the ticket owner's wallet. The constructor rejects every
chain except Base Sepolia, chain 84532. The operator can arm a drawing, and
anyone can settle it after its stated time. A draw with no ticket releases its
reserved prize when settled.

The companion local test token has six decimals, standard ERC-20 metadata, a
fixed supply of at most 10 USDC, and no mint method. The live deployment uses
the existing Base Sepolia USDC contract at
`0x036cbd53842c5426634e7929541ec2318f3dcf7e`, whose code hash and balance
must be read back before funding.

Build and test with the pinned Foundry container and compiler profile from
this directory:

```sh
docker run --rm --user 1000:1000 -v "$PWD:/app" -w /app \
  ghcr.io/foundry-rs/foundry:v1.8.3 'forge test --summary'
```

The compiler is Solidity 0.8.30 with optimization, via IR and no CBOR
metadata. `out/` and `cache/` are ignored build output. The test deploys a
local mock token, buys and settles one ticket, checks the event shapes and
custody payout, refuses a second ticket and claim, and refuses an unfunded
draw.

The RPC proof uses a local Anvil process on port 18545. Start it in a separate
terminal from this directory, then run the proof from the api-next repository
root:

```sh
docker run --rm --network host ghcr.io/foundry-rs/foundry:v1.8.3 \
  'anvil --silent --host 127.0.0.1 --port 18545 --chain-id 84532'
bun run prove:megapot-controlled-win:local
```

The proof creates a random local account, funds it only inside Anvil, deploys
the mock USDC and fixture, and calls the repository's Megapot RPC adapter and
purchase and claim receipt validators. It prints transaction hashes and the
amount paid to local custody, never the account key. It changes no staging
resource and sends no public-chain transaction.

The proof resets only its local Anvil endpoint before deploying. Do not point
port 18545 at a shared or public RPC service. The local token deploys with
2,010,000 atomic units. The local proof transfers 1,000,000 to the fixture and
uses 10,000 for the ticket. The remaining supply stays with its random local
deployer.

## Live run shape

Use a new data-bearing branch of the staging PostgreSQL database, a new
Hyperdrive configuration for that branch, and distinct HTTP, jobs and Solid
Workers. Copying the branch preserves the participant's Privy account, persona,
song and previous activity data. Retire the copied public Megapot attestation
inside that branch only, then insert a new attestation ID for the deployed
fixture. Both isolated Workers must name the new ID and their own Hyperdrive.
The active public attestation and both shared staging Workers stay unchanged.

The isolated Solid origin needs its own same-origin `/api` proxy to the isolated
HTTP Worker. Confirm that the existing staging Privy app accepts that exact
origin before asking the owner to sign in. Very Web's bridge result and the
host-only session must return to the same isolated origin. An unverified owner
account, a broken return, or a mismatched cookie stops the run before funding.

Give the fixture a new operator account, the jobs Worker a separate custody
account, and gas top-ups a third account. Do not reuse the shared staging gas
or custody keys. The live fixture uses the existing Base Sepolia USDC, with
exactly 1,000,000 atomic units placed in the jackpot and at most 1,000,000
atomic units placed in one sponsor Boost. The contract accepts one ticket and
fixes a 1,000,000-atomic tier-1 payout before purchases open. The operator
cannot alter that payout while a drawing is open. The sponsor offer ends after
the target cutoff and before a second eligible drawing. Reconcile its residual
refund separately from the participant's prize.

The release package must cap Base Sepolia ETH for deployment, custody and gas,
and set a branch and Worker lifetime with a cleanup deadline. It must first
show a dry-run diff for every Worker binding, secret name, route, queue, R2
bucket and database target. The jobs copy must not consume shared staging
queues or run unrelated scheduled jobs. Read back the copied database's
obligations and the owner's fresh Very subject count before any fixture
attestation or funds. The account that held the no-win share had zero active
Very subjects and zero fresh claim evidence at a read-only check on
2026-09-26; that is only a point-in-time result.

After deployment, use the app to fund one offer. The owner performs Study and
Karaoke; normal jobs freeze the share, buy the one ticket, sweep the tier-1
receipt, claim from the fixture into custody, allocate and hold the credit.
The owner then completes the actual Very claim in Solid. Require an on-chain
USDC payout into the credit's recorded wallet, a bounded gas top-up when
needed, and one confirmed onward send. Replay claim, gas and send requests and
prove no second transfer. Record block hashes, receipts, database transitions,
Worker versions, bindings and final balances without storing secrets or palm
evidence. Close every obligation before removing the isolated stack.

The live isolated stack, provider returns, Base Sepolia deployment and funding
are still pending. Bootstrap must attest the deployed jackpot, ticket NFT and
USDC code hashes and their linked addresses. A local RPC proof is a
compatibility check, not the final owner claim or wallet receipt.
