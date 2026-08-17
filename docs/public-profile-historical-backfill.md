# Public-profile historical backfill

Status: importer and dry-run validator implemented; production execution is
blocked on a reviewed legacy export and an api-next target snapshot.

## Why a manifest is required

The legacy control-plane schema contains the fields needed to preserve real
history in `global_handles`:

```sql
SELECT global_handle_id, user_id, label_normalized, label_display, status,
       tier, issuance_source, redirect_target_global_handle_id,
       issued_at, replaced_at, created_at, updated_at
  FROM global_handles
 ORDER BY global_handle_id;
```

The workspace contains that schema and fixtures, but it does not contain a
production export or a live legacy database. The importer therefore refuses
to read a guessed source, synthesize aliases, or infer ownership. An
operator must create an immutable JSON manifest from one reviewed export.
The manifest records the exact selected columns, row count, snapshot time,
source SHA-256, and a top-level manifest SHA-256. Rows must be canonicalized
by `global_handle_id`.

The target is likewise supplied as a reviewed snapshot for dry-run. It must
contain the current api-next `users` and `public_handle_index` rows and its
own checksum. A live apply reads that same target inside the write
transaction instead of trusting a stale snapshot.

## Safety contract

`scripts/public-profile-backfill.ts` is deliberately dry-run-first:

- only exact ASCII `.pirate` labels accepted by migration `0006` are valid;
- `active`, `redirect`, and `retired` source states preserve their source
  meaning; redirects must point to an active same-owner target;
- missing/deleted owners, foreign targets, duplicate active owners, label or
  ID collisions, cycles, malformed target state, and digest mismatches fail
  closed;
- existing exact rows are skips, never updates; the importer cannot transfer
  ownership or mutate a target label;
- immutable handle IDs mean rename updates are intentionally disabled;
  renames are represented by the source's new active row plus its historical
  redirect rows;
- valid operations are sorted active/retired inserts before redirects, and a
  non-zero error count prevents apply;
- apply executes every insert through one caller-owned transaction. A unique,
  foreign-key, deferred redirect, or other database error must roll that
  transaction back;
- reports contain only counts, issue codes, checksums, and bounded SHA-256
  fingerprints. They do not print labels, user IDs, account JSON, or source
  payloads.

## Dry-run procedure

1. Export `global_handles` from the legacy system using a read-only operator
   path. Do not use a production credential in this repository.
2. Build a manifest with
   `makePublicProfileBackfillManifest({ snapshot_at, rows })`. Preserve the
   resulting JSON byte-for-byte after review.
3. Capture the api-next target users and public-handle rows with
   `makePublicProfileTargetSnapshot({ captured_at, users, handles })`.
4. Run:

   ```sh
   PUBLIC_PROFILE_BACKFILL_TARGET_SNAPSHOT=target.json \
     bun scripts/public-profile-backfill.ts --dry-run --manifest legacy.json
   ```

   The command opens no database connection and performs no writes. Review
   the report checksum and the bounded issue fingerprints. Any error count is
   a hard stop.

The module exports `runPublicProfileBackfill({ mode: "apply", ... })` for a
separately reviewed operator adapter. That adapter must implement
`withTransaction`, query the target snapshot in the transaction, and retain
the report and transaction evidence. There is intentionally no CLI apply
flag in this lane, and no migration, remote database, or deployment action is
performed by this change.

## Current external blocker

The source schema proves that historical labels are representable, but this
workspace does not prove which labels existed for production users. Until a
reviewed legacy `global_handles` export and a matching api-next user mapping
are supplied, the result is a validator/report only; no historical
completeness claim or traffic cutover is allowed.
