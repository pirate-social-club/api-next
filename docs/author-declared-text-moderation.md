# Author-declared text report moderation

Since migration 0244, new text posts, comments and replies publish in `author_declared` mode. They have no provider policy revisions, hashes or evidence reference. Member reports still require normal owner moderation. Case detail and action auditing must preserve this absence rather than fabricate policy evidence or reject valid reports.

The case-detail response keeps its six policy fields, permitting explicit nulls for author-declared content. Moderated submissions still require all six strings in repository validation. No authentication, owner, age, tenant, revision or idempotency rule changes. The exact nullable response deprecation is recorded against published main 10c2116ec8ad8585b8fb61907ef2a2959c938195; its waiver must be retired after integration.

Migration 0274 permits either complete policy snapshots or a wholly absent snapshot on action audit rows. The insertion trigger checks the immutable submission publication mode: absent evidence is accepted only for author-declared text, while moderated actions require a complete matching snapshot. Existing audit history is unchanged.

The real PostgreSQL regression publishes a post, comment and reply, reports each through the repository, reads its case, hides and restores it, and verifies replay, owner/tenant restrictions, stale revisions, audit rows, projection counts and unchanged publication history. Existing moderated cases retain their historical regression coverage.

Staging requires migration 0274 once, then the reviewed Worker source and generated client consumer checks through the maintained guarded deployment path. Production requires a separately reviewed combined release; its earlier migrations are not assumed applied. Funding migration numbers remain provisional until actual merge order. This source change does not activate Rewards, funding, video cutover or production.
