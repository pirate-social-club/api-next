# Multi-participant golden runner

This is staging-only operational test tooling. No Worker runtime, flag or
deployment is changed. Use only after the dated authorization package is
complete and explicitly approved. The original single-Study CLI remains intact.

The v2 input schema is `MultiGoldenInput` in
`scripts/megapot-golden-multi-input.ts`. It requires at least one eligible
account covering Study and Karaoke, plus a distinct unverified negative.
One eligible account may complete both activities and receive one share.
Several eligible accounts remain supported to exercise a multi-beneficiary
split. The one-account mode does not prove a live split among distinct people.
Every participant names a v2 preflight artifact and its own environment-variable
credential prefix. Artifacts are reviewed ceremony evidence, not authority to
seed receipts. Their exact wallet and Very witness are rechecked read-only
against staging before writes and each activity. Artifact freshness is ten
minutes maximum; arrange short runs and regenerate artifacts before starting,
not by editing their timestamps. A long run fails closed on expired evidence.

For the in-app rehearsal, set `activity_mode` to `"observe_app"` and supply
`app_funded_pool`. The verified account completes both Study and Karaoke in
Solid after its real palm-gated join. Its plan entry needs no `accepted_lyrics`
or `karaoke_audio`; the runner never submits its Study answers, reads a vocal
file or creates its Karaoke attempt. The separate unverified account still
needs `accepted_lyrics` and a Study credential because the runner drives that
negative case with synthesized answers. Collect a fresh preflight for each
account before adoption. During the wait the runner re-reads current identity
and reward evidence from staging; the ten-minute preflight file does not act
as an activity-time clock. Expired live Very evidence still stops the run.
Before the run, check that the unverified account's persona is bound to the
community for activity (`active_activity_persona`) and can access the public
song. Study does not require community membership, but its start route requires
that binding. If absent, activity persona preparation is a separate authorized
app/API action; the runner does not create it.

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

For the staging sponsor rehearsal, create and fund the offer in Solid's Boost
flow from the sponsor's authenticated browser session. The sponsor signs the
exact Base Sepolia USDC transfer there; the runner does not hold a wallet key.
Wait for the app's funding effect to be confirmed. Then record the exact
offer, leg and funding-effect ids, transfer hash, and sponsor wallet address
in the private plan's `app_funded_pool` field:

```json
{
  "app_funded_pool": {
    "offer_id": "APP_OFFER_ID",
    "leg_id": "APP_LEG_ID",
    "funding_effect_id": "APP_FUNDING_EFFECT_ID",
    "transaction_hash": "0xEXACT_CONFIRMED_TRANSFER_HASH",
    "sender_address": "0xSPONSOR_PERSONA_WALLET"
  }
}
```

Use actual 32-byte hashes and 20-byte addresses, not these placeholders.
Set the rest of the private plan to the app-created terms, especially its
exact `starts_at` (generated when Boost creates the offer), `ends_at`, amount,
ticket ceiling and cutoff. Select both Study and Karaoke, a 70% additional
score floor, and `no_purchase` for an empty pool. Do not also set
`funding_transaction_hash`. Read back the app's confirmed funding and current
offer terms before authorizing execution; a draft or pending funding effect is
not a handoff. The runner's read-only PostgreSQL check binds the offer to the
sponsor's active persona wallet, exact terms, one pool leg, one funding effect,
active staging attestation and custody recipient. Its API GETs then bind the
confirmed transfer to one open drawing with enough cutoff time. Any mismatch
stops before Study or Karaoke writes. Replaying the same journal repeats only
these reads, never a funding or offer POST.

In `observe_app`, the runner waits for both verified qualifications, their
independent eligible decisions, exactly one share, and the negative Study
qualification with `verification_missing` and no share. Each poll uses a new
read-only database transaction scoped to the adopted leg and drawing. The
earlier of the approved qualification deadline and the drawing's actual entry
cutoff ends the wait. Missing rows then return nonterminal
`activity_evidence_incomplete`; mismatched or duplicate shares and contrary
decisions stop immediately. Only the negative Study submission is journaled as
a runner activity. A replay does not repeat it; use a newly collected preflight
if the prior file has expired.

The one-ticket limit needs a timing check outside this plan. The scheduler can
open another drawing when its cutoff is at or before the offer end. Before
funding, establish the target and following drawing cutoffs from current live
read-only evidence. Whether the following cutoff is available before funding
is an unresolved feasibility check. Set the offer end strictly after the target
cutoff and before the following cutoff, then confirm those exact terms in the
app-funded handoff. If the following cutoff cannot be established, the run is
not ready for funding.
Funding of 1 USDC and a per-drawing ticket ceiling do not prove a one-ticket
total. The offer may end before target settlement: terminal closure waits for
the drawing to reach a terminal state and for reservations to clear. Record
that terminal progression during the enabled closeout.

The older runner-created mode remains for its existing tests and operator
compatibility. Without `app_funded_pool`, the first call returns its funding
instruction; an operator supplies `funding_transaction_hash` after a separate
approved transfer, and the runner observes it. Do not use that mode for the
app-funded rehearsal. Neither mode transfers, signs, bootstraps or enables
anything. A pending funding observation is not a successful rehearsal.

The staging estimate for two Karaoke attempts is at most one hour of scored
audio, about $0.39 at the provider's published base rate as checked on
2026-09-23. `max_provider_spend_atomic` is not a metered billing cap; the
enforced runner controls are two attempts and the approved audio-duration and
Study-submission limits. Record actual provider charges separately.

The journal uses an exclusive lock and appends synced sanitized state before
activity writes. It excludes credentials, audio and WebSocket tokens. A crash
can leave a lock or an in-progress activity; inspect its exact effect/attempt
before an operator resolves it. Never delete a lock merely to retry. The runner
refuses to repeat an ambiguous activity. Completed activities are skipped on
replay. Ordinary server idempotency owns offer/funding replays.

The PostgreSQL HTTP test `apps/http-worker/src/rewards-golden-retry.pg.test.ts`
kills a subprocess executing journaled pool preparation after accepted offer,
leg and funding responses,
archives each proven-dead lock, and replays the original journal. Real transport,
application services, repositories and funding coordination must retain one
offer, leg, funding action and credited amount. Transport authentication,
authorization and the transfer
receipt are fixtures; no ticket scheduler or live chain participates in this test.

The Karaoke endpoint replays an unchanged request for the same account, persona
and idempotency key. Nevertheless, a reservation accepted before `recordAttempt`
leaves `pending_activity` set, and the runner refuses execution before making
another request. The consumed cap remains consumed. Operator inspection must
recover the exact reservation from server evidence; do not clear pending state,
increase caps or create a replacement attempt to make a rehearsal pass. The
orchestration test covers this fail-closed boundary, not automatic attempt recovery.

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
Keep the rewards scheduler enabled for the separately approved 24-hour
affected-flow closeout after the run, observe rollover and liveness with the
offer ending inside that window, then disable both flags and read them back.
The runner does not schedule or automate that closeout.

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
