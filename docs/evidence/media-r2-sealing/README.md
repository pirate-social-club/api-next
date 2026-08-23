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

## Disposable staging runner

The same entrypoint has an explicit, mutating acknowledgement for a future
disposable staging run:

```text
R2_STAGING_ACCOUNT_ID=... \
R2_STAGING_ACCESS_KEY_ID=... \
R2_STAGING_SECRET_ACCESS_KEY=... \
R2_STAGING_BUCKET=... \
bun scripts/media/r2-seal-probe.ts --execute-staging
```

The values above are placeholders and must never be put in shell history,
source, evidence, or logs. The runner validates the four required environment
variables without echoing any value. With no arguments the entrypoint always
uses the local fake transport; the staging flag is the only path that reads
credentials or calls `fetch`. The staging output is projected through the
closed [staging schema](./staging-schema.json).

The staging path generates one run-specific prefix and two exact keys. It
checks both keys before writing and uses `If-None-Match: *` for the source
upload, so a pre-existing key or an unknown preflight response fails closed.
It requires an already-existing bucket and never creates or deletes a bucket.
Mutation candidates are registered before each upload or copy dispatch, so a
response lost after a provider-side commit remains cleanup-owned and is never
silently omitted. Cleanup considers only those exact run-prefix candidates,
requires matching size, content type, checksum, and an ETag, deletes with the
observed ETag condition, and verifies absence. A mismatch or missing safety
fact is a residual/inconclusive result and fails closed.

The sealing sequence is deliberately narrow: one source `HEAD`, one
`CopyObject` sent as a destination `PUT` with the observed source ETag in
`x-amz-copy-source-if-match` and the beta
`cf-copy-destination-if-none-match: *` condition, and one destination `HEAD`
only after a successful copy. A 412 is recorded as shared and ambiguous. It
never triggers a destination `HEAD`, copy retry, or causal source/destination
guess. ETag, SHA-256 checksum, destination VersionId, and the distinct
`x-amz-copy-source-version-id` source VersionId are reported as separate
observations; an ETag is never treated as a checksum.

The live runner has not been authorized to contact a production bucket. The
current staging account is not entitled to R2, so no `--execute-staging` run
was performed in this tranche. The local and injected-fetch tests exercise
signing, request construction, hostile responses, redaction, and cleanup
without a network call. A future transcript must bind only the run/account/
bucket/key identities, statuses, parsed codes, timestamps, ETags, checksum and
version observations, and exact cleanup results. URLs, headers, bodies, media
bytes, credentials, and raw provider responses are excluded.

`runStagingProbe` also requires the exact `execute-staging` acknowledgement
parameter; importing it directly without that token reads neither environment
variables nor a fetch implementation. The CLI supplies the token only when
the complete argument list is exactly `--execute-staging`. Source-only and
destination-only guard modes exist only for signed-wire diagnostics; the
production sealing method always sends both conditional guards.
