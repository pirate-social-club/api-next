# Source-song lookup contract proposal

Status: proposal, not an accepted endpoint. Source baseline: api-next a1803de3.
This document supports solid-song-source-picker without making that picker a
prerequisite for current song-flow acceptance. No runtime behavior changes.

## Existing contract and newly identified gap

packages/application/src/media/submission-service.ts defines MediaReferenceResolver
and bindMediaReference. Binding first obtains the mutation context and honors
exact replay. It passes actorUserId, submission, referenceRequestRef and
upstreamAssetId to the resolver; a null result becomes reference_binding_invalid.
The reference command remains authoritative, not a lookup result.

At this baseline, apps/http-worker/src/composition.ts constructs default
mediaServices with store, personaStore, presigner, sealer and clock, but no
referenceResolver. The optional dependency can be injected through media_services;
that is not evidence of a deployed resolver. Searching apps and packages finds
no resolver implementation. Default binding therefore throws InternalError with
Media reference resolution is unavailable. This is a separate backend hookup
blocker for real derivative acceptance, even with manual identifier entry.
Resolve it under an implementation task before claiming that live branch works;
do not make its repair depend on building the picker.

packages/domain/src/media-submission.ts requires a current unexpired action,
expected creation revision and BoundReference evidence matching the uploaded
audio revision/hash and an allowed analysis revision. A display asset identifier
alone cannot establish this evidence. Candidate lookup must never fabricate it.

## Proposed operation

Propose an authenticated, read-only lookup scoped to an owned media submission,
not a global public catalog. The implementation review must settle the final
endpoint name and generated schema before coding. Suggested shape is GET
/media-post-submissions/{submissionId}/reference-candidates, carrying persona_id,
reference_request_ref, expected_creation_revision, optional query, cursor and
limit. These are proposed fields, not an existing generated-client contract.

Require the same account, operation persona and submission access authority as
reference binding. Refuse a stale or expired reference request. Read-only lookup
must not bind a reference, increment revisions, invoke analysis, purchase rights,
or create an idempotent mutation. Use the existing browser session/proxy model.

Return only candidates the caller may discover and that the shared eligibility
policy can evaluate for this submission. Visibility and reference eligibility
are separate checks. A public title does not prove eligible reuse. The existing
resolver implementation is missing, so the exact eligibility predicate remains
an approval requirement rather than an asserted current capability.

Each item should contain the canonical asset identifier, display title,
approved public creator projection, and an explicit rights summary sufficient
for selection. Artwork and playback references may appear only through existing
authorized media projections; do not expose storage keys or invent preview URLs.
Return the request reference and creation revision with the page so the client
can discard stale results. Never expose provider recognition payloads, evidence
secrets, private ownership linkage or inaccessible candidate existence.

Selection still submits the existing reference command with its persisted
idempotency key, expected_creation_revision, reference_request_ref and
upstream_asset_id. Binding revalidates current visibility, rights and evidence.
A lookup response is advisory and cannot guarantee subsequent binding success.

## Pagination and failure semantics for review

Propose a default page of 20 with a maximum of 50 and bounded query length of
200 characters. Normalize query whitespace consistently. Use an opaque cursor
bound to query, submission, persona and reference request, with deterministic
ordering and an asset-ID tie-breaker. Review the search index and ordering
against actual persistence before choosing title relevance or another rank.
Do not leak eligibility through total counts. Cursor expiry or request change
requires restarting lookup, not silently mixing pages.

Use existing error-envelope conventions for unauthenticated, inaccessible,
stale/expired request, malformed cursor, rate limit and dependency failure.
Do not choose numeric status codes independently of the repository contract
conventions. An empty successful result is different from an unavailable
resolver. Unknown and inaccessible submissions/assets must not become an
existence oracle. Cancellation of a browser request must not create effects.

## Decisions required before implementation

Approve the candidate universe: only eligible recognition matches, or a broader
search across discoverable eligible songs. This determines whether free text
search is appropriate at all. Identify how recognition evidence maps to a
canonical source asset and how that evidence is verified by the binding resolver.

Approve rights rules for originals, covers and remixes, cross-community sources,
commercial terms and noncommercial sources. Reuse accepted domain policies;
where no policy exists, record that absence rather than infer permission from a
license label. Specify visibility/rating rules and safe display projections.

Choose final generated endpoint/schema, storage/index strategy, cursor lifetime
and error mapping. Ratification must precede runtime implementation and client
generation. The resolver hookup repair has its own acceptance obligation and
should proceed independently once its existing policy authority is established.

## Acceptance and ownership

Contract tests must prove actor/persona isolation, hidden-source nondisclosure,
stale request/revision refusal, empty-versus-unavailable behavior, stable paging
and rights changes between lookup and binding. Composition tests must use the
real configured resolver; injecting a test-only resolver cannot prove production
hookup. A real authorized derivative must bind through the deployed browser and
resume the service's actual policy/processing path before live recovery passes.

The Solid successor owns accessible search/selection and recovery UI after
contract approval. The API successor owns resolver/persistence/schema work.
Neither this proposal nor a green picker test closes ordinary song publication,
manual review, policy block, enrichment or canary acceptance obligations.
