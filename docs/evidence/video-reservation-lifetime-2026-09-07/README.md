# Video reservation lifetime and cleanup

Implementation checkpoint 6261c98dcf5873a74801950f196c6cef08232c4c is based on fetched origin/main b1d13e1cd637b355d56bc2a0aacf33faa744606c. The workspace_owner ratified the policy; control-plane amendment 860faef dispatches it. A final origin fetch still matched the base, so no rebase was needed.

New reservations receive min(21600, 3600 + ceil(declared_bytes / 32768)) seconds, fixed before upload creation. A 500 MiB take receives 19,600 seconds. One-hour part URLs remain independently renewable and capped by the remaining reservation life. Existing deadlines and replay snapshots are not rewritten. Claim, renewal and finalize expiry use the existing typed action_expired conflict. A manifest accepted before expiry retains finalize replay authority.

The jobs sweep selects at most ten expired issued/claimed video reservations per tick using the existing expiry index. Each row is locked with SKIP LOCKED and revalidated without a manifest, completion or prior abort. Abort is bounded to five seconds; storage confirmation and terminal expiry are committed together. Failure rolls back, allowing a later sweep to replay the abort. A late R2 completion after timeout remains safe because the finalize transaction rejects expired manifest-less uploads. The sweep logs counts only. It runs when media maintenance is active and the ingress binding exists, including with analysis disabled; enabled analysis requires that binding. All video enablement flags remain unchanged.

The S3-format fragment ingress-lifecycle-rule.json specifies a three-day incomplete-multipart rule scoped to reservations/. At the recorded deployment, inspect and preserve existing bucket rules, merge this fragment into the collection, verify the resulting configuration, and retain its receipt in the staging proof. Do not add completed-object deletion. Storage reclamation remains eventual during outages, not guaranteed exactly at reservation expiry. References: [R2 lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/) and [native multipart API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).

| Verification | Result |
| --- | --- |
| Focused application lifetime/publication | 10 passed, exit 0 |
| Focused PostgreSQL renewal | 1 passed, exit 0; formula, independent URLs, replay and expiry fences |
| Final focused PostgreSQL cleanup | 21 assertions passed, exit 0; uncertain abort, transaction failure, lock exclusion, manifest exclusion and claimed expiry |
| Native R2 abort replay in Workerd | 1 passed, exit 0 |
| Full ordinary command, test-final.log.gz | Exit 0; 3,283 unit, 20 Node and 176 Workerd tests |
| Full static command, check-formatted.log.gz | Exit 0; Effect, lint, types, bindings, dependency graph, migrations and client freshness |
| PostgreSQL standard command, postgres-all.log.gz | Exit 1 after general runner hit its 900-second limit and child exited 143; no assertion failure reported |
| PostgreSQL continuation, postgres-continuation.log.gz | Exit 0; 59 tests across all five remaining/interrupted suites |
| Script check and whitespace | Exit 0; no script finding, one existing size advisory |

The PostgreSQL inventory records all 67 tracked suites, the fully completed set and the interrupted suite rerun in full. The two runs together complete suite coverage; this is not a claim that the standard command passed. Its first run also passed all 30 composed video/delivery Workerd cases. The local harness was a single disposable postgres:17 container with host networking on port 5547. Gates ran serially at low CPU and I/O priority. Frozen installation passed.

Failure history is retained. The expanded cleanup fixture first failed teardown because its injected trigger/function/sequence were not removed; cleanup now runs in finally. An attempted typecheck script was absent; the actual tsc command passed. test.log.gz records a Workerd import-alias failure, fixed by the repository's relative-import convention. test-second.log.gz records a manifest assertion run before the new PostgreSQL file was staged; the assertion and the full subsequent run passed. check-final.log.gz records import formatting after that harness fix; formatting and the complete subsequent gate passed. Existing lint/config and simulated-stream warnings remain in the logs.

No migration, client cut, deployment, provider job, secret mutation, lifecycle mutation or flag activation occurred. The rule is prepared, not installed. This is local regression evidence, not real-device or hosted-provider acceptance. Required PR checks and the merge receipt are recorded in the execution task.

Logs are stored losslessly compressed to retain exact tool output, including its whitespace, without a large text diff. Hashes cover the compressed artifacts.
