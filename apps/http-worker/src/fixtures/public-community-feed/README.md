# Anonymous Community feed handoff

These six fixtures came from the installed production HTTP composition over
an isolated PostgreSQL database seeded entirely with synthetic records. They
cover public-only, mixed public and age-locked, locked-only, empty-success,
missing Community and unavailable storage responses. They are not production
acceptance evidence. Only content-type and cache-control response headers are
retained; error request identifiers are replaced with a fixed fixture UUID.

The PostgreSQL composition test compares the same rows through the public home
and Community surfaces, checks credential-present requests, and changes
moderation and age rating between requests. The unit fixture test decodes the
retained responses through the generated client rather than casting bodies.

The standalone Solid lockfile pins the 0.62.0 archive with SHA-512
`PqV4NEbVgWa7PkCXCZpcGyaQAckx/YZTAgXhvSV4sCBzNlQRaDXkkJD6CL/Y2dTpq8k6nhbfWA4pzkrTEnVC6w==`.
Its generated client source is byte-identical to the API client used here, with
SHA-256 `19a44dcd991b83040dd7998244acba96b4f62a0a2b1d7c3578b5bf20fa6a2594`.
No client release or Solid vendoring change is required. A stale installed
node_modules copy must not substitute for that pinned artifact.

The Solid feed-state lane may use these fixtures to distinguish loading,
empty, failure and permitted locked presentation. A locked item supplies no
post identifier, body, author, title, preview or content URL. It must not be
dropped into an empty-state result. Runtime release and staging evidence remain
separate from this fixture handoff.
