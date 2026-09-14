# Nationality and adult-content rollout

This is a candidate rollout procedure, not a deployment record. The API and
standalone Solid commits, their immutable client artifact, database migration
head, required CI results, and retained provider acceptance must be pinned in
the release record before execution. Do not infer release approval from local
test results or from this document.

The combined compatible client is @pirate/api-client 0.79.0, artifact
`artifacts/api-client/pirate-api-client-0.79.0.tgz`, SHA-256
`85488f318432c4ee3e124f16be406acc4a762c4953fc8f1cc58f0a2cc6e19c27`.
Older strict consumers cannot decode composed join eligibility. Keep nationality
authoring disabled until every serving Solid consumer uses the compatible
artifact and has passed provenance, session/CSRF, SSR, and browser checks.

Before staging or production execution, refresh upstream and all active migration
reservations. Verify the final ordered migration manifest, regenerated baseline,
and complete PostgreSQL partitions against the exact candidate. The lane's
historical renumbering is not permission to reuse a number another lane acquired.
Retain the existing malformed intermediate-commit caveat; required checks apply
to the final published candidate and squash result.

Quiesce publication/moderation writers and prevent public content delivery during
the adult-rating transition. Install the compatible database migrations and API
read/authority guards. Run the reviewed retained-content reconciliation procedure
in `retained-content-rating-reconciliation.md`. Unknown evidence stays held;
accepted adult evidence raises current floors without rewriting historical
responses, decisions, or prepared metadata. Verify all current holds and repaired
content before reopening public delivery.

Deploy the compatible Solid client and shared document-provider journeys. Expire
or purge retained API feed/sitemap caches and Solid sitemap caches, and verify
that current anonymous responses are no-store. Old cached responses are not
invalidated by merely deploying the new header. Check authenticated reads after
proof, account switching, cancellation, expiry, SSR, thumbnails and media ranges.
Successful proof must cause a fresh server read and must not activate membership,
claim a handle, autoplay media, or start microphone recording.

Nationality authoring requires explicit production provider bindings from the
runtime provider assembly, an explicit positive policy revision, and
`NATIONALITY_AUTHORING_EVIDENCE_LIFETIME_SECONDS=31536000`. Keep
`NATIONALITY_AUTHORING_ENABLED` off until the retained Self and ZKPassport tests
and compatible consumer rollout are accepted. The 365-day interval begins at the
accepted proof observation and stops earlier at explicit expiry, revocation, or
account/binding/requirement invalidation. It is not passport age and does not
configure 18+ verification lifetime. Never substitute mock/development providers
in production or infer a missing value as unlimited reuse.

Staging acceptance must use both real providers for nationality and document18+,
including creation, explicit join, independent qualified handle claim, and
in-place adult viewing. Retain sanitized receipt identities, deployed versions,
negative cases, and redacted command evidence. A fixture QR or mocked completion
is not real-document acceptance. Verify that nationality proof alone never
satisfies Palm or the adult-viewing requirement. Verify a permitted adult post
publishes, but remains content-free to an unverified viewer including its owner
and moderators. Paid offerings remain disabled. Public IPFS audio remains
publicly retrievable; Pirate's gate does not promise external secrecy.

Rollback is a compatible forward operation. Disable new nationality authoring
and new offering changes first. Do not restore an old strict consumer while
composed payloads remain present. Do not roll back the adult read guards while
adult content exists, lower accepted floors, remove unresolved holds, or rewrite
immutable quote/metadata history. Keep delivery quiesced until a compatible
replacement passes checks. Record final deployment identities, monitoring and
provider evidence before closing tasks or retiring the owned worktrees.
