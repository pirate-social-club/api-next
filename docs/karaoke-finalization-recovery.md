# Karaoke finalization recovery

Karaoke keeps score finalization and recording reconciliation in the
per-session Durable Object until Postgres acknowledges each result. The
jobs-worker does not own or duplicate that work. Its recovery job only finds
expired active sessions and completed sessions with pending recordings, then
wakes the Durable Object by session id.

`KARAOKE_FINALIZATION_RECOVERY_ENABLED` is an activation fence. Its only
enabled spelling is the literal string `true`. With any other value, the
Durable Object records attempts and uses capped exponential backoff but never
enters the exhausted state. This keeps existing sessions recoverable before a
central sweep is live.

Activate one environment in this order:

1. Deploy http-worker with the new re-drive RPC and its recovery flag still
   set to `false`. This makes the additive RPC callable without allowing local
   retries to exhaust.
2. Confirm the jobs-worker has a scheduled cron and its `KARAOKE_ATTEMPT`
   binding targets that HTTP worker in the same environment, then deploy the
   jobs-worker with its recovery flag still set to `false`.
3. Set only the jobs-worker flag to `true`, deploy it, and confirm the scheduled
   job can invoke the external Durable Object binding.
4. Set the http-worker flag to `true` and deploy it. Only this step enables
   local retry exhaustion.
5. Confirm Workers Logs contain no missing-object or RPC-failure event. An
   exhausted event is expected only when the central sweep rearms real work.

Rollback reverses the last two steps: set the HTTP-worker flag to `false`
first, then disable the jobs-worker flag. Existing exhausted rows remain
durable and can be rearmed by the still-running sweep during that interval.

Production jobs-worker currently declares no cron. Do not enable the
production flag until a separate authorized change activates and verifies its
schedule. Deploying this code with the checked-in `false` values changes no
live retry bound.
