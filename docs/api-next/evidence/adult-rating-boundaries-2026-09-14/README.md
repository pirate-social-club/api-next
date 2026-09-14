# Adult rating successor and guarded-read checkpoint

This local checkpoint follows API 7198c19fe890b36c12307a268cf06a656ffbb276. It does not complete adult viewing or authorize enablement. Source hashes and retained transcripts describe exactly the implemented boundary.

New accepted text, song and video moderation evidence binds accepted-adult-signals-v2. Accepted sexual or graphic-violence signals retain an adult floor under permit, review or block; permitted publication stays permitted and stronger platform blocks remain. Historical v1 resolver results and retained replay remain unchanged. Migration 0182 adds the text evidence rule identity and a successor song snapshot validator admitting the explicit tag without rewriting old snapshots. Feed, detail, slug and media-reference reads no longer bypass the rating guard based on content type or a null rating.

The administrative migration runner now preserves the failing migration label, SQLSTATE and a bounded driver message. It does not add driver detail, SQL, query parameters or credentials to runtime errors. Its PostgreSQL regression reproduces cannot use subquery in check constraint and verifies the transaction rolls back the invalid table and migration ledger.

## Verification

The retained adult-rating-runtime-pg-check-2 transcript proves 32 PostgreSQL cases across text submission, content, feed and public slugs, plus four fresh completion sentinels. The scratch wrapper returned one during cleanup after those tests, so the chained full check never ran in that command. The task container was gone on inspection. Later wrappers wait for asynchronous Docker removal; the diagnostic and media wrappers completed normally and cleaned their own resources.

The adult-rating-final-validation command passed 18 focused tests, four PostgreSQL migration-runner tests with a fresh sentinel, full check, 4,153 unit tests, 20 Node tests and the first workerd configuration (82 tests). The command then exited 143 at the HTTP configuration. The journal confirms a scope OOM kill in run-r0515f9824f3c46f99ee38d48df1680aa.scope at 3 GiB. This is not a successful full bun run test command.

Storage review then found that the old song snapshot validator's exact key set rejected the new rating-rule field. The successor validator corrected that issue. The subsequent adult-media-storage-validation command regenerated the baseline, passed four targeted PostgreSQL cases (one tagged song persistence case and all three video safety persistence/replay cases; 48 media cases intentionally filtered), and passed full check over 178 migrations with api-client 0.77.0 verification. Existing historical snapshot fixtures still have their original shape. The final baseline adds the new validator and rebinds its insert trigger; it does not rewrite old evidence or reset data.

The HTTP workerd configuration now serializes files and limits workers to one, matching the existing scheduled-worker configuration. The retained adult-workerd-remaining-serial transcript exited zero for HTTP (74), Self (2), HNS verifier (10) and video-source (15). Each remaining configuration ran serially under a 4 GiB, one CPU, no-swap scope with a 2 GiB Node heap. Combined with the first configuration's 82, all 183 workerd tests have component evidence. The final config edit had a passing formatter check and runtime execution. Expected rejection/cancellation diagnostics remain visible in the transcript.

The full unit run initially caught a stale CI shard upload condition after database test counts changed. Recomputing ownership moved the song-video render-host marker to shard zero; the other marker remains on shard three. The passing full unit run includes the shard consistency assertion. Earlier iterations also caught an optional-property test typing error and an untracked migration admission check, both corrected before the passing check. None of those failed attempts is called green.

## Remaining work

Forward reconciliation of retained adult signals and missing evidence, renewable account age ceremonies, contextual age UI, versioned song metadata and the complete delivery-surface audit remain open. The focused PostgreSQL proofs are not the full required partitions. Real Self/ZKPassport document acceptance, trusted pull-request checks and staging rollout are still required. Nationality's owner-selected one-year reuse remains separate from age evidence. Public IPFS audio remains public. Nothing was pushed, deployed or enabled.

SHA256SUMS binds retained files. source-manifest.json binds the changed source files in this checkpoint. Logs have terminal escapes and trailing whitespace removed and the local worktree path normalized; failed-command boundaries are retained.
