# Multi-participant golden runner

This is staging-only operational test tooling. No Worker runtime, flag or
deployment is changed. Use only after the dated authorization package is
complete and explicitly approved. The original single-Study CLI remains intact.

The v2 input schema is `MultiGoldenInput` in
`scripts/megapot-golden-multi-input.ts`. It requires at least two eligible
accounts covering Study and Karaoke, plus a distinct unverified negative.
Every participant names a v2 preflight artifact and its own environment-variable
credential prefix. Artifacts are reviewed ceremony evidence, not authority to
seed receipts. Their exact wallet and Very witness are rechecked read-only
against staging before writes and each activity. Artifact freshness is ten
minutes maximum; arrange short runs and regenerate artifacts before starting,
not by editing their timestamps. A long run fails closed on expired evidence.

An offline plan makes no API, database or provider calls:

```sh
bun scripts/megapot-base-sepolia-golden.ts --multi-participant --input /approved/run.json
```

Authorized execution additionally requires `API_NEXT_ENV=staging`, the explicitly
pinned `PIRATE_STAGING_POSTGRES_HOST` and `PIRATE_STAGING_POSTGRES_DATABASE`, and
`CONTROL_PLANE_POSTGRES_RUNTIME_URL` for a read-only session. Sponsor credentials
use `PIRATE_STAGING_AUTHORIZATION` or the matching `_COOKIE` and `_CSRF_TOKEN`.
Each participant uses those suffixes on its own `credential_key`. Never commit
credentials or journal/artifact files. Do not reuse sponsor credentials as a
participant fallback.

After separately authorized real ceremonies and read access, collect each
artifact using the participant key from the input. This mode performs only SQL
SELECTs and, for Karaoke, its typed readiness GET; it does not start an activity
or create evidence. Save stdout privately at that participant's `preflight_path`.
Verified participants require the reviewed real ceremony reference; omit it for
the unverified negative. A plan may have `authorization: null` during collection.

```sh
bun scripts/megapot-base-sepolia-golden.ts --multi-participant --input /approved/run.json --collect-preflight study --ceremony-reference APPROVED_CEREMONY_REFERENCE --execute --confirm-base-sepolia
```

Repeat for the Karaoke and negative keys. The collector records exact current
proof-session/receipt/assertion ids and wallet, and rejects an eligibility state
different from the plan. A reference label alone does not prove a real ceremony;
the owner must review its provenance. No collector has been run on staging as
part of offline preparation.

```sh
bun scripts/megapot-base-sepolia-golden.ts --multi-participant --input /approved/run.json --journal /private/run.jsonl --execute --confirm-base-sepolia
```

The first call without a funding transaction returns the exact funding
instruction. The approved operator transfers once, adds only that transaction
hash to the input, and repeats the command with the same journal. All other
input fields are digest-bound. The runner observes funding; it never transfers,
signs, bootstraps or enables anything. A pending funding observation is not a
successful rehearsal. A natural drawing must already be open with sufficient
time before the actual cutoff.

The journal uses an exclusive lock and appends synced sanitized state before
activity writes. It excludes credentials, audio and WebSocket tokens. A crash
can leave a lock or an in-progress activity; inspect its exact effect/attempt
before an operator resolves it. Never delete a lock merely to retry. The runner
refuses to repeat an ambiguous activity. Completed activities are skipped on
replay. Ordinary server idempotency owns offer/funding replays.

Reconciliation is read-only and can continue without participant credentials:

If funding was confirmed but the drawing id was not journaled before a crash,
reconcile-only discovers it through a SELECT scoped to the journaled leg,
community, song, revision and Base Sepolia chain. It includes terminal drawings
and requires exactly one result; it never chooses the newest drawing. Missing
or multiple drawings require operator review. Recovery persists the discovered
id locally but does not repeat funding observations, purchase, or activities.
Missing activity evidence remains an incomplete rehearsal even if money settles.

```sh
bun scripts/megapot-base-sepolia-golden.ts --multi-participant --input /approved/run.json --journal /private/run.jsonl --execute --confirm-base-sepolia --reconcile-only
```

Polling is bounded to 120 observations and the approved deadline; an unfinished
result exits 2 and is explicitly `reconciliation_required`. Continue observing
the same journal within its window. Do not create another offer or transfer.
Only `reconciled_no_win` or `reconciled_win` is terminal success. Both require
whole-leg residual refund and no unresolved effects; the win additionally needs
every frozen beneficiary's confirmed payout. A tiny win with zero-value leaves
cannot establish the requested paid-every-beneficiary proof.

This observer checks persisted receipt/accounting evidence. It does not replace
independent chain balances, attestation, deployment readbacks, gas/provider cap
enforcement, kill-switch exercise or the 24-hour closeout. It cannot choose a
winner or authorize a waiver. Neither a passed local test nor a JSON approval
reference supplies owner authority.

## Hard-death lock recovery

A lock surviving SIGKILL or host loss is deliberately not removed automatically.
Its host, PID and acquisition time are diagnostic hints, not proof of death:
PIDs can be reused and another host may share the filesystem. Recovery requires
an operator with custody of the run and its original authorization.

1. Stop launches and automatic restarts for this exact journal on every host
   that can access it. Confirm the original process exited, or fence the lost
   host so it cannot resume. If that cannot be proved, do not touch the lock.
2. Preserve private copies of the exact input, journal and lock, and record
   their digests, the death/fencing evidence and operator approval in the run
   record. Never publish credentials or put these files in Git.
3. With launches still fenced, move only the exact stale lock to a unique
   evidence filename beside the journal, without overwriting an existing file.
   Keep the original journal and input unchanged. Do not truncate a torn journal
   tail, clear pending activity, or substitute another funding hash.
4. Permit one operator to run the same command with --reconcile-only inside the
   original reconciliation window. It acquires a new exclusive lock. No sponsor
   or participant credentials are needed. After the deadline, stop and obtain
   a separately reviewed recovery plan rather than editing the authorization.

An invalid/torn journal, missing leg, ambiguous drawing or pending activity stays
fail-closed. Reconciliation can report money settled while activity evidence is
incomplete; it cannot authorize a second transfer or purchase. The subprocess
SIGKILL tests in scripts/megapot-golden-recovery.test.ts exercise the lock archive
and read-only replay both with a known drawing and with a lost drawing id.
