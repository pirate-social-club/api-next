# Source provenance

resource-codec.ts is independently owned here, copied from api-next commit a5c63b8db01d4359344d33c31d294a00fbeadb20, packages/application/src/namespace-ownership/hns-resource-codec.ts. Its record type import is replaced with a package-local structural type, its error constructor uses ordinary property assignment for Node's strip-only TypeScript runtime, and formatting follows this package's pinned formatter. There is no source, build or auth link to that application.

The codec implements the HSD wire grammar; HSD commit 698e252ebc7b5c1dd0a9587e342fdd153d020ae4 is the protocol review reference. The actual local oracle is HSD 8.0.0 in immutable image sha256:7a9aca3e77d828f23bf78a76daefcf2d9c718b2215a5ff083e10b998917ecc1f. That image is not claimed to have been built from the reference commit. Its resource encoder and an accepted transaction were compared with this package's bytes.

The namespace identity calculation in protocol.ts independently follows SharedNameKeys.sol at pirate-registry commit 56d63ad2738e0e6816b6157dba7174198700f2fa: keccak256 of ABI-encoded namespace domain and canonical TLD hash. The mainnet safe-entry vectors follow the separately pinned HSD getSafeRoot method. Neither introduces a runtime repository link.
