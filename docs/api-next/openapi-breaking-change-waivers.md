# OpenAPI breaking-change waivers

`packages/contracts/breaking-change-waivers.json` contains temporary,
reviewed exceptions to the append-only OpenAPI gate. An entry applies only
when all of these values match:

- `baselineSha` is the full resolved commit SHA used by the gate.
- `operationId` resolves to exactly one operation in that baseline.
- `expectedViolations` is the complete breaking-change set for that operation.

`kind` records whether the ratified transition is a `clean-break` or a
`deprecation`. `reason` identifies the governing decision. Neither field
broadens the exception.

Expected violations are compared as a sorted exact set. A missing, additional,
changed, duplicate, unkeyed, or cross-operation violation fails closed. A
waiver for another baseline is inert, so it cannot authorize a later change.

Add a waiver in the same pull request as its reviewed contract transition.
Use the pull request base commit's full SHA and copy the exact detector output
for that operation. Remove the entry after the transition lands; completed
waivers are history, not permanent gate configuration.

The former 14 operation-wide deprecations and 41 clean-break allowances covered
transitions that had already landed. This change retires them instead of
inventing baseline SHAs and expected outputs after the review fact. Their
reasons remain available in repository history and the governing task records.

## 2026-10-17 Video author redaction deprecation

Status: candidate declaration, pending independent policy review. Foundation
§5 permits an explicit deprecation entry for a breaking contract transition;
this section proposes that route for exactly the fourteen changes below.
The preceding policy history and all archived receipts remain unchanged.

The adopted video destination contract SHA256
`36e74a67ee280677436ff0d7ea7d1fd6243db3dc9432645a23a2402e2d03ec19`
requires current activity-persona/account lifecycle redaction. Retained
video/song association facts must not reconstruct erased or currently
unavailable soundtrack-author identity. Main
`6cf3018177d05c05b8e8aeaa25e81ec11e5c8799` promises required strings for
these authors; current projection truthfully returns required `string | null`.
That is a genuine response widening, not a detector false positive. Null is
not omission and no persona identifier is fabricated.

The explicit deprecation is limited to `origin_author_persona_id` and
`song_reference.song_author_persona_id` under the seven named response
locations. It does not authorize optionality, another field/type,
method/status/error, request, access/age/privacy/lifecycle or serving change;
it does not cover Notifications/video additions or another baseline. Each
JSON entry binds one baseline operation ID to its complete two-message
detector set.

Exact inventory (`items.items` retains the detector's property-plus-array-item
notation):

| Baseline operation ID | Operation | Required string → required string-or-null fields |
| --- | --- | --- |
| `get_publicPersonasPersonaIdActivity` | `GET /public/personas/{personaId}/activity` | `items.items.content.video.soundtrack.origin_author_persona_id`; `items.items.content.video.soundtrack.song_reference.song_author_persona_id` |
| `get_postsPostId` | `GET /posts/{postId}` | `video.soundtrack.origin_author_persona_id`; `video.soundtrack.song_reference.song_author_persona_id` |
| `get_feedHomePublic` | `GET /feed/home/public` | `items.items.post.video.soundtrack.origin_author_persona_id`; `items.items.post.video.soundtrack.song_reference.song_author_persona_id` |
| `get_publicCommunitiesCommunityRefFeed` | `GET /public-communities/{communityRef}/feed` | `items.items.video.soundtrack.origin_author_persona_id`; `items.items.video.soundtrack.song_reference.song_author_persona_id` |
| `get_feedHome` | `GET /feed/home` | `items.items.post.video.soundtrack.origin_author_persona_id`; `items.items.post.video.soundtrack.song_reference.song_author_persona_id` |
| `get_publicPostsBySlug` | `GET /public/posts/by-slug` | `content.video.soundtrack.origin_author_persona_id`; `content.video.soundtrack.song_reference.song_author_persona_id` |
| `get_publicPostsByIdPostIdCanonicalRoute` | `GET /public/posts/by-id/{postId}/canonical-route` | `content.video.soundtrack.origin_author_persona_id`; `content.video.soundtrack.song_reference.song_author_persona_id` |

The exact baseline raw OpenAPI SHA256 is
`40d2c1d2756381fbe6c8d6d18b5169a503e911f4f81e07109e194e1c79c8d119`.
Maintained caller tooling requires that raw identity together with the full6cf
commit before granting baseline-only historical definition ownership.
Candidates always use strict document-root references. The policy contains
the actual fourteen field-specific diagnostics; it cannot hide an unexpected
second/third field, operation/status change, missing diagnostic or
future-baseline difference.

Immutable artifact identities (no predecessor is repacked or rewritten):

| Client | Archive SHA256 | OpenAPI SHA256 | Generated client SHA256 |
| --- | --- | --- | --- |
| 0.120.0, main6cf era | `4a3acbc91610120e34deb5ed8f4e5da059baa1286a481b3a541ec546466469d0` | `40d2c1d2756381fbe6c8d6d18b5169a503e911f4f81e07109e194e1c79c8d119` | `290a8e5c134f5110af6b0c1fdaee44f158be38659a70dd47ea2d2b6a1e09c9d7` |
| 0.121.0, retained unpublished predecessor | `70c02f0a2fdc7913db52b82a627b1b0bf76e9c3d2eeb7a19770ac5f2f6d138f3` | `5e2b660bd7dae2b1e840d47dda2610dd0ed8bb0a2f835a8da278296f2990450c` | `280f26c9d99cc03d74d3c9d73bc63d68726f95c9241adaa0e27d7a3ebb0067b3` |
| 0.122.0, prepared portable successor | `f8e20a02368394ca0c41d29b0e4723ee3519057659c54c2e318002ea2e7f6c34` | `0cfc6b10f84ff0445fc7952e49672d5f381a737d8c5ef608ccbca8a74b7563c3` | `a6431a6a9e7e71c7c0ec0a057c91d2e8069075f9a77986baf75d6923965cc221` |

API source107 manifest
`20ffbe00dc94615318dbb4d9983ebc079d08e24a20a5940d7d6f9743730dc5cc`
binds the predeclaration source/client snapshot. The distinct consumer review
terminal at 2026-10-17 01:38:34 UTC accepted Solid source54 manifest
`53e769c56f5faa1d9e2f23fa939e1092d670f5c4e7d5a98a2319413f9044bfda`
/ delta9 `0c0d2638284586d74542a78b95567af9a2a91e431dc326fba8f43702d282ac3d`
for source and seven-read transition readiness only, using installed
immutable0.122 and meaningful86 cases. It permits preparation of this
separately reviewed declaration; it does not approve the declaration.
Both author fields and all seven consumers were checked without
reconstructing redacted names or identity links.

Older serving clients are outside that acceptance. Current Solid54 full
verification is a separate gate; validated source/client/backend commit and
PR bindings are still pending. A compatible paired web/API rollout and real
durable inbox/inline target/read, access-loss and BackForward acceptance are
required before serving. Independent policy/final source review, required
successor full/CI/PG gates, committed numbered271–273 migration review,
deployed-role authority, alias collision inventory and controlled
drain/cutover remain required. No financial, credential, deployment, flag or
live authority follows from this declaration or a passing local policy
diagnostic.

These seven entries are temporary and exact-baseline only. Remove them after
the transition lands. The obsolete-entry guard must reject retained entries
when their former baseline is reachable from HEAD under a later baseline;
do not renew them automatically, copy them to another baseline or widen
their expected sets without a separately reviewed transition. Historical
policy/receipt/fact/href/terminal bytes remain immutable.

## 2026-10-21 Send Palm paired-client transition

The reviewed Send source candidate a54241d1 enforces current stored Very Palm
verification before fresh reservation and submission. Its typed
verification_required success property is a real response change: pre127
clients reject the extra property in their closed object, while client127
requires it. This is not backwards compatible.

The detector now reports added fields in closed response objects, including
optional fields and nested referenced objects. The four temporary declarations
bound baselineb2df70204b3c82a32cf614d55859a24e51c54e18 to exactly that one
property diagnostic on the two Send reads, reservation and submission. The
independently reviewed transition landed through PR644 at18fdb9f2. The four
consumed entries are now retired; the active policy is empty. Historical
declarations remain in Git history and admit no later contract change.

Earlier refreshes inherited PR643's four HNS-only paths at f78b7e7c and
PR645's twenty HNS source paths at 76cd679e. The current refresh inherits
PR646's sixteen staging packaging and gateway-pin paths at b2df7020. Each
leaves the baseline OpenAPI bytes identical to 17eaa01f. The old 76cd679e
baseline receives no declaration; the exact four diagnostics are unchanged.

The genuine127 artifact remains byte-exact. Serving acceptance requires the
paired Solid consumer and verified old-tab refusal/reload handling; UI-first
ordering alone cannot establish that every open tab upgraded. Private replay,
uncertain-outcome recovery and original idempotency must survive the
transition. This source declaration authorizes no deployment, financial
execution or production Rewards activation.

## 2026-10-22 moderated Dance notification union candidate

This exact-baseline candidate awaits independent contract, genuine-client and
policy review with the Funding/Dance source. Spec021section15.11 requires a
private result notification. The response adds a Dance alternative to the
existing item union; the comment/reply alternative remains byte-exact. The
branch-comparison diagnostics do not mean comment targets lost their fields.

Against API main d032109b1ded8d0d83b9038a129c6506221354f2, the maintained guard
reports exactly the six get_meNotifications diagnostics recorded in the policy.
The candidate allows that complete set on that baseline only. Unknown or extra
changes remain failures, and the entry must retire after normal PR625 integration.

Offline execution of the genuine127,128 and129 archives proves that all three
read empty/comment-only pages;127/128 reject Dance-only and mixed pages, while129
reads both. No request left the process. Use genuine129 in the standalone Solid
notification consumer and verify old-tab reload before Dance activation. The
producer/package handoff records this paired transition; neither this candidate
nor a passing local policy gate is independent acceptance or a deployment.

October22 separately reviewed current-baseline candidate. The notification transition has not landed. Published main50f50bfacac8e49e7d75e0cec3c1ff97a4ac9a63 preserves the original d032 notification operation byte-for-byte. Recomputing the complete candidate diff against each baseline produces exactly the same six recorded diagnostics, with sorted-list SHA2569edf24d000be876fa6f59bc393b4788b5f7062e880981e587c7e671d8fabc8b0. The prospective declaration binds the actual current main50f50 baseline; it introduces no additional expected violation and changes no schema, detector, client runtime or gate. The historical d032 declaration remains in Git history and admits no later transition.

Current paired source is genuine130, including the same notification union and the participant addition, with artifactSHA25634d756f7c9f81f894e9317ce5f88c8b66729e0e1d838b0eabfdab14200f98051. Published main129 and the distinct earlier Funding129 are separately preserved; the canonical main129 namespace client is not the Dance consumer. Exact postimage and current-baseline comparison are independently reviewed before this metadata repair is consumed. Old-tab refusal/reload, participant privacy, complete required checks and the whole-PR/rehearsal/release gates remain. No source checkpoint lifts deployment, Rewards, policy-money or Mainnet holds. Retire this pending transition entry after normal PR625 integration.

PR625 landed on main as 3e0e079027a616da5ec718a7feef9d8faec5e5fe. This consumed
entry is now retired; its baseline is an ancestor of main and the obsolete-entry
guard rejects it. The declaration remains in Git history and admits no later
contract change.

## 2026-10-23 Dance reference credit deprecation

Status: candidate declaration for the current draft, pending the workspace_owner's whole-PR audit. Spec021section15.8 requires the independent public Post to carry Dance credit without a verdict, grade or private-result/evidence link. Migration0306 binds the captured public choreography revision and reference video to the ordinary input; genuine client133 admits exactly those three public fields. This declaration follows Foundationsection5's explicit-deprecation route. It is not a detector correction: adding an optional field to a closed response breaks older decoders.

The exact baseline is50f50bfacac8e49e7d75e0cec3c1ff97a4ac9a63. Seven entries each admit one complete property-addition diagnostic for dance_credit. They admit no other field, response removal, status/error/request change, access/age/privacy/lifecycle change, operation or future baseline. The existing notification transition stays separate and unchanged. The checker implementation and its exact-set/obsolete-baseline safeguards remain unchanged. Tests use the actual baseline Git artifact and candidate generated document, and reject an extra operation removal or another baseline.

October23 main inheritance successor. Main a54f2b28809d78fb33e840d60e7716d5c6879d10 adds HNS container log bounds and matching owned-file custody hashes. Its generated OpenAPI is byte-identical to50f50bfa. The candidate now incorporates that accepted main source and binds its eight declarations to the exact a54f2b28baseline. All thirteen existing diagnostics, operation IDs, reasons and refusal guards remain unchanged. This baseline renewal does not approve the pending transitions, generalize a waiver or change genuine client133. The earlier declaration remains preserved in Git history and sealed source evidence. Whole-PR owner audit and paired consumer/reload acceptance still precede activation.

| Operation | Exact closed-response property |
| --- | --- |
| GET /feed/home/public | items.items.post.video.dance_credit |
| GET /feed/home | items.items.post.video.dance_credit |
| GET /posts/{postId} | video.dance_credit |
| GET /public-communities/{communityRef}/feed | items.items.video.dance_credit |
| GET /public/personas/{personaId}/activity | items.items.content.video.dance_credit |
| GET /public/posts/by-id/{postId}/canonical-route | content.video.dance_credit |
| GET /public/posts/by-slug | content.video.dance_credit |

The field contains only choreography_id, revision and reference_video_post_id. It does not attest qualification or expose account, owner verdict, score, recording identity, private receipt, private href or provider evidence. Ordinary public Post authorization and lifecycle gates remain authoritative.

The immutable133archive SHA256 is4fb8f710fb40f6d51bdea6becb6ce96a28198a2f98eb7ccd3b01ae09c8da0676, OpenAPI SHA256545062916e74cdf984aa27393b11c61c7d89c1ff67cec88bed7db6c64cf05306. Solidbf56a517 consumes that artifact and protects the exact old/new runtime-table transition. No archive is repacked. Older open tabs must reload onto the paired consumer before Dance activation; otherwise their closed decoders refuse credited video reads or feeds. The coordinated release/activation rehearsal must prove that handoff, rather than assuming a source declaration updates a serving browser. This adds no deployment, admission, credential or financial authority. Remove the seven entries after normal PR625 integration; they are not permanent exceptions.

PR625 landed on main as 3e0e079027a616da5ec718a7feef9d8faec5e5fe. The seven consumed
entries are now retired and the active policy is empty. The declarations remain in
Git history and admit no later contract change.

## 2026-10-23 Megapot pool Base chain deprecation

Status: landed in PR656 as `abe4431d3787b83c73cb1dc5fee956512397c24b`. The
workspace_owner's October 23 decision 3 has the HTTP worker serve the offer,
funding, Claim and credit routes for the owner-executed Safe pool pilot, which runs
on Base. Megapot pool legs, pool funding and the public song pool projection
therefore admit `chain_id` 8453 beside 84532. This follows Foundation section 5's
explicit-deprecation route: an added response enum value breaks older decoders.

The exact baseline is main d85f3210427109c2a38a7fea81b0ed4be72450ac. Four entries
admit seven complete diagnostics, each an added 8453 at a `chain_id`:

| Operation | Response locations |
| --- | --- |
| GET /communities/{communityId}/posts/{postId}/rewards/megapot-pool | pool.chain_id |
| GET /reward-offer-legs/{legId}/funding/{fundingEffectId} | funding.chain_id |
| POST /reward-offer-legs/{legId}/funding/{fundingEffectId}/observations | funding.chain_id |
| POST /reward-offers/{offerId}/megapot-pool-legs (200 and 201) | leg.chain_id, funding.chain_id |

They admit no other field, operation, status, error, request change or later
baseline. Asset bonus legs, winner sends and the admitted asset catalogue stay on
84532. Existing Base Sepolia responses are unchanged. Client 0.134.0 accepts 8453
(OpenAPI SHA256 02a5dcb37bed391a2e5f19aa5013fa1a5fe717c78e340452d15bfe472cd31810); a client that accepts only 84532 rejects a Base pilot
pool, so Solid takes 0.134.0 before any Base pool opens. This adds no deployment,
admission, credential or financial authority. Remove the four entries after PR656
integrates normally.

The four consumed entries are retired from the active policy after that protected
merge. Their exact declarations remain in the historical fixture
`scripts/fixtures/openapi-safe-base-chain-waivers-20261023.json`, with the existing
exact-diff and obsolete-baseline checks retained. The active policy admits no
later contract change through these declarations.

## 2026-10-28 Single-funder ticket-first terms transition

The workspace_owner adopted the prospective single-funder rule and authorized its implementation and paired staging release on October28. New ticket-first pots return net empty-drawing winnings to the frozen single funder. Existing pots retain their original terms and holds. This is a real response-enum expansion: an older closed decoder rejects `single_funder_ticket_first_v1`.

Six exact-baseline declarations cover seven response locations at main926e2b876c56111f0975c4a62b6db7c4595a4463: the Dance capture objective terms, original contribution command receipt, current contribution's command receipt, funding context's prospective and committed terms, participant terms and Create contribution receipt. The complete detector messages are recorded in the policy. No request, status, error, other enum, field, operation or later baseline is admitted. The detector and exact-set/obsolete-baseline safeguards are unchanged.

Genuine client136 has archive SHA2565b565aff657fd7655f2bacca4704549c9e31305501aa01e407b6c702843b4cf5 and is consumed by Solid133. Existing responses retain their old values until new terms are admitted. Release the backend migrations and code while paused, release the paired frontend, verify a freshly loaded client, and only then admit the new immutable template and fund a fresh pot. Open tabs with older code must reload; their decoder refusal is not evidence of a completed payment and never permits replacing a saved command or journal.

This declaration carries the adopted rule through the maintained compatibility process; it does not expand production or funding authority. Remove the consumed declarations after API684 integration. Historical artifacts and previous declarations remain unchanged.

API684 landed as699c359bee814657e8cb9158a85a02cce0a3b78f. Its six consumed exact-baseline declarations, covering seven enum additions, are retired from the active policy. The original declarations remain in scripts/fixtures/openapi-single-funder-waivers-20261028.json for the historical closed-decoder regression proof. Later changes require their own exact-baseline review.

## 2026-10-28 Safe treasury disposition transition

The workspace_owner selected retention of net zero-qualifier winnings in the pot Safe, separately recorded as treasury funds. New safe_treasury_ticket_first_v1 terms freeze empty_winnings_recipient in the prospective and committed hashes. Existing no_purchase and single_funder_ticket_first_v1 histories retain their meaning; there is no retrospective transfer or expiry of participant credits.

At exact baseline1b8a9bb9b5683a995dba2bd5c18609af45755a61, six declarations admit fourteen complete diagnostics: seven added response enum values and seven named recipient fields in closed responses. No operation, request, status, error, other field, other enum or later baseline is admitted. The paired genuine137 client must serve before new terms admission, and older tabs must reload. Retire these declarations after acceptance.

API686 landed asdd462a97667db7d10377cf8417e7d6662926fe47. Its six consumed declarations, covering fourteen enum and recipient diagnostics, are retired from the active policy. The exact declarations remain in scripts/fixtures/openapi-safe-treasury-waivers-20261028.json and their exact-scope regression proof remains. This cleanup changes no contract, generated client, schema, runtime or authority.


## 2026-10-29 Prospective no-pose Dance transition

The workspace_owner rejected the opening pose, as recorded verbatim in v1-dance-no-pose-policy-20261029. New sessions use strict policy/profile/terms-v2 with cue none and honest attestation-v2 not_required. Existing captured v1 terms, hashes, verdicts and qualification meaning stay unchanged. These response additions are real breaks for older closed decoders.

Fourteen exact-baseline declarations cover the detector's complete20 messages against main165a59a67b4191beb22a1bd84bd7b26375363063. They admit only cue none, attestation-v2, policy-v2 and not_required at the named Dance responses. No request, status, error, other field, other enum, operation or later baseline is admitted. Exact-set matching and the obsolete-baseline guard remain unchanged. The historical fixture preserves the exact declaration; unexpected/omitted diagnostics and another baseline must refuse. Independent declaration review and final hosted checks remain required.

Genuine client139/405cdf43 preserves renewal from138 and supports these response values. The reviewed HTTP/media and paired Solid source must serve fully, and old tabs must reload, before admitting a new immutable no-pose policy. Preserve old journals and captured sessions; a decoder refusal never proves a successful write or permits replacing the command. No production, funding, credential or policy activation follows from this declaration. Retire consumed entries after PR692 lands; they admit no future contract change.

The declaration regression exposed a detector gap: it returned only the first changed value in one enum. The narrow detector repair now reports every added response or removed request value. Both new regressions fail the predecessor. The actual no-pose set remains20 messages; adding a second unreviewed cue value now fails the exact-set declaration. This does not broaden an allowance or change generated wire/client artifacts.
