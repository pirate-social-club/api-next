# Public-profile historical backfill

Status: importer and dry-run validator implemented; production execution is
blocked on a reviewed legacy export and an api-next target snapshot.

## Why a manifest is required

The legacy control-plane schema contains the fields needed to preserve real
history in `global_handles`:

```sql
SELECT global_handle_id, user_id, label_normalized, label_display, status,
       tier, issuance_source, redirect_target_global_handle_id,
       price_paid_cents, free_rename_consumed,
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

The final legacy schema uses integer `price_paid_cents`; older exports may
have the historical `price_paid_usd` column. This importer accepts only the
final cents field. Any historical USD-to-cents conversion must be performed
and reviewed in the external export process, never guessed here.

The manifest also requires two explicit, one-to-one mapping tables:

- `owner_mappings`: `legacy_user_id` → `api_next_user_id`, with the reviewed
  legacy state (`active`, `merged`, or `tombstoned`). Merged/tombstoned rows
  require `reviewed: true`, and every mapped api-next owner must exist and be
  active. Active legacy owners remain injective; reviewed merged/tombstoned
  owners may converge on that active canonical api-next owner. There is no
  implicit identity match, and unreviewed convergence is rejected.
- `handle_mappings`: `legacy_handle_id` → `api_next_handle_id`. Target IDs
  are strict ASCII IDs and are the only IDs written to `public_handle_index`;
  redirects resolve through this table to the mapped canonical target ID.

This convergence matches api-next `account_aliases` resolution, which follows
active aliases and finalizing/completed merges to one canonical user. The
legacy owner state and mapping remain explicit reviewed export data; the
importer never infers an alias or merge from raw IDs.

These mappings are part of the manifest digest. Account aliases, merges, and
tombstones cannot enter the import without an explicit reviewed mapping. Each
mapping table also carries its own SHA-256 over its canonical ordered JSON;
the parser validates both mapping digests before validating the top-level
manifest digest.

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
- apply starts a `SERIALIZABLE` transaction, locks target users and handle
  rows with `FOR UPDATE`, recomputes the plan from the locked state, and
  refuses a changed owner/status/label state before inserting;
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

The target table has no columns for legacy `tier`, `issuance_source`,
`price_paid_cents`, `free_rename_consumed`, or source timestamps. The report
explicitly lists those fields as omitted: the import preserves only the
public-handle lifecycle projection (mapped ID, label, status, owner, and
redirect target) plus manifest provenance checksums.

## Dry-run procedure

1. Export `global_handles` from the legacy system using a read-only operator
   path. Do not use a production credential in this repository.
2. Build a manifest with
   `makePublicProfileBackfillManifest({ snapshot_at, rows, owner_mappings, handle_mappings })`.
   Preserve the resulting JSON byte-for-byte after review.
3. Capture the api-next target users and public-handle rows with
   `makePublicProfileTargetSnapshot({ captured_at, users, handles })`.
4. Run:

   ```sh
   PUBLIC_PROFILE_BACKFILL_TARGET_SNAPSHOT=target.json \
     bun scripts/public-profile-backfill.ts --dry-run --manifest legacy.json
   ```

   The command opens no database connection and performs no writes. Review
   the report checksum and the bounded issue fingerprints. Any error count is
   a hard stop and exits nonzero.

The module exports `runPublicProfileBackfill({ mode: "apply", ... })` for a
separately reviewed operator adapter. The repository-local
`createPublicProfileBackfillPgAdapter` resolves `pg` from the
`@pirate/platform-cf` package's dependency and provides the transactional
adapter used by the focused PG17 suite. An operator adapter must query the
target snapshot in the transaction and retain the report and transaction
evidence. There is intentionally no CLI apply flag in this lane, and no
migration, remote database, or deployment action is performed by this change.

## Current external blocker

The source schema proves that historical labels are representable, but this
workspace does not prove which labels existed for production users. Until a
reviewed legacy `global_handles` export, explicit owner mappings, explicit
handle mappings, and a matching api-next target snapshot are supplied, the
result is a validator/report only; no historical completeness claim or
traffic cutover is allowed.

When Postgres 17 and the repository dependencies are available, the focused
integration suite is:

```sh
CONTROL_PLANE_POSTGRES_TEST_URL=... \
  bun test scripts/public-profile-backfill.pg.test.ts
```

It is skipped when the URL or `pg` dependency is unavailable. It exercises
the real migration tables, deferred current/redirect inserts, idempotent
reruns, dry-run no-write, collisions, database rollback, and an owner-status
lock race.
