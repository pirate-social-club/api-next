# One-year nationality evidence decision and verification

On 2026-09-14 workspace_owner selected 365 days (31,536,000 seconds) of
nationality evidence reuse for joining and handle claims. It is measured
from accepted observation and expires at the exact boundary, with earlier
receipt/assertion expiry, revocation, and account/requirement/binding checks
retained. This does not set the separate adult-viewing age-evidence lifetime.
The explicit rollout value is
`NATIONALITY_AUTHORING_EVIDENCE_LIFETIME_SECONDS=31536000`; no runtime default,
feature enablement, provider call, push, or deployment was introduced.

The tested tree is base `8ec3996c` plus the three one-year test changes in this
checkpoint. No runtime implementation changed. The focused run passed 79 tests.
Its first run failed because the new claim fixture omitted evaluation policy
and requirement hashes; adding those server-owned identities made the test
exercise the intended expired-evidence rejection. The shared evaluator already
implements the required lifetime behavior, including leap-year 365-day
boundaries, earlier expiry and replay that never renews the observation.

The complete `bun run check` and `bun run test` commands both exited zero.
The latter ran unit, Node, and all five workerd configurations: 4,085 unit,
20 Node, and 183 workerd tests passed. These are actual complete command
results, superseding the earlier non-green unit run and incomplete workerd
accounting for this checkpoint. Workerd emitted expected rejection/cancellation
diagnostics during passing tests; they were not hidden or treated as failures.
This is not PostgreSQL-partition, real-document, browser, or staging acceptance.

Commands ran serially from the API lane using `systemd-run --user --scope`
with `MemoryMax=3G`, `CPUQuota=100%`, `GOMAXPROCS=1`, and
`GOMEMLIMIT=2300MiB`. Check had a 600-second timeout and test had 1,200 seconds.
The focused run used a 2 GiB ceiling and a 90-second timeout. The test scope
was confirmed inactive after completion. No database container was started.

`verification-summary.json` records each component count and the temporary
log digests. Raw logs are in `/tmp/nationality-delivery-2026-09-14/` and are
not durable retained evidence; a reboot can remove them. This committed
summary records observed command results without retaining raw document or
provider evidence. The complete product delivery remains unfinished.
