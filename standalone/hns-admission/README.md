# HNS admission core

This is the first implementation checkpoint for the pre-submission slice, with independently locked Alchemy and Effect dependencies. Its core stops at ReadyToSubmit, reported as waiting/submission_not_enabled. The operational service still needs the integrations listed in CHECKPOINT.md. It never attests, submits a transaction or returns an installed namespace proof.

The package is outside the parent's packages/* and apps/* workspace globs. Install with npm ci here. Run npm run check, npm test and npm run test:regtest. Do not install from the parent application or change its Effect pin.

src/model.ts defines the Alchemy Domain aggregate. src/cloudflare.ts selects Alchemy's Cloudflare Durable Objects layer; no native DO implementation or separate deployment tool is introduced. HTTP requires explicit HttpAccess and HnsObserver services. Test implementations exist only under test/. Production access, RPC observation integration, automatic observation scheduling and a deployed staging Worker remain unfinished and must be qualified before deployment. The HTTP library is not a deployed service.

The real-node test uses an immutable local HSD8.0.0 Docker image ID, checks regtest genesis and creates uniquely named disposable containers. The first case publishes actual NS/DS/TXT records and compares the accepted transaction's bytes. The partition case uses an internal Docker network and two real nodes. It exercises disagreement using actual fork hashes and resource data; its other normalized observation metadata is test fixture data. It does not qualify a production HSD observer adapter or mainnet PoW.

The controller consent is service-only EIP712 under PirateNamespaceCeremony/version1, bound to chain and wrapper, ceremony ID, complete binding digest, whole resource digest, nonce, issue time and deadline. It is separate from future wrapper permits. Challenge bytes are standard ABI encoding of the domain hash, ceremony ID, binding digest, nonce, publication deadline and maturity duration, then SHA256. No JSON serialization forms a signature preimage.

The current EOA consent verifier is tested independently of wallet RPC. Contract-wallet verification requires a separately qualified adapter and is not silently treated as EOA ownership. The current resource planner refuses existing pd1/pc1 records rather than silently deleting a previous ceremony's proof. Replacement/maintenance planning remains explicit work.

Parent application gates, deployed Cloudflare alarm/eviction qualification, actual MegaETH sender recovery/gas measurements and the owner-operated psc1 ceremony are separate, currently unrun gates. No live wallet, HNS resource or provider changed through these tests.
