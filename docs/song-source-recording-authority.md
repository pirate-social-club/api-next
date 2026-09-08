# Published song recording authority

Status: reviewable proposal. Source baseline: api-next 24ad40e1. This document
does not provision an ACRCloud catalog, retain new provider data, deploy a
Worker or establish authority for an existing post.

## Problem

Reference binding now verifies that a derivative and its selected source share
one retained ACR recording identity. A source with a retained match cannot
publish without a reference, while a no-match original can publish but retains
no recording identity. The platform therefore cannot create the first eligible
source through its normal workflow.

DATA registration proves the Pirate asset identity and publication facts. It
does not create an acoustic identity, so a DATA receipt cannot populate a
provider recording identifier or stand in for recognition evidence.

## Proposed authority

Enroll an on-platform source only after it is published. Enrollment is limited
to a song whose immutable accepted terms use `commercial-remix`; other licenses
cannot produce an eligible derivative source and are not sent to the catalog.
The enrolled asset remains the publication `post_id`, matching DATA
registration's `asset_id = post_id` invariant.

Use a dedicated ACRCloud custom-file bucket attached to the same identification
project used by the media processor. The Console API accepts an audio file or
fingerprint at `POST /api/buckets/:bucket_id/files`, returns an `acr_id`, and
reports asynchronous readiness through its file reads. The identification API
then returns that identity as a `custom_files` match. The official operations
are documented at:

- https://docs.acrcloud.com/reference/console-api/buckets/audio-files
- https://docs.acrcloud.com/reference/console-api/base-projects
- https://docs.acrcloud.com/reference/console-api/accesstoken

The author never supplies the bucket, provider ID, evidence reference or share.
The source's current immutable publication, canonical audio revision and hash,
DATA asset identity, accepted license and commercial remix share are loaded from
server-held rows.

## Durable workflow

Publication atomically creates one source-registration row and one outbox item
when the source is eligible. Publication itself remains successful if later
catalog enrollment fails; derivatives against that source remain unavailable
until authority reaches `ready`.

The registration identity is deterministic from provider, asset ID, audio
revision and canonical audio hash. A worker claims the outbox with a lease and
reads the exact immutable audio object already bound to the publication. It
uploads that object with a deterministic opaque title and `user_defined`
metadata containing only the registration identity, asset ID and hash. Public
title, creator identity, community and terms are not provider metadata.

ACRCloud does not document an idempotency key for file upload. Therefore an
ambiguous or lost upload response must become `provider_outcome_unknown`; it is
never automatically uploaded again. Recovery lists the dedicated bucket using
the deterministic opaque title and accepts exactly one record whose metadata,
bucket and source fence all match. Zero records remain unresolved, and multiple
records require operator reconciliation. This prevents an uncertain response
from silently creating duplicates.

After the file reports ready, the worker submits a bounded sample from the same
canonical source through the normal identification adapter and exact production
identification project. Authority becomes `ready` only when the result is one
unambiguous `custom` match with the uploaded `acr_id` and all request, audio,
analysis, hash and adapter fences agree. Bucket readiness alone does not prove
that the identification project can see the recording.

The retained ready row contains the Pirate asset ID, provider and match kind,
provider match ID, source audio and publication revisions, canonical hash,
source terms revision, license, commercial remix share, upload evidence digest,
verification-attempt evidence reference, adapter revisions and timestamps. The
provider ID and evidence remain private. The reference resolver may use this
row as the source recording identity after rechecking that the source is still
published and eligible; it continues to derive the inherited share from the
immutable source terms rather than copying it from the authority row.

## Storage and migration boundary

Use append-only evidence plus a small mutable state row. The forward migration
adds source-registration, attempt and outbox tables, closed status and failure
codes, immutable identity guards, claim fencing, and a uniqueness constraint on
provider/bucket/provider-match identity. It also adds the publication trigger
or repository write that creates the registration atomically with publication.

Migration `0134` is already reserved by the rewards qualification lane. The
implementation must re-read the live migration directory immediately before it
reserves its own ordinal; `0135` is only the current expected next value.

The worker configuration requires separately scoped names for a Console API
token and custom bucket ID. The identification access key and secret are not
Console API credentials. Startup must also pin the Console API origin and bucket
region, and deployment verification must prove that the bucket is attached to
the exact identification project. No broad account token or bucket-discovery
permission is accepted at runtime.

## Removal and provider retention

Permanent custom-file enrollment is a new data-retention effect. Existing ACR
identification approval covers bounded samples sent for recognition; it does not
by itself decide how long canonical source audio or its provider fingerprint may
remain in a custom catalog.

Before enabling enrollment, approve one retention rule. The recommended rule is
to retain the provider fingerprint while the post is published and its immutable
commercial-remix terms remain referenceable, then enqueue deletion on an
authorized takedown. A failed or ambiguous delete keeps the authority unavailable
and alerts an operator. Post hiding alone should disable new bindings immediately
even while provider cleanup is pending.

If permanent provider-side audio retention is unacceptable, the implementation
must upload a locally generated ACRCloud-compatible fingerprint instead. No such
generator is present in api-next or its Worker runtime today, so that choice is a
separate implementation dependency rather than a configuration change.

## Fail-closed outcomes

Missing catalog configuration leaves source registration disabled and visible
in health evidence. Provider rejection, malformed responses, mismatched bucket
or project, readiness timeout, ambiguous upload, verification mismatch and
retention-cleanup failure never create recording authority. They expose typed
private operational states and stable public source-unavailable behavior.

This proposal does not admit off-platform works, author declarations, title
matching, provider-music matches without a Pirate mapping, manual rights
approval or a default upstream share. Those remain separate policy work.

## Acceptance

Local tests must prove publication atomicity, exact source fences, lease loss,
ambiguous upload recovery, duplicate refusal, readiness polling, project-visible
custom identification, immutable terms, resolver use of ready authority, hidden
source refusal, and takedown cleanup state. PostgreSQL tests must exercise the
real migration and trigger/guard behavior.

Staging acceptance requires a dedicated project-owned source, an approved
nonzero commercial remix share, the reviewed bucket/project binding, and the
same serving API throughout registration and the derivative. Evidence must show
one source post, one ready authority, one derivative binding that inherits the
source share, one derivative post and no duplicate provider file or Pirate post
after replay. Provider enrollment and identification are live effects and cannot
be replaced by seeded database rows.

## Current external inputs

The 2026-09-08 name-only secret inventory has ACRCloud identification access key
and secret in staging, but no Console API token or custom bucket identifier.
Production has neither identification credentials nor catalog credentials. The
catalog bucket/project relationship and provider retention rule are also not
approved. Runtime implementation can be reviewed behind a disabled boundary,
but live source authority and derivative acceptance cannot pass until those
inputs exist.
