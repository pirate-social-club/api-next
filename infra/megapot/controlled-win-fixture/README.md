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

The isolated HTTP, jobs and Solid Workers are deployed with rewards off. The
isolated Privy origin accepts fixture sign-in. The fixture jackpot and ticket
NFT are deployed on Base Sepolia, the copied database attests them, and the
jackpot holds exactly 1 test USDC for the first drawing. The owner activity,
Very return, jobs settlement, wallet payout and onward send remain unproved.
A local RPC proof is a compatibility check, not the final owner claim or
wallet receipt.

The live deployment script is dry-run by default. It checks the Base Sepolia
chain, canonical test USDC bytecode, the isolated operator key and nonce, the
predicted contract address, and the gas quote. It refuses an estimate over
2,000,000 gas or a maximum fee over 0.0001 ETH. Execution additionally needs
`--execute`, the exact predicted address in
`E2E_APPROVED_DEPLOYMENT_ADDRESS`, and at least 0.0015 ETH in the operator
wallet. It waits for three confirmations and writes a public deployment record
at `/tmp/megapot-e2e-config-20260926/deployment.json`; copy that record to
the dated evidence package after execution. The operator key and RPC URL are
injected from the staging Infisical service and operator paths, never printed.

After deployment, `attest:megapot-controlled-win:isolated` checks the actual
contract receipt, linked contract addresses, code hashes, isolated custody
key, and copied database. It refuses an open credit, offer, leg, ticket, chain
effect or refund. Its default mode rolls back its read-only transaction. With
`--execute`, it retires only the copied public attestation and inserts
`megapot-e2e-sepolia-20260926-r1` in one serializable transaction. The shared
staging database is outside this script's branch-pinned connection.

`fund:megapot-controlled-win:prize` is dry-run by default. It consumes the
record of exactly 1 test USDC sent from the fixture sponsor wallet to the
operator and refuses unless the operator holds that amount, the jackpot holds
zero, and the operator has no pending transaction. With `--execute`, it sends
exactly 1,000,000 atomic Base Sepolia USDC into the approved jackpot, with a
0.0001 ETH gas hard cap. It verifies the Transfer log and both final balances
after three confirmations. A second run refuses because the balances and
one-use record no longer match.

`prepare:megapot-controlled-win:activation` checks the isolated database
attestation and absence of an open offer, the fixture's exact 1 USDC prize,
at least 0.002 ETH for custody, and at least 0.005 ETH for the gas wallet.
It then writes local HTTP and jobs config copies that change only
`MEGAPOT_REWARDS_ENABLED` to true. It does not upload or deploy a Worker. Its
2026-09-27 00:29 Tbilisi run correctly refused while custody still held zero
ETH. The rewards-off Worker versions remain the rollback targets.

`route:megapot-controlled-win:custody-float` is dry-run by default. With the
owner's approval for exactly 0.007 Base Sepolia ETH, it checked that the
isolated custody wallet was empty, the operator's next nonce was 2, the gas
quote was below 0.00001 ETH, and at least 0.005 ETH would remain with the
operator. Execution additionally required `--execute` and
`E2E_APPROVED_CUSTODY_FLOAT_WEI=7000000000000000`. Transaction
`0x53e06ab573f3da543fb6db26e9f662ad35e9b1a0915faf6919bd70c5553dfe65`
sent the exact amount to custody in block 47357582. A public Base Sepolia
node returned a successful receipt and the normal block hash. The configured
RPC initially reported a zero block hash, so the public receipt is the
canonical evidence. The isolated custody and gas wallets each held 0.007 ETH
afterward; the operator retained about 0.00699 ETH. The activation preflight
then passed and produced local HTTP and jobs config copies. Both Worker
builds passed `wrangler versions upload --dry-run`; nothing was activated by
those dry runs.

`arm:megapot-controlled-win:drawing` accepts an explicit Unix drawing time.
Its dry run verifies the funded prize, drawing ID 1, empty ticket inventory,
no operator pending nonce, and a time 10 minutes to four hours ahead. It
refuses a gas estimate over 300,000 gas or a maximum cost over 0.0001 ETH.
Execution requires `--execute` and the identical time in
`E2E_APPROVED_DRAWING_TIME_UNIX`. It waits for three confirmations and checks
the fixed tier-1 payout before recording the drawing. A one-hour sample dry
run estimated 216,771 gas; nothing was armed by that dry run.

The 2026-09-27 offer was activated after drawing 1 had already been armed, so
its leg starts at drawing 2. Drawing 1 cannot admit the owner's qualification.
After its due time, `settle:megapot-controlled-win:drawing` with
`E2E_DRAWING_ID=1` checks that it has no ticket, releases its reserved prize,
and records the receipt. `arm:megapot-controlled-win:drawing-2` then checks
that empty settlement and reuses the same 1 USDC already in the jackpot. It
requires an exact owner-approved Unix time in both `E2E_DRAWING_TIME_UNIX`
and `E2E_APPROVED_DRAWING_TIME_UNIX`. No second USDC seed or Boost transfer is
needed. The owner approved drawing 2 for 2026-09-27 06:05 UTC. Once a single
custody-owned ticket is bought, the settle command with `E2E_DRAWING_ID=2`
refuses before the drawing time and then checks the tier-1 winning result.
Each command is dry-run by default, and `--execute` sends one operator
transaction with a 0.0001 ETH maximum fee. A fresh run needs a fresh schedule,
funding, and exact approval; these one-use record paths prevent accidental
replay of this run.
