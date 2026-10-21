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
bind baseline17eaa01f1415c839f3fd14f67de610b370c41c8d to exactly that one
property diagnostic on the two Send reads, reservation and submission. No other
request, response property, error, status, operation or later baseline is
covered. Independent review of these declarations is required before
integration; they are retired when that transition lands.

The genuine127 artifact remains byte-exact. Serving acceptance requires the
paired Solid consumer and verified old-tab refusal/reload handling; UI-first
ordering alone cannot establish that every open tab upgraded. Private replay,
uncertain-outcome recovery and original idempotency must survive the
transition. This source declaration authorizes no deployment, financial
execution or production Rewards activation.
