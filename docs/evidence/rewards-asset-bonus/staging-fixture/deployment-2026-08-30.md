# PSTB staging deployment and admission

This record covers the staging-only `Pirate Staging Bonus` ERC-20 fixture. It
does not authorize a production deployment or a mainnet asset admission.

The reviewed source and reproducible compiler profile merged through pull
request 177 as api-next commit
`0ae5422b31725ebe224a65b541ce4dda03c7b8f9`. The protected `check`,
`postgres17`, and `secret-boundary` jobs passed at head
`a97848439d0baf4aa43a1d95a4c4ea2ebcf9cad9`. A single-threaded rebuild from
the merged tree passed all four Foundry tests and reproduced creation-bytecode
Keccak-256
`0xdf46a17c0556b334052b9e573f8888d66b1abb1856f3c581d3f2b43414f547df`
and runtime-bytecode Keccak-256
`0x8b77283b5a60e039997afad77be7276230d56781178ff513dbab9af7dc74468e`.
The runtime has no immutable references.

The established rewards sponsor wallet deployed that exact creation bytecode
on Base Sepolia, chain id 84532, through the Infisical-injected Privy child
process. No credential value was printed or persisted. Deployment transaction
`0x638d01947f3b4fc2259b69c85d71a0d5d4128f791ce814a0d7bea2d3b29036cf`
has Privy transaction id `b924c80a-adfb-4a8a-881e-0e2a57787339` and succeeded
in block 46160230, hash
`0x1ee981c1d4bb44ddfe7affa0e153e15b216d214c021833418e8fd26781b6a8f0`.
The receipt used 355,869 gas, has the exact sponsor as sender, has no recipient,
and created token
`0xb2810211a9ad96d94f5efee5680ec6b6c538a6f2`.

Reads pinned to block 46160230 found 1,271 runtime bytes with the expected
runtime hash. The token returned name `Pirate Staging Bonus`, symbol `PSTB`,
decimals 6, total supply `1000000000000` atomic, and the complete supply in the
sponsor wallet. The EIP-1967 implementation, admin, and beacon slots were all
zero:

```text
implementation 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc
admin          0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103
beacon         0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50
```

The plain-transfer check moved one atomic unit from the sponsor to the standard
dead address, not to custody. Transaction
`0x6d5a296320b5439d0bf25819f3b04783137222e3a7cb0a518903a4cfc0da754c`
has Privy transaction id `545fdb95-dea2-4b73-a785-18b0696a86a2` and succeeded
in block 46160270, hash
`0x8b9a646b434321be8a372f9bd71bd6f535f3bce02d371b846b9ea56613e6a13e`,
at `2026-08-30T11:20:28.000Z`. At that block the sponsor balance changed from
`1000000000000` to `999999999999` and the dead-address balance changed from
zero to one. The exact conserved delta is the live plain-transfer evidence.

After those reads, the operator transaction admitted exactly one append-only
staging whitelist row:

```text
chain_id                 84532
token_address            0xb2810211a9ad96d94f5efee5680ec6b6c538a6f2
decimals                 6
symbol                   PSTB
asset_kind               bonus_asset
environment              staging
status                   active
policy_version           plain-erc20-fixed-supply-v1
plain_erc20_verified_at  2026-08-30T11:20:28.000Z
activated_at             2026-08-30T11:22:12.393Z
```

The verification timestamp is anchored to the final transfer-verification
block. The activation followed it. The pre-insert transaction locked the
whitelist and proved that no bonus asset or address collision existed. The
existing settlement-USDC row was not changed. Production schema, Workers, and
asset admissions were not changed.
