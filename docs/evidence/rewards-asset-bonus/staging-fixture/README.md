# Staging asset-bonus ERC-20 fixture

This directory owns the source and reproducible compiler profile for the
staging-only asset-bonus fixture. It is not a production token or a general
token-deployment package.

`FixedSupplyBonusToken` has six decimals, symbol `PSTB`, and a compile-time
fixed supply of `1_000_000_000_000` atomic units. Its constructor mints that
supply to a supplied holder. It has no owner, proxy, upgrade,
post-construction mint, burn, pause, fee, rebasing, blocklist, external hook, or
recovery operation. The intended staging deployment mints
the complete supply to the established rewards sponsor wallet.

Build and test from this directory with the pinned Foundry profile:

```sh
forge test
forge inspect FixedSupplyBonusToken bytecode
forge inspect FixedSupplyBonusToken deployedBytecode
```

The pinned compiler resolves to Solidity `0.8.30+commit.73712a01`. With the
committed optimizer and metadata settings, the creation bytecode is 1,495 bytes
with Keccak-256
`0xdf46a17c0556b334052b9e573f8888d66b1abb1856f3c581d3f2b43414f547df`.
The runtime bytecode is 1,271 bytes, has no immutable references, and has
Keccak-256
`0x8b77283b5a60e039997afad77be7276230d56781178ff513dbab9af7dc74468e`.

Deployment is not admission. Before inserting `reward_asset_whitelist`, record
the confirmed deployment transaction, chain id, block number and hash, token
address, runtime code hash, empty EIP-1967 implementation/admin/beacon slots,
on-chain metadata reads, total supply and sponsor balance, and exact transfer
balance deltas. Set `plain_erc20_verified_at` to the observation time and
`activated_at` no earlier than that time. The policy version identifies the
procedure; it does not replace the evidence.
