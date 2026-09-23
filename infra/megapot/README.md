The Base mainnet file is a protocol-core deployment candidate, not an active
Megapot deployment attestation. Its Jackpot, ticket NFT and USDC addresses
were cross-checked against Megapot's maintained starter-kit contract map at
`https://github.com/coordinationlabs/megapot-starter-kit/blob/main/src/config/contracts.ts`.
The code hashes were observed through Base's public RPC on 2026-09-23. The
read-only preflight in `scripts/megapot-base-mainnet-preflight.ts` rechecks
those hashes and the Jackpot's linked NFT and USDC addresses at one block
through two distinct RPC origins. It sends no transaction.

The candidate intentionally contains no custody address, referrer, signing
key, source tag or attestation id. In particular, an upgradeable proxy's
runtime bytecode hash does not prove its implementation has not changed.
Implementation identity, the production signer backend, custody controls,
numeric caps and the actual claim-to-wallet-payout path remain separate
launch gates. This file must not be used as an activation instruction.

Run the read-only check from the api-next repository with
`MEGAPOT_MAINNET_RPC_URL_A` and `MEGAPOT_MAINNET_RPC_URL_B` set to HTTPS URLs
on distinct origins, then invoke `bun run db:preflight:megapot-base-mainnet`.
The command reports only block and contract-hash evidence, never the URLs.
