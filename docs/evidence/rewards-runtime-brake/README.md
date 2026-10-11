# Claim deadline source verification

The capture verifies the Base Sepolia deployment and the parked Base mainnet
candidate. It does not approve a production attestation or perform a transaction.
The public audit checkout differs from the recovered deployed source. Exact
compilation inputs were recovered through Sourcify's v2 contract endpoint.

The verification independently compiled six contracts with the official
Solidity 0.8.28 binary, optimizer enabled with 200 runs, viaIR enabled and the
Cancun EVM target. Jackpot runtimes matched without immutable substitutions.
Each calculator and ticket NFT matched after filling its four immutable
Jackpot-address locations. Every resulting runtime then matched eth_getCode
from the public RPC at the pinned block in contract-verification.json. The
block hashes were read back. Both current drawings reference the checked
calculators. Historical drawing 1 payouts also remain readable at those heads.

Review of the matching source establishes no time-based deadline in
claimWinnings, the NFT's ownership and burn operations, or getTierPayout. The
calculator returns stored payouts by drawing ID and tier. Its storage code has
no timed deletion. The Jackpot keeps the calculator address in each drawing;
setPayoutCalculator changes the global calculator for future drawings. This
supports holding claims during a pause for the exact checked deployments.
Activation must repeat the identity and per-drawing calculator check for its
chosen attestation, including any retired obligations.

The separate historical-ticket probe did not produce a successful unclaimed
winner simulation. Sampled positive-payout tickets mostly returned 0xceea21b6
from ownerOf; some requests were rate limited. These failures are not evidence
of a claim deadline. No transaction was sent. Source verification provides the
deadline conclusion; no behavioural success is claimed.

## Reproduction

Fetch each metadataUrl recorded in the JSON. Retain stdJsonInput and the
fullyQualifiedName target. Add outputSelection for evm.deployedBytecode.object,
evm.deployedBytecode.immutableReferences, metadata and abi. Compile through
solc-static-linux --standard-json using the recorded official compiler version.
The binary SHA256, standard input SHA256 and target source SHA256 are recorded.
The input fingerprints cover the complete recovered dependency sources.

For each immutable reference, replace exactly its start/length range with the
recorded immutable value. Check that the value encodes the expected Jackpot
address. Compare the complete runtime with eth_getCode at blockNumber, then
compute its keccak256 and compare runtimeCodeHash. Check eth_getBlockByNumber
against blockHash before accepting the capture. Recover the Jackpot's current
and historical drawing states at that same block and compare their calculator
addresses and historical tier payouts to the record.

The evidence retains fingerprints and observations, not the third-party source
bundle or compiler binary. Reproduction obtains them from the recorded primary
URLs. No Worker-provider receipt observation or live brake rehearsal is claimed.
