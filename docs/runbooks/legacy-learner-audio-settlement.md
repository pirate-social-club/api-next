# Legacy learner audio producer settlement

Migration 0264 records every legacy producer whose storage I/O was never
proved finished as an `unknown` upload: Karaoke attempts that were pending or
failed at the learning upgrade, and Study answers whose reservation never
resolved. Account audio deletion answers `in-flight` for an account that holds
one, and a reclaim cannot write the same key, until an operator settles it with
evidence. Legacy Karaoke recordings that completed and read their object back
were already closed by the migration and need nothing here.

No database fact proves that a retired Worker version or attempt host stopped
writing. The settlement is an operator assertion bound to exact evidence; never
treat lease or session expiry, a database preview or a single missing-object
read as that proof. This runbook authorizes no production use; production
remains under its separate exclusion.

## Find the producers

Read-only, through an approved administrator connection:

```sql
SELECT u.upload_attempt_id, u.source_kind, u.object_ref, u.created_at, o.account_id
  FROM learner_audio_upload_attempts u
  JOIN participation_owners o ON o.owner_id = u.owner_id
 WHERE u.upload_attempt_id LIKE 'lau\_legacy\_%'
   AND u.io_state = 'unknown'
 ORDER BY u.created_at, u.upload_attempt_id;
```

## Establish the serving cutover

From the deployment readbacks for the environment, record the time after which
no HTTP, jobs or attempt-host version that predates producer capture (source
before 0262) received traffic, plus that version's longest request lifetime.
`servingCutoverAt` is the later of those instants. Keep the readback receipt;
its identifier becomes `readbackRef`.

## Observe the exact key

After the cutover, for each `object_ref`:

1. List multipart uploads for the exact key until the listing is exhausted.
   Abort every open upload for that key and list again; the recorded count must
   be zero.
2. HEAD the exact key: `present` (HTTP 200) or `absent` (HTTP 404). Any other
   result is not evidence; observe again.

The Karaoke reconciliation evidence collector (`karaoke-reconciliation.ts`)
records the same before/after listings and HEAD for Karaoke keys.

## Settle

Use the exact observation, with no extra fields:

```json
{
  "objectRef": "karaoke/<account>/<attempt>.pcm",
  "headStatus": "absent",
  "openMultipartUploads": 0,
  "servingCutoverAt": "2026-10-16T09:00:00.000Z",
  "observedAt": "2026-10-16T09:20:00.000Z",
  "readbackRef": "<serving readback receipt id>"
}
```

```sql
SELECT settle_legacy_learner_audio_upload_private_v1(
  '<upload_attempt_id>', '<stored|absent>', '<evidence json>'::jsonb);
```

The disposition must match `headStatus` (`present` is `stored`). The function
refuses another key, a non-legacy or already closed upload, an observation
before the cutover or in the future, and a second, different settlement. An
identical replay returns `false` without changing anything. Evidence is kept
immutably in `learner_audio_legacy_settlements`.

A `stored` settlement leaves the object for deletion: an active deletion deletes
it again in a new batch, and a later account deletion includes it. Run the
account's deletion again afterwards and confirm `remaining_count` reaches zero.
