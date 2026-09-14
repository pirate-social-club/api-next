# Retained content rating reconciliation

This api-next operator command repairs current rating floors from retained,
server-bound moderation evidence. It does not rerun moderation, rewrite original
submission responses or decisions, republish hidden content, or change public
IPFS objects. Missing, malformed, ambiguous, unavailable, or unbound evidence
produces an unresolved hold rather than a general rating.

Apply migrations through 0186 and deploy the compatible rating guards and read
paths before using this command. Quiesce publication and moderation writers for
the reconciliation window. Old anonymous feed and sitemap caches must expire or
be purged before enabling the rollout; new no-store responses do not recall old
cached responses. This document is a procedure, not evidence of a production run.

Configure a database URL in an operator-owned environment variable. Do not put
credentials in command arguments, reports, or task records. From the api-next
checkout, inspect a bounded, read-only plan:

```sh
bun run reconcile:content-ratings --database-url-env RATING_DATABASE_URL --limit 100
```

The JSON report contains target identities, outcomes, source hashes, and one
plan hash, without content bodies or provider disclosures. Review the complete
batch. To apply exactly that reviewed batch, pass its full hash and the same
limit:

```sh
bun run reconcile:content-ratings --database-url-env RATING_DATABASE_URL --limit 100 --apply --plan-hash REVIEWED_SHA256
```

Apply uses one serializable transaction and an advisory lock. Changed source
state invalidates the plan; obtain and review a new plan instead of replacing
the hash silently. Driver failures report SQLSTATE without connection details.
There is no automatic retry. Repeating an already committed plan reports replay
without repeating its writes. A failed transaction leaves neither partial repairs
nor partial audit history.

Repeat read-only planning and reviewed application until the plan is empty.
Each batch contains at most 100 targets, although enforcing a parent floor or
hold also updates dependent comments and song-reference videos atomically.
An empty plan means every current candidate has a matching reconciliation
record; it does not mean every candidate is publishable. Inspect retained hold
outcomes separately. Moderators cannot restore content with an unresolved hold.

Adult outcomes raise current floors monotonically. Unknown outcomes hide public
resources and their dependent surfaces. Immutable operation and event rows retain
the reviewed plan, original status and rating, applied source identity, and
outcome. The current pointer may advance only to a fresh matching assessment.
Later accepted evidence may resolve a hold through another reviewed plan, but
resolution never publishes content automatically. Ordinary publication rules
and age-authorized reads still apply.

Rollback of an uncommitted operation is transactional. After commit, preserve the
audit history and use a reviewed forward correction; do not lower an accepted
adult floor or delete the hold ledger. Keep the feature disabled if current
read guards, consumer compatibility, provider acceptance, or the retained-data
review is incomplete.
