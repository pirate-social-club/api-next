# Conditional R2 sealing evidence

This directory defines the redacted evidence shapes for the local and staging
R2 sealing proofs. With no arguments the probe is a dry run: it uses the
hostile fixture set and an in-memory fake transport, and it does not read
credentials, inspect environment variables, call `fetch`, contact R2, create a
bucket, or deploy a Worker.

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
infisical run --env=staging --path=/services/api-next/operator -- \
  bun scripts/media/r2-seal-probe.ts --execute-staging \
  --account-id <canonical-account-id> \
  --bucket <disposable-bucket-name>
```

Infisical injects only `R2_SEAL_PROBE_ACCESS_KEY_ID` and
`R2_SEAL_PROBE_SECRET_ACCESS_KEY`. Their initial `PENDING` values are deliberate
unusable provisioning sentinels; both must be replaced in staging Infisical
before execution. Each sentinel is rejected before a provider transport is
constructed, even if the other credential has already been replaced. Never
put a real credential in shell history, source, evidence, logs, or a local
environment file.

The account identifier and bucket name are public execution-target
configuration, not secrets. The runner accepts them only as the explicit
arguments above and validates them without echoing credential values. With no
arguments the entrypoint always uses the local fake transport; the acknowledged
staging invocation is the only path that reads credentials or calls `fetch`.
The staging output is projected through the closed
[staging schema](./staging-schema.json).

The staging path generates one run-specific prefix and two exact keys. It uses
a one-byte ranged `GET` to obtain a typed `NoSuchKey` for each preflight because
R2's missing-object `HEAD` response carries no typed error body. An untyped 404
still fails closed. The source upload also uses `If-None-Match: *`, so a
pre-existing key or an unknown preflight response cannot be overwritten.
It requires an already-existing bucket and never creates or deletes a bucket.
Mutation candidates are registered before each upload or copy dispatch, so a
response lost after a provider-side commit remains cleanup-owned and is never
silently omitted. PutObject signs an exact run marker in custom metadata and
CopyObject preserves that metadata. Cleanup considers only those exact
run-prefix candidates, requires the marker, matching size, content type,
checksum, and an ETag, and deletes with the observed ETag condition. A
confirmed response ETag is also rechecked when one was available. A marker,
metadata, or confirmed-ETag mismatch is a residual/inconclusive result and
fails closed.

R2 does not expose destination SHA-256 metadata after CopyObject. For the tiny
staging payload only, cleanup may therefore use an ETag-conditional ranged read
after marker, ETag, size, and content-type verification. The read is capped at
1 KiB and must equal the exact expected byte length and SHA-256 before deletion.
Evidence records this separately as `body_sha256_verified`; production media
cleanup must not inherit this small-body fallback.

The sealing sequence is deliberately narrow: one source `HEAD`, one
`CopyObject` sent as a destination `PUT` with the observed source ETag in
`x-amz-copy-source-if-match` and the beta
`cf-copy-destination-if-none-match: *` condition, and one destination `HEAD`
only after a successful copy. A 412 is recorded as shared and ambiguous. It
never triggers a destination `HEAD`, copy retry, or causal source/destination
guess. ETag, SHA-256 checksum, destination VersionId, and the distinct
`x-amz-copy-source-version-id` source VersionId are reported as separate
observations; an ETag is never treated as a checksum. HTTP 408, 425, 429, and
all 5xx mutation responses are treated as ambiguous delivery, retain their
cleanup candidates, and preserve the returned status/code.

The live runner is not authorized to contact a production bucket. The
workspace owner authorized only the disposable staging bucket. The redacted
[2026-08-24 staging transcript](./staging-2026-08-24.json) proves that the
combined source/destination conditional copy returned 200 and did not retry.
The upload returned a checksum and VersionId; CopyObject returned distinct
source and destination VersionIds. The destination `HEAD`, however, exposed
neither destination checksum nor VersionId, so the closed result is
`verification_mismatch` and the current public `sealed` contract cannot be
projected from this protocol. Cleanup verified and removed both exact run-owned
objects and proved typed absence without deleting the bucket. URLs, headers,
raw bodies, media bytes, and credentials are excluded from the transcript.

`runStagingProbe` also requires the exact `execute-staging` acknowledgement
parameter; importing it directly without that token reads neither environment
variables nor a fetch implementation. The CLI supplies the token only when
the complete argument list is exactly `--execute-staging`. Source-only and
destination-only guard modes exist only for signed-wire diagnostics; the
production sealing method always sends both conditional guards.

## Workers-binding replacement proof

The redacted [local Workerd transcript](./workers-binding-local-2026-08-25.json)
records the four replacement-protocol scenarios without contacting a provider
or reading credentials. It proves conditional source selection, distinct
destination conflict handling, trusted streaming SHA-256, destination identity
verification, and complete cleanup of the disposable local keys.

It also records a remaining platform boundary: the Workers binding accepts an
object key for deletion but no ETag or version condition. The runner checks the
complete returned identity before deleting its exclusive random key and checks
absence afterward. That is not an atomic version/ETag-fenced delete, so the
local transcript does not satisfy the production cleanup requirement by
itself.
