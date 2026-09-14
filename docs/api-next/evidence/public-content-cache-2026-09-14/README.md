# Public content cache protection

Anonymous home feed and public post sitemap responses now use no-store, as
community threads already do. Public key caching is unchanged. Transport tests
passed 44 tests and the complete check passed with 180 migrations. This evidence
predates the separate migration 0185 draft. Rating changes must affect subsequent
reads, so Solid also bypasses existing HTTP caches for these requests.

Deploying these headers does not remove responses cached under earlier rules.
Rollout must purge controlled caches and account for the previous API one-hour
and Solid sitemap five-minute TTLs before enabling reconciled content. No purge,
deployment or live acceptance was performed here.
