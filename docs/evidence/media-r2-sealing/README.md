# Conditional R2 sealing evidence

This directory defines the redacted evidence shape for the local-only R2
sealing proof. The probe is a dry run. It uses the hostile fixture set and an
in-memory fake transport; it does not read credentials, inspect environment
variables, call `fetch`, contact R2, create a bucket, or deploy a Worker.

Run the probe from the api-next repository root:

```text
bun scripts/media/r2-seal-probe.ts
```

The command prints JSON conforming to [schema.json](./schema.json). The output
contains only fixture object keys, expected and observed ETags, operation
counts, closed outcomes, and safety assertions. It never includes request
headers, authorization material, object bytes, or environment values. Both the
field allowlist and a value-level secret/URL guard fail closed before emission.

The fixture set covers these outcomes:

- `success` observes the source ETag, sends exactly one copy with
  `x-amz-copy-source: /<source-bucket>/<encoded-source-key>`, the exact observed
  ETag in `x-amz-copy-source-if-match`, and
  `cf-copy-destination-if-none-match: *`. It then verifies the destination with
  one `HEAD`, including a matched destination version before reporting local
  success.
- `source_missing` stops after a parsed `NoSuchKey` from either the source
  `HEAD` or the conditional copy. Generic 404, `NoSuchBucket`, malformed
  response, and non-conditional copy errors remain provider-unknown.
- The size, content-type, mismatched-checksum, and missing-checksum expectation
  fixtures each stop before copy with `expectation_mismatch`. ETag is preserved
  as the copy precondition; it is not treated as a SHA-256 digest.
- `source-overwritten-before-copy`, `destination-conflict`,
  `simultaneous-source-destination-race`, and
  `destination-appears-before-copy` exercise hostile 412 shapes. Every one
  returns `conditional_precondition_ambiguous`; the fixture intent is retained
  for review, but the probe never claims that a shared 412 identifies its
  source or destination cause. It performs no fresh `HEAD`, automatic retry,
  or second copy after the 412.
- `malformed-404` and `generic-404` remain `provider_response_unknown`.
  Only a parsed `NoSuchKey` is source absence.
- Separate ETag, size, content-type, checksum, version, destination-missing, and
  provider-error verification fixtures return `verification_mismatch` with a
  closed `verification_failure` after one successful copy and one destination
  `HEAD`; they never retry the copy.
- The multipart fixture models two physically possible parts: 5 MiB plus a
  smaller final part. It preserves the multipart source ETag as the source
  condition while separately binding the copy-response and destination ETag.
  Unquoted and weak ETags are also preserved byte-for-byte as hostile local
  inputs; the harness does not reinterpret them as hashes.
- `ambiguous-412` returns only the shared 412 status and follows the same
  fail-closed path. The probe records the live question instead of inventing a
  source-versus-destination discriminator.

Cloudflare documents the source conditional in the R2 S3 compatibility table
and the destination conditional as an R2 extension. The extension documentation
states that the source is checked when selected and the destination when
committed, and that these checks are not atomic. Both failures use the shared
`412 PreconditionFailed` response, so this harness does not invent a causal
discriminator:

- https://developers.cloudflare.com/r2/api/s3/api/
- https://developers.cloudflare.com/r2/api/s3/extensions/
- https://developers.cloudflare.com/r2/api/error-codes/
- https://developers.cloudflare.com/r2/objects/upload-objects/

The abstract transport receives the destination bucket and raw destination key
as separate fields. A future SDK adapter owns request-target encoding for that
key; this harness only constructs and RFC 3986-encodes the
`x-amz-copy-source` header itself. No destination preflight is part of this
state machine. Adding one or assigning it precedence remains a ratification
decision because a preflight absence observation does not close the later race.

Before production acceptance, the contract must ratify an ambiguous outcome, a
conservative precedence rule, or a different sealing protocol. Production use
of the beta destination conditional is also unratified. A separately authorized
staging proof is still required to bind the account, disposable bucket, object
keys, observed ETags and versions, parsed outcomes, timestamps, and cleanup
without recording credentials, URLs, headers, bodies, or media bytes.

Focused tests:

```text
bun test scripts/media/r2-seal-probe.test.ts
```
