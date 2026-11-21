# Source provenance

resource-codec.ts is independently owned here, copied from api-next commit a5c63b8db01d4359344d33c31d294a00fbeadb20, packages/application/src/namespace-ownership/hns-resource-codec.ts. Its record type import is replaced with a package-local structural type, its error constructor uses ordinary property assignment for Node's strip-only TypeScript runtime, and formatting follows this package's pinned formatter. There is no source, build or auth link to that application.

The codec implements the HSD wire grammar; HSD commit 698e252ebc7b5c1dd0a9587e342fdd153d020ae4 is the protocol review reference. The actual local oracle is HSD 8.0.0 in immutable image sha256:7a9aca3e77d828f23bf78a76daefcf2d9c718b2215a5ff083e10b998917ecc1f. That image is not claimed to have been built from the reference commit. Its resource encoder and an accepted transaction were compared with this package's bytes.

The namespace identity calculation in protocol.ts independently follows SharedNameKeys.sol at pirate-registry commit 56d63ad2738e0e6816b6157dba7174198700f2fa: keccak256 of ABI-encoded namespace domain and canonical TLD hash. The mainnet safe-entry vectors follow the separately pinned HSD getSafeRoot method. Neither introduces a runtime repository link.

The active _evm grammar in records.ts independently follows packages/resolver/src/delegation.ts at pirate-registry 56d63ad2738e0e6816b6157dba7174198700f2fa, fetched as blob 0c0f9ad9c411f6288f287cbfa310c29d49889f1a. No resolver application or authentication code is imported. pd1 interpretation and conflict handling are independently owned here.

The HSD RPC schemas and covenant-history reader were implemented against the actual HSD 8.0.0 JSON and separately inspected protocol behavior. REGISTER/FINALIZE epoch anchors, canonical history inclusion and current/safe separation are new independently owned logic. The older observer informed the audit requirement for bracketing, but its runtime/auth interfaces were not copied. The real-node tests qualify this adapter rather than substituting a normalized fixture for its chain evidence.

Alchemy/Cloudflare/Domain 2.0.0-beta.87 and Effect 4.1.4 installed source is the hosting/API reference. Test qualification uses Alchemy's own Cloudflare bundler. It does not introduce a native durable implementation, alternate deployer or production fake. The HSD Docker bridge, synthetic mainnet entries and generated ephemeral EOA keys are test-only.
