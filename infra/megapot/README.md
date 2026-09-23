The Base mainnet file is a protocol-core deployment candidate, not an active
Megapot deployment attestation. Its Jackpot, ticket NFT and USDC addresses
were cross-checked against Megapot's maintained starter-kit contract map at
`https://github.com/coordinationlabs/megapot-starter-kit/blob/main/src/config/contracts.ts`.
The code hashes were observed through Base's public RPC on 2026-09-23. The
read-only preflight in `scripts/megapot-base-mainnet-preflight.ts` rechecks
those hashes, the Jackpot's linked NFT and USDC addresses, and Circle USDC's
ZeppelinOS implementation slot and implementation code hash at one block
through two distinct RPC origins. Circle's slot definition is in
`https://github.com/circlefin/stablecoin-evm/blob/master/contracts/upgradeability/UpgradeabilityProxy.sol`.
The preflight sends no transaction.

The candidate intentionally contains no custody address, referrer, signing
key, source tag or attestation id. The observed USDC implementation identity
can change after this snapshot; it must be rechecked before any money movement.
The production signer backend, custody controls,
numeric caps and the actual claim-to-wallet-payout path remain separate
launch gates. This file must not be used as an activation instruction.

Run the read-only check from the api-next repository with
`MEGAPOT_MAINNET_RPC_URL_A` and `MEGAPOT_MAINNET_RPC_URL_B` set to HTTPS URLs
on distinct origins, then invoke `bun run db:preflight:megapot-base-mainnet`.
The command reports only block and contract-hash evidence, never the URLs.

The first write-path conformance test uses a disposable local Anvil fork at
Base block 51684323. It checks the pinned block hash and production contract
attestation, moves USDC only inside the fork from an impersonated holder to an
Anvil account, executes Circle USDC's real approval method, validates the real
receipt with the runtime codec, reads the resulting Jackpot allowance, buys
one ticket through the real Jackpot, validates the purchase and NFT mint logs,
and checks ticket ownership and the exact USDC debit.
The test refuses any RPC URL except uncredentialed `http://127.0.0.1` and
requires Anvil's fork metadata before sending a transaction. It is not a
production approval-coordinator test, custody decision, or activation proof.
It is skipped by ordinary CI when `MEGAPOT_BASE_FORK_RPC_URL` is absent.

From api-next, start a fresh fork, run the test, then stop the disposable
container. The image digest pins Foundry 1.8.3. The public fork source must
continue to serve historical state for that block; a provider failure is not
a contract failure.

```sh
docker run -d --rm --name api-next-megapot-base-fork --network host ghcr.io/foundry-rs/foundry@sha256:2e4287278639262de76db72477301d5d3212fa1b1cce710d7d148750a46ce9e7 'anvil --fork-url https://mainnet.base.org --fork-block-number 51684323 --chain-id 8453 --host 127.0.0.1 --port 8547 --silent'
MEGAPOT_BASE_FORK_RPC_URL=http://127.0.0.1:8547 bun test --timeout 60000 packages/platform-cf/src/megapot-mainnet-contract-flow.fork.test.ts
docker stop api-next-megapot-base-fork
```
