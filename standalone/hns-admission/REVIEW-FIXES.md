# Authority availability review correction

This page records the earlier f96396b4-to-3cba0689 review. The subsequent cloud HOLD at 7db3bd7c and its current corrective boundary are in [CLOUD-REVIEW-FIXES.md](CLOUD-REVIEW-FIXES.md). The earlier CLEAR below does not cover that new delta.

The independent review of source f96396b4 returned HOLD for three P2 findings. This successor changes only authority evidence ordering, timestamp agreement, and HTTP progress retention. The prior source and private proposal images remain preserved. Submission stays disabled at ReadyToSubmit.

Current and safe ownership epochs must agree before a changed owner can produce terminal rejection. A provisional FINALIZE remains unavailable; a rollback can restore the original ceremony. The production observer now checks tip freshness before classifying an inactive name, so matching stale nodes cannot revoke current control. Both the production pair and normalizer compare tipTime and inclusionTime instead of choosing one node's contradictory timestamps.

An additional status failure is repaired: a read of publication instructions can fail after the durable operation or consent transition already exists. Its unavailable response now retains operation identity, revision, phase and deadlines. Authentication failures without an authorized operation still return the existing limited error response.

The first six new regression cases ran against the old source: five failed and the fresh stable absence control passed. After the correction, all six passed, together with package TypeScript and formatting. The actual HSD transfer fixture then passed in 35 seconds: provisional FINALIZE was unavailable, invalidateblock restored the original pending-transfer authority, and rematuring the new owner produced ownership_changed. That fixture uses two transport identities over one real node; the separate partition fixture supplies two actual nodes.

A seventh case verifies a real EOA controller consent whose HTTP response becomes unavailable after its transition commits. At source 3cba0689dda7cb36476f451424f71ecfd408b364, package TypeScript/formatting and all 29 focused cases pass. All four HSD qualification cases also pass, followed by offline compilation through the installed Alchemy Cloudflare bundler. [The checkpoint](CHECKPOINT.md) and [sanitized evidence](review-evidence/2026-11-14/checks.json) distinguish those current checks from unrun parent and deployed-platform acceptance.

The changed decision logic does not alter protocol encodings, signatures, leases, freshness limits, renewal horizons, issuance caps, key roles, transaction ABI or disabled capabilities. Existing ownership and receipts remain outside this read-only service's effects.

Independent source delta review returned CLEAR for exact f96396b4cf15f3b09b7c61700ff5906598135ab0 through 3cba0689dda7cb36476f451424f71ecfd408b364. The reviewer matched patch SHA256 c068ef50d33f44df66915b5b74d4d0d5a5afe18ca7ed89b77dade814a2d428c6 to Git, closed all three P2 findings and found no new P1/P2 in HTTP progress retention. The reviewer executed no gates. This is a sanitized summary of that separate source review, not an assertion that the reviewer reran tests or accepted the whole journey.

The package gate sequence is npm run check, npm test, npm run test:regtest and npm run check:bundle from this directory. These are standalone gates, not the parent repository's check/test allocation. The following published documentation checkpoint preserves the tested executable source and dependency graph. Passing source checks do not authorize deployment, submission or a contract mutation.
