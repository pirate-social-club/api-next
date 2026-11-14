# Authority availability review correction

The independent review of source f96396b4 returned HOLD for three P2 findings. This successor changes only authority evidence ordering, timestamp agreement, and HTTP progress retention. The prior source and private proposal images remain preserved. Submission stays disabled at ReadyToSubmit.

Current and safe ownership epochs must agree before a changed owner can produce terminal rejection. A provisional FINALIZE remains unavailable; a rollback can restore the original ceremony. The production observer now checks tip freshness before classifying an inactive name, so matching stale nodes cannot revoke current control. Both the production pair and normalizer compare tipTime and inclusionTime instead of choosing one node's contradictory timestamps.

An additional status failure is repaired: a read of publication instructions can fail after the durable operation or consent transition already exists. Its unavailable response now retains operation identity, revision, phase and deadlines. Authentication failures without an authorized operation still return the existing limited error response.

The first six new regression cases ran against the old source: five failed and the fresh stable absence control passed. After the correction, all six passed, together with package TypeScript and formatting. The actual HSD transfer fixture then passed in 35 seconds: provisional FINALIZE was unavailable, invalidateblock restored the original pending-transfer authority, and rematuring the new owner produced ownership_changed. That fixture uses two transport identities over one real node; the separate partition fixture supplies two actual nodes.

A seventh prepared case verifies a real EOA controller consent whose HTTP response becomes unavailable after its transition commits. It and the complete 29-case package suite remain unrun at this source-only checkpoint. The other HSD cases and current offline Worker compilation also await the shared runtime allocation. Do not promote earlier whole-suite results to qualification of this successor. Parent CI and deployed Cloudflare acceptance remain separate.

The changed decision logic does not alter protocol encodings, signatures, leases, freshness limits, renewal horizons, issuance caps, key roles, transaction ABI or disabled capabilities. Existing ownership and receipts remain outside this read-only service's effects.

Once the shared run releases custody, the bounded package gate sequence is npm run check, npm test, npm run test:regtest and npm run check:bundle from this directory. Existing pinned dependencies are already installed; no install or dependency upgrade is needed. These are standalone gates, not the parent repository's check/test allocation. Fresh independent delta review is still required before intake or deployment.
