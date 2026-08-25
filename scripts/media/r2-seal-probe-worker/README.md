# Workers-binding R2 seal proof

This isolated Worker proves the ratified R2 binding protocol without editing a
shared runtime or production Wrangler surface. It streams one conditionally
selected source through `DigestStream`, writes only when the immutable key is
absent, verifies the returned object against a strongly consistent head, and
keeps cleanup closed around the exact returned identity.

The checked-in Wrangler file is local-only. Its bucket, target label, prefix
and token are inert fixture values. Never deploy it. A live proof uses a
private, untracked Wrangler configuration generated from the accepted target
allowlist, with `workers_dev` and preview URLs disabled and the run token
provisioned as a secret. No operator-local identifier belongs in this branch.

The live runner accepts exactly four bounded scenarios and generates its own
small payload. Each request needs the acknowledgement string, a UUIDv4 run ID,
and the private bearer token. Responses exclude request bodies, credentials,
URLs and authorization headers. Every cleanup first checks the complete
returned version, ETag, size, media type, ownership marker, source version and
stored checksums. Any disagreement is retained as cleanup uncertainty.

## Cleanup boundary

The Workers R2 binding does not expose a conditional or version-targeted
`delete`; it accepts only an object key. This proof therefore checks the full
returned identity immediately before deleting a disposable, run-owned key and
then confirms absence, but it cannot prove that the delete was atomic with the
identity check. That is sufficient only for cleaning up this isolated runner,
whose random prefix and write capability are exclusive.

Do not promote this cleanup helper into the production seal adapter. Production
acceptance remains blocked until the specification either ratifies the
identity-check plus exclusive immutable-key capability as its fence or selects
a deletion mechanism that can carry an ETag or version condition. Cleanup
evidence from this runner must report that the binding delete was
unconditional.
