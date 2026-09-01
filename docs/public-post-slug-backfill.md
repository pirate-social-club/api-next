# Public Post slug backfill

This tool implements the bounded, resumable, dry-run-first backfill required by
Spec 022. It is not a route fallback and is never called by a Worker request,
feed read, sitemap read, or publication read path.

The checked-in command supports dry-run only. There is deliberately no apply
flag:

```sh
CONTROL_PLANE_POST_SLUG_BACKFILL_URL='postgres://...' \
  bun scripts/public-post-slug-backfill.ts --dry-run --page-size 100
```

The connection setting selects the database read by the dry run. It does not
authorize writes. The command opens a repeatable-read, read-only transaction,
captures a stable upper `(created_at, post_id)` bound when one is not supplied,
and reports the first bounded page. Continue with the exact `upper_bound` and
`next_cursor` returned by the prior page:

```sh
CONTROL_PLANE_POST_SLUG_BACKFILL_URL='postgres://...' \
  bun scripts/public-post-slug-backfill.ts --dry-run \
    --page-size 100 \
    --upper-bound 'ppsb1....' \
    --cursor 'ppsb1....'
```

Keep every page report. The page digests, aggregate policy counts, and final
dry-run result digest form the reviewed input to an authorization record.
Dry-run output contains no title or body. SQL projects source text only for a
currently published, active-community, public, general-rated text or song Post;
guarded rows reach the planner with null source fields and an opaque policy.

## Apply boundary

`runAuthorizedPostSlugBackfillPage` is the programmatic apply core. It cannot
accept an authorization object directly. It resolves a canonical record by run
ID, repository, and database environment through
`PostSlugBackfillAuthorizationRegistry`. It verifies the returned record's
digest, scope, environment binding, expiry, exact cursor bounds, page size,
maximum page count, per-page dry-run digests, and completed result digest, then
re-plans the live page in a serializable transaction before any alias
allocation.

No authorization-registry implementation or apply CLI is checked in. Supplying
that integration, recording a live authorization, and executing a live page are
separate operationally authorized work. A CLI flag, environment variable,
browser request, route value, title, slug, or post ID cannot satisfy the
registry boundary.

After an authorized page transaction commits, the caller persists the returned
canonical checkpoint. It contains the run ID, authorization digest, monotonic
page index and cursor, cumulative policy counts, start/update/completion times,
page digests, and completion result digest. A crash after database commit but
before checkpoint persistence is safe: the same authorized page re-plans to the
same action digest, observes immutable aliases already present, and returns an
equivalent checkpoint without rewriting them. Retry timestamps and therefore
the checkpoint's integrity digest may differ.

The separately authorized runner must persist that checkpoint durably with
single-writer or compare-and-set semantics keyed by run ID and authorization
digest. This lane supplies no checkpoint store or runner. Alias-only races are
safe to replay; a change to title-derived candidate, lifecycle, visibility,
rating, community state, ordering, or page membership fails the recorded page
digest and requires a new dry run and authorization.

The authorized page digest commits to each row's identity, order, policy,
candidate, and blocking issue. It deliberately excludes the observational
`existing_slug` value. Alias presence changes no authorized action because the
row is already satisfied, the table accepts only `post-slug-v1` aliases, and
the database rejects alias update or deletion. This is what permits publication
races and crash-after-commit replay to converge without weakening the unique
`post_id` allocator boundary.

Historical `removed` rows block the page and must be normalized to `hidden`
before another dry run. Draft, processing, failed, and deleted Post rows are
skipped. Hidden, members-only, adult, inactive-community, and post types without
a ratified descriptive source rule receive opaque policy decisions without
source text. Rows inserted after the captured upper bound belong to a later run.

## Verification

Focused checks are:

```sh
bun test scripts/public-post-slug-backfill.test.ts
bun test scripts/public-post-slug-backfill.pg.test.ts
```

The PostgreSQL suite proves read-only dry-run behavior, stable two-page order,
same-title collision allocation, opaque guarded allocation, crash replay,
upper-bound exclusion, skipped drafts, and removed-row rollback against
PostgreSQL 17. The full repository gates remain required before review.
