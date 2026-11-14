# HNS admission core

This standalone Alchemy and Effect service implements the pre-submission ceremony through ReadyToSubmit. That state is reported as waiting/submission_not_enabled. It is not an admission, receipt or installed namespace proof. The deployable has no transaction signer or submission fake.

The package owns its exact dependency pins and lockfile outside the parent packages/* and apps/* workspace globs. Run npm ci, npm run check, npm test, npm run test:regtest and npm run check:bundle here. Do not install from the parent application or change its Effect pin. The Node platform peer is independently pinned for the project-local Alchemy CLI.

src/aggregate.ts owns durable state and revision fences. src/model.ts composes the operational policies; src/automation.ts schedules observation and deadline checks through Alchemy Domain. src/cloudflare.ts selects Alchemy's Durable Objects adapter, src/worker.ts hosts the Effect HTTP handler, and alchemy.run.ts declares the standalone Cloudflare stack and Alchemy-managed state. No native DO implementation or alternate deployment tool is introduced.

src/hsd-rpc.ts permits five read-only methods. src/hsd-snapshot.ts brackets current and safe name observations with canonical chain anchors and follows covenant history to a REGISTER or FINALIZE ownership epoch. Routine UPDATE/RENEW outpoint changes retain that epoch. Both independent observers must agree. An unavailable history index, stale view or disagreement suspends the decision; it never establishes invalid authority.

Request access uses EOA signatures bound to the complete installation binding, method, path, exact UTF8 body digest, nonce and a five-minute expiry. Initial creation requires the controller. Later requests may also use its bound installation-request key. Ceremony consent separately requires the controller and binds the full planned resource digest. There is no separate operator account. Exact preimages and literal fixtures are in PROTOCOL.md and test/vectors/ceremony-v1.json.

The resource planner preserves NS, glue, DS and unrelated TXT, adds missing _evm routing, and enforces the complete 512-byte resource limit. pd1 supplements _evm and pins the controller/community. Different chains' pd1 records may coexist; only one _evm route is active. Existing freshness challenges are never silently replaced. EOA signatures are supported; contract-wallet verification is deferred.

The local acceptance path creates a real ceremony, verifies controller consent, publishes its resource on isolated HSD regtest, independently observes two nodes, and reaches ReadyToSubmit. A subsequent real partition returns Unavailable. Local progression replaces long block waits; separate fixed vectors execute HSD's mainnet safe-root method with interval 36. CHECKPOINT.md distinguishes those historical checks from unrun integration and deployed-platform gates. REVIEW-FIXES.md records the corrective successor after independent review and its pending current-source gates.

The pilot permits one admitted installation per namespace. Admission and installation binding are later effects enforced by the reviewed wrapper and consumer. This core does not claim that an in-progress ceremony reserves an admitted installation.

See OPERATIONS.md for configuration and remaining deployment gates. No live wallet, HNS resource or provider changed during this implementation.
