# Independent review entry point

Review standalone/hns-admission in this pull request. The qualified executable source is 3cba0689dda7cb36476f451424f71ecfd408b364. The following checkpoint adds documentation and sanitized evidence without changing that source or its dependency graph. Review the complete package and the corrective f96396b4-to-3cba0689 delta; a clear delta review does not replace reviewing the initial implementation.

This packet needs no access to the original machine, wallet, HNS providers or Cloudflare account. [CHECKPOINT.md](CHECKPOINT.md) and [recorded results](review-evidence/2026-11-14/checks.json) distinguish executed checks from unrun acceptance. Original machine-specific evidence remains private; these are derived summaries and selected raw test outputs.

## Scope and code paths

The ceremony ends at ReadyToSubmit, reported as waiting/submission_not_enabled. It cannot admit or refresh a namespace, sign or broadcast transactions, sponsor claims, reconcile receipts or install a Wizard proof. Hosting an SLD or reaching an RPC endpoint grants no sibling issuance authority.

Read [PROTOCOL.md](PROTOCOL.md) for exact bytes/signatures, [PROVENANCE.md](PROVENANCE.md) for independently owned reuse and pinned references, [OPERATIONS.md](OPERATIONS.md) for configuration, and [REVIEW-FIXES.md](REVIEW-FIXES.md) for independent findings and their correction.

src/ceremony.ts owns the pure transition function and seven phases. src/aggregate.ts owns durable commands/revisions/reservations; src/automation.ts schedules observations and deadlines. src/hsd-rpc.ts and src/hsd-snapshot.ts obtain bounded read-only chain snapshots and canonical ownership history. src/hsd-observer.ts compares the observers; src/observation.ts normalizes evidence. src/http.ts, src/access.ts and src/service.ts expose and authorize resumable operations. src/worker.ts, src/cloudflare.ts and alchemy.run.ts compose Effect services with Alchemy Domain and Cloudflare hosting.

The normal path is AwaitingConsent, AwaitingPublication, Maturing, ReadyToSubmit. Cancelled, Expired and Suspended are explicit phases. Unavailable evidence preserves progress and applicable deadlines. Timely publication learned late has a bounded publication-expiry recovery path; cancellation never revives. Missing TXT is publication_pending. Pending transfer, provisional ownership changes, reorgs, stale nodes and confirmed stable authority loss require separate decisions.

## Review priorities

Check that failures, stale matching observations and current/safe disagreement never establish invalid authority. Compare both observers' tips, roots, inclusion, timestamps, resources and ownership epochs. REGISTER/FINALIZE anchor an epoch; UPDATE/RENEW must not look like a transfer. ReadyToSubmit must not be reusable as a fresh admission or installed proof.

Check signature domains, complete installation binding, exact resource digest, consent renewal, replay/idempotency, concurrency and late-result fences. Bad authorization must not consume a valid ceremony. A failed instruction read after a committed transition must retain operation identity and progress for an authorized caller.

Check complete 512-byte resource preflight, NS/DS preservation, pd1/controller pinning, _evm precedence, multi-chain coexistence and typed conflicts. Inspect deadline/cancel exits, future block timestamps, delayed wakes and rescheduling during prolonged outages. Local clock tests do not qualify deployed alarms or crash recovery.

## Reproduction

Use Node 24 or newer and install only in this independently locked package. Do not install or upgrade the parent API or Wizard to review it.

```sh
cd standalone/hns-admission
npm ci
npm run check
npm test
npm run check:bundle
```

These commands need package-download access but no live HNS node, wallet, signing key or Cloudflare credentials. The bundle command compiles offline. Report an environment restriction as unrun rather than passing.

The real-node suite additionally requires Docker and the exact HSD image in test/regtest/fixture.ts:

```sh
npm run test:regtest
```

The pinned sha256:7a9aca3e77d828f23bf78a76daefcf2d9c718b2215a5ff083e10b998917ecc1f is a locally available image content ID, not a registry pull reference. This packet does not distribute its layers. A cloud runner without that image can review the fixtures and [retained output](review-evidence/2026-11-14/hsd-regtest.stdout.txt), but must report its own HSD rerun as unrun. Do not silently substitute an image and call it the same qualification.

## Contract and integration boundary

Namespace identity follows SharedNameKeys.sol at pirate-registry 56d63ad2738e0e6816b6157dba7174198700f2fa, with literal vectors here. The retained source/ABI comparison found the selected application's claim tuple aligned, but V3 admission and attestation remain admin-only. Service consent is not an accepted wrapper permit or V3 claim. Wrapper/certificate, sponsorship, member authorization, resolver pd1 enforcement and the Wizard namespaceProofCollector remain separate joins. Local selection identity, service binding digest and on-chain revisions are not interchangeable.

There is no minimum remaining HNS renewal horizon. Current valid control is sufficient; already expired names and the later contract attestation lease remain distinct. Staleness or revocation must affect new authorization without deleting existing ownership or receipts.

Return findings with file/line references and severity, name missing tests, and distinguish source review from independently executed checks. Keep submission and installed-proof effects disabled. Do not deploy, change providers/credentials, sign, publish HNS records or modify contracts. Parent CI, deployed Cloudflare recovery and live acceptance remain open even if source review is clear.
