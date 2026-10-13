# Legacy learner audio producer settlement

Migration 0264 records every legacy producer whose storage I/O was never proved
finished as an `unknown` upload: Karaoke attempts that were pending or failed
at the learning upgrade, and Study answers whose reservation never resolved.
Account audio deletion answers `in-flight` for an account holding one, and a
reclaim cannot write the same key, until the producer is settled. Legacy
Karaoke recordings that completed and read their object back were already
closed by the migration and need nothing here.

A settlement is admissible only where the producer's own code proves that it
has shut down and that every storage operation it issued has ended. Nothing
else is such proof: not a database fact, a serving-version or traffic readback,
an elapsed lease or session, a new SQL fence, a matching digest, a missing
object, or a fixture time. Cloudflare propagates a deployment eventually, and
an in-flight request that does not touch Durable Object storage may still
finish after it. Where the proof below cannot be established, the producer
stays `unknown` and the account stays `in-flight`; do not settle it.

This runbook authorizes no production use; production remains under its
separate exclusion.

## What can be settled

| Producer | Legacy write | Settlement |
| --- | --- | --- |
| Karaoke attempt host | One multipart upload per attempt key, issued only from producer paths the host admits through its reset drain | Admissible only with the attempt host's own reset receipt for that key, followed by abort, exhausted listing and HEAD. |
| Study answer | One `PUT` of the answer to `learner-audio/study/<attempt>/<sha256>`. A reclaim after lease expiry kept the attempt and key and replaced only the lease. | Never. Every earlier lease generation may still deliver an identical `PUT`, even after deletion. A present object with the reserved digest proves only that one `PUT` completed. |

The database enforces this:

- `settle_legacy_learner_audio_upload_private_v1` refuses every legacy Study
  producer, and refuses Karaoke evidence that lacks a drained reset receipt for
  the exact key.
- The shared closure `settle_learner_audio_upload_private_v1` refuses to close
  an imported legacy producer unless that settlement's evidence is already
  recorded. Its captured-producer callers and closed-result replay are
  unchanged, and no runtime role can execute it.

Both functions and the evidence relation `learner_audio_legacy_settlements` are
owner-only. The relation rejects update and delete.

## Why the Karaoke receipt is terminal

The legacy attempt host (`KaraokeAttemptDO`) wraps every path that issues an R2
call, including fetch, socket messages, alarms, initialization and redrive, in
its reset producer barrier. Its operator reset (`applyReset`):

1. persists a durable marker in the object's storage. Every later instance of
   that object, whatever code version it runs, reads the marker before
   anything else and starts fenced;
2. closes producer admission, cancels the alarm and closes every socket;
3. drains every admitted producer. Each one awaits its R2 call, so a completed
   drain means no call it issued is still outstanding, including a
   multipart creation or completion. A drain that times out records
   `quiescenceEstablished: false`.

The receipt's `current` observation also names the archive key and open upload.

An instance displaced before the reset is the remaining case. In the legacy
code, every step between two R2 calls (create, part upload, completion) reads
or writes the object's storage. A displaced instance can therefore finish at
most the one R2 call it had already issued:

- a late multipart creation leaves an upload with no parts that nothing can
  complete;
- a late part upload or completion either lands before the abort below, so
  HEAD sees its result, or fails because the abort removed its upload.

The staging ceremony must confirm this platform behavior on a real displaced
instance before the route is relied on. If it does not hold, stop and keep the
producer `unknown`.

The reset admits only the frozen staging inventory in
`karaoke-reset-installation.ts` and only where `KARAOKE_RESET_ENABLED` is set. A
Karaoke producer whose attempt host is outside that inventory, or whose drain
did not complete, cannot be settled and stays `unknown`.

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

Study rows are listed for the record only. They stay `unknown`.

## 2. Shut the attempt host down

For a Karaoke producer, run the authenticated operator reset against its
attempt host. Record the receipt exactly as returned, and record the time it
returned as `shutdownAt`. Proceed only when all of these hold:

- `state` is `active`;
- `quiescenceEstablished` and `cancellationSucceeded` are `true`;
- `current.alarm` is `null` and `current.sockets` is `0`;
- `current.archiveKey` is the producer's exact `object_ref`.

Keep the sanitized receipt. Its SHA-256 becomes `receipts.reset`. Record every
Worker version serving the attempt host and the operator path: script, version
id, the exact source commit and the SHA-256 of the deployed artifact.

## 3. Observe the exact key

After `shutdownAt`:

1. List the multipart uploads for the exact key until the listing is
   exhausted.
2. Abort each upload, and record its upload id in `abortedMultipartUploadIds`.
3. List again until exhausted, with none open.
4. HEAD the key: `present` (HTTP 200) or `absent` (HTTP 404). Any other result
   is not evidence; observe again.

Keep the sanitized abort, final listing and HEAD receipts. Record the HEAD time
as `observedAt`.

## 4. Settle

Karaoke evidence (no other fields are accepted):

```json
{
  "objectRef": "karaoke/<account>/<attempt>.pcm",
  "headStatus": "absent",
  "openMultipartUploads": 0,
  "abortedMultipartUploadIds": ["<upload id>"],
  "servingVersions": [
    { "script": "<worker>", "versionId": "<id>", "sourceCommit": "<40 hex>", "artifactSha256": "<64 hex>" }
  ],
  "producerShutdown": { "<the reset receipt, exactly as returned>": "…" },
  "shutdownAt": "2026-10-16T09:00:00.000Z",
  "observedAt": "2026-10-16T09:20:00.000Z",
  "receipts": { "reset": "<sha256>", "abort": "<sha256>", "listing": "<sha256>", "head": "<sha256>" }
}
```

```sql
SELECT settle_legacy_learner_audio_upload_private_v1(
  '<upload_attempt_id>', '<stored|absent>', '<evidence json>'::jsonb);
```

The disposition must match `headStatus` (`present` is `stored`). The function
refuses:

- another key, or a non-legacy, guest-owned, Study or already closed upload;
- a receipt that is not drained or that names another key;
- an observation before `shutdownAt` or in the future;
- a second, different settlement.

An identical replay changes nothing.

A `stored` settlement leaves the object for deletion: an active deletion
deletes it again in a new batch, and a later account deletion includes it. Run
the account's deletion again and confirm `remaining_count` reaches zero.

## Staging proof still required

The repository tests prove the database rules with fixture evidence; they do
not prove that a real platform reached quiescence. Before relying on this
route, run it once in staging against an interrupted legacy Karaoke upload,
including a displaced instance with a creation or completion in flight. Bind it
to the reset receipt and the guarded release's receipts, and keep the resulting
sanitized evidence with the release record.
