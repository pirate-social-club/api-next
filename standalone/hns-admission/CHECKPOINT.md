# First source checkpoint

The isolated pre-submission core is implemented as an independently locked package. It contains the resource codec/preflight, service-only consent and challenge encodings, normalized observer validation, an Alchemy Domain aggregate, the Cloudflare hosting Layer and an Effect HTTP handler. It stops at waiting/submission_not_enabled.

The qualified package gates are TypeScript, formatting, 13 focused tests and three HSD checks. The HSD checks prove the 159-byte increase in an accepted resource, acceptance at 512 bytes/refusal at 513 without broadcast, actual two-node partition disagreement, and fixed mainnet entry/root selection executed against the HSD method. The first two checks run real regtest nodes; the third uses fixed data, not mainnet PoW. HSD oracle identity is recorded in PROVENANCE.md.

This is not a completed operational service. The production HSD RPC-to-evidence adapter, real request-access Layer, unattended observation scheduling and host Worker/Alchemy deployment entrypoint still need implementation and qualification. The HTTP and model tests provide these dependencies explicitly in test composition. The normalizer requires a genuine ownership epoch and canonical inclusion; callers cannot substitute an outpoint or hosting address as authority.

The current publication planner deliberately refuses existing pd1/pc1 records. Coexistence/replacement planning and active _evm routing preflight remain to be joined before real publication instructions are used. The consent verifier currently qualifies EOA signatures only. Neither a supported contract-wallet verifier nor an installation-proof producer is claimed.

Parent application checks and independent source review are unrun. Deployed Cloudflare alarm/eviction behavior, public MegaETH gas/nonce/recovery and the scoped psc1 test ceremony are also unrun. Submission, transaction reconciliation, wrapper/admin changes and signer recovery remain outside this checkpoint. No existing lane's files, provider configuration, live wallet or public-chain records changed.
