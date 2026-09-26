# Controlled Megapot winning fixture

This contract is only for isolated Base Sepolia acceptance. It is not a
Megapot production deployment and does not test the public contract's
randomness. Every ticket it sells pays tier 1 after the drawing closes. The
operator must fund the contract with enough test USDC and arm the drawing
before any ticket is bought. The outcome and payout amount cannot be changed
after arming. Each drawing accepts one ticket, and old unpaid winnings remain
reserved when the next drawing is armed.

The contract implements the Megapot V2 reads and writes used by api-next. Its
companion test USDC has six decimals, standard ERC-20 metadata, a fixed supply
of at most 10 atomic USDC, and no mint method. It
mints a separate ticket NFT, emits the purchase and order logs, burns the NFT
on claim, emits a zero-value referral log, and transfers the configured USDC
from the jackpot to the ticket owner's wallet. The constructor rejects every
chain except Base Sepolia, chain 84532. The operator can arm a drawing, and
anyone can settle it after its stated time. A draw with no ticket releases its
reserved prize when settled.

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

The live isolated stack still needs its own database, HTTP and jobs Workers,
Solid origin, provider return configuration, Base Sepolia contract deployment,
separate funded custody and gas wallets, and a reviewed, bounded funding
plan. Bootstrap must attest the deployed jackpot, ticket NFT and USDC code
hashes and their linked addresses. Shared staging's public attestation must
not be retired or rebound for this fixture. A local RPC proof is a
compatibility check, not the final owner claim or wallet receipt.
