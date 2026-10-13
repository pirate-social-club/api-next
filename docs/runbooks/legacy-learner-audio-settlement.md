# Legacy learner audio producer settlement

Migration 0264 records every legacy producer whose storage I/O was never proved
finished as an `unknown` upload: Karaoke attempts that were pending or failed
at the learning upgrade, and Study answers whose reservation never resolved.
Account audio deletion answers `in-flight` for an account holding one, and a
reclaim cannot write the same key, until the producer is settled. Legacy
Karaoke recordings that completed and read their object back were already
closed by the migration and need nothing here.

No database fact proves that a retired Worker version or attempt host stopped
writing, and neither a traffic change nor a missing object is such proof. A
settlement is admissible only where the storage protocol itself makes the
observation terminal for that producer. Where it does not, the producer stays
`unknown` and the account stays `in-flight`; do not settle it. Never treat
lease or session expiry, a database preview or a fixture time as evidence.
This runbook authorizes no production use; production remains under its
separate exclusion.

## What is terminal

| Producer | Legacy write | Admissible observation |
| --- | --- | --- |
| Karaoke attempt host | One multipart upload per attempt key, completed by the host | After capture-era versions alone serve the attempt host, abort every open upload for the key and list until exhausted with none open. No completion can then create the object, so HEAD `present` or `absent` is final. |
| Study answer | One `PUT` of the answer to `learner-audio/study/<attempt>/<sha256>` | Only HEAD `present` whose stored bytes hash to the key's digest. That shows the single PUT completed, and any repeat could only write identical bytes before deletion. An absent object never proves an issued PUT will not land: keep it `unknown`. |

The settlement function enforces these classes: it refuses an absent Study
object, a Study object whose digest differs from its reservation, Karaoke
evidence without abort and listing receipts, and any other key or producer.

## 1. Find the producers

Read-only, through an approved administrator connection:

```sql
SELECT u.upload_attempt_id, u.source_kind, u.object_ref, u.created_at, o.account_id
  FROM learner_audio_upload_attempts u
  JOIN participation_owners o ON o.owner_id = u.owner_id
 WHERE u.upload_attempt_id LIKE 'lau\_legacy\_%'
   AND u.io_state = 'unknown'
 ORDER BY u.created_at, u.upload_attempt_id;
```

## 2. Bind the serving versions

From a guarded release and its serving readback, record every HTTP, jobs and
attempt-host version receiving traffic: Worker script, version id, the exact
source commit and the SHA-256 of the deployed artifact. All of them must be
built from source that includes producer capture (0262 or later). Record the
readback time as `servingCutoverAt` and keep the sanitized readback receipt;
its SHA-256 becomes `receipts.servingReadback`. Attempt-host Durable Objects
restart on code deployment, so after this readback no legacy host code runs.

## 3. Observe the exact key

After the readback:

1. Karaoke only: list multipart uploads for the exact key until exhausted,
   abort each one (record its upload id in `abortedMultipartUploadIds`), then
   list again until exhausted with none open. Keep the sanitized abort and
   final listing receipts.
2. HEAD the exact key: `present` (HTTP 200) or `absent` (HTTP 404). Any other
   result is not evidence; observe again. For Study, `present` also requires
   reading the object and recording the SHA-256 of its bytes as
   `contentSha256`; it must equal the digest in the key.

## 4. Settle

Karaoke evidence (no other fields are accepted):

```json
{
  "objectRef": "karaoke/<account>/<attempt>.pcm",
  "headStatus": "absent",
  "openMultipartUploads": 0,
  "abortedMultipartUploadIds": ["<upload id>"],
  "servingCutoverAt": "2026-10-16T09:00:00.000Z",
  "observedAt": "2026-10-16T09:20:00.000Z",
  "servingVersions": [
    { "script": "<worker>", "versionId": "<id>", "sourceCommit": "<40 hex>", "artifactSha256": "<64 hex>" }
  ],
  "receipts": { "servingReadback": "<sha256>", "head": "<sha256>", "listing": "<sha256>", "abort": "<sha256>" }
}
```

Study evidence replaces the abort fields with `"contentSha256": "<64 hex>"`,
uses `"headStatus": "present"`, and has receipts `servingReadback`, `head` and
`listing`.

```sql
SELECT settle_legacy_learner_audio_upload_private_v1(
  '<upload_attempt_id>', '<stored|absent>', '<evidence json>'::jsonb);
```

The disposition must match `headStatus` (`present` is `stored`). The function
refuses another key, a non-legacy, guest-owned or already closed upload, an
observation before the cutover or in the future, and a second, different
settlement; an identical replay returns `false` without changing anything.
Evidence is kept in `learner_audio_legacy_settlements`, which only the schema
owner can read or write and which rejects update, delete and truncate.

A `stored` settlement leaves the object for deletion: an active deletion
deletes it again in a new batch, and a later account deletion includes it.
Run the account's deletion again and confirm `remaining_count` reaches zero.

## Staging proof still required

The repository tests prove the database rules with fixture evidence; they do
not prove that a real platform reached quiescence. Before relying on this
route, run it once in staging against an interrupted legacy Karaoke upload
and a late Study write, bound to the guarded release's receipts, and keep the
resulting sanitized evidence with the release record.
