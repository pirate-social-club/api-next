# Video safety provider composition — 2026-09-06

This tranche composes the existing pinned OpenAI image and text moderation ports.
It does not select or invent a visual minor-safety provider. Spec 010's separate
acceptance/data-handling gate and Spec 013's minor-safety evidence constraint mean
media allow remains unreachable. Clean frames yield review_required with null
minorSafetyEvidenceRef. An otherwise eligible original-audio staging video needs
moderator approval of its safety hold before publication. The existing API can
perform approval; API-only proof approvals versus a minimal owner-only Solid
action remains an owner decision. No moderation endpoint or wire contract changes.

## Execution and evidence

The runner passes submission, operation, community, video and creation identities
plus the declared rating into safety. Frames are read in poster, first, midpoint
order from the derived bucket, with JPEG metadata, the sealed digest and the
512 KiB per-frame bound checked before evaluateImage. The shared bounded stream
reader is reused from song processing. Derived reference parsing is shared with
the existing stage artifact HEAD verifier. The adapter independently verifies
the input digest. A normalized non-null caption receives one evaluate call.

This produces three ordered image calls and at most one caption call, bound to
video-safety-<operation>-c<creation>. It is an explicit interim divergence from
Spec 010's single-request wording: batching would change the existing adapter's
song-cover evidence shape. Each normalized input result retains provider id,
requested/returned model, input digest, categories, scores and applied types.
The aggregate evidence reference hashes those ordered results and policy facts.

The existing community policy resolver supplies severity precedence and automated
rating. Policy identity hashes the current provider, platform and community
revision/hash set; the original revisions and tables remain in private evidence.
A known sexual/minors hard-floor signal blocks and records a private hold even
when another input is unavailable. Other unavailable/malformed/failed inputs
remain review_required and mark adapter revision safety-unavailable. No failure
text, image bytes or caption text is retained in normalized evidence. Persistence
errors remain infrastructure errors for Workflow retry rather than being turned
into accepted provider failures.

## Private storage prerequisite

Shared platform moderation cases accept only text_post, comment and reply.
Video review holds encode moderator actions, not automatic platform cases.
The execution record therefore reserves 0125_video_safety_evidence.sql after
checking origin main 6269ac2a (through 0123) and delivery's separate 0124 claim.
Delivery's file is neither copied nor modified. Integration must restore ordered
0124/0125 inventory before either later migration is applied to an environment.

One creation-bound immutable row retains the complete normalized evidence and
resulting safety fact, with platform_held for the automatic sexual/minors hold.
The insert locks current processing(analysis) submission authority. Identity,
size, no-visual-allow and hold/block checks fail closed. Identical replay succeeds;
a divergent snapshot or input digest is rejected. The provider reads the retained
fact before repeating calls, including a crash after this transaction but before
the separate stage-fact write. The hold marker and evidence cannot commit apart.
This private hold is not added to the owner approval queue or public projection;
no operator resolution endpoint is introduced in this tranche.

## Composition and limits

The media-processor constructs safety from its existing OpenAI secret when
OPENAI_MODERATION_ENABLED is true, retaining transport injection only for tests.
The new flag is false in every checked-in environment, and video stays disabled.
The only remaining adapter-only video provider is recognition; enabled video
without it fails construction with an explicit recognition error. The obsolete
hash port is removed: source verification already uses the seal digest and R2
identity. No second hashing provider or visual evidence placeholder is added.

Owner decisions remain ACR sampling, visual minor-safety provider acceptance and
data handling, staging approval process/surface, gateway hostname, Workflow read
token provisioning, reason-code waiver and reservation lifetime/cleanup policy.
No deployment, credential mutation, real provider request, client release or
video activation occurred. Full PostgreSQL and required remote gates remain due
at PR preparation; this commit is a local safety checkpoint.

## Validation

The composed queue and exported Workflow class run with fake OpenAI transport
responses and real safety/application/repository code. The four named composed
safety cases cover clean review, sexual/minors block with the private hold row,
caption review and unavailable transport. All 19 composed cases passed. The
focused private-evidence/foundation/migration PostgreSQL run passed 20 tests and
225 assertions. The Workerd gateway/safety run passed 13 cases, including sealed
R2 frame read followed by genuine global fetch, manual redirect mode, and refusing
a redirect target. These are runtime compatibility tests, not live provider
qualification; synthetic JPEG bytes and fixture moderation results are explicit.

Initial attempts exposed a composition construction-order regression, an
unavailable fetchMock test API, and a PostgreSQL connection attempt before the
owned container was ready. They were corrected by preserving the Qencode
provisioning fence order, using the existing MSW network interception precedent,
and waiting for the local database to accept connections. Intermediate TypeScript
errors were repaired without unsafe casts. Check now exits 0, focused suites
pass, and ordinary-suite completion is recorded below. Workerd emitted a
pump-canceled diagnostic while rejecting an R2 mismatch; all assertions passed.


The final check command exited 0. Final ordinary tests exited 0 with 3,049 Bun,
20 Node and 154 Workerd cases. The final focused provider/composition/executor
unit run passed 23 tests with 402 assertions, and the final composed run passed
all 19 cases. The focused PostgreSQL run exited 0 with 20 tests and 225
assertions. Script-check reported zero findings. No full PostgreSQL or remote
check was substituted or claimed for this local commit.

The ordinary suite initially rejected the new PostgreSQL test because its file
was not yet tracked while its manifest entry existed; staging that exact file
resolved the inventory failure. A final boundary review added a 12 KiB cap per
normalized provider result, tested with an oversized but schema-valid response.
Such input becomes safety-unavailable before it can exceed the private row's
64 KiB ceiling. All final checks ran after that correction.


## Integration ordinal supersession — 2026-09-06

Control-plane commit c2c8111b records execution first as 0124 and delivery
renumbering its own migration to 0125 at rebase. Fetched origin f1a548a3 ends
at 0123. The earlier 0125 safety filename records historical checkpoint order;
the unmerged safety migration now becomes 0124 before integration. This changes
no table semantics. Checksums, baseline and reset SQL regenerate with the rename.
Sampling is now directed to two independent MP3 clips using the song windows;
recognition is not implemented in this safety integration. The staging proof
uses authorized coordinator API approvals, with no Solid approval action.

The ordinal preparation passed baseline regeneration, bun run check and the
focused migration/foundation PostgreSQL gate (17 tests, 215 assertions), all
exit 0. Normalized schema.sql and test-reset.sql regenerated without a content
diff, since the table semantics are unchanged. The foundation inventory now
asserts the 0124 safety filename and rejects the former 0125 filename.
Script-check reported zero findings. Integration rebase and its full gates follow.
