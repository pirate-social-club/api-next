# Video notification destination extension — contract candidate

Status: successor proposed pending independent review and parent final adoption; specification only, October 16.
Owner task: v1-notifications-contract-api-20261016; same isolated writer.
The 43-path source handback has limited PREINTEGRATION ACCEPT, not runtime acceptance.
Its raw inventory SHA256 is ec41287e1034384b5470bbffea83148ad6468da9ffb581fc484e6e27fb58fffe.
The accepted text/song navigation contract remains byte-exact at SHA256
0b9b8c4282957eb7c190c7d97a68be13607e73f64c1cc8d53c03108ff87b4bba.
Parent selects A: existing /post/:postId primary video detail, plus mandatory persisted exact aliases for historical/future video publication links.
This candidate specifies that extension; it does not reinterpret the accepted contract as already supporting video.
Current suppression remains until reviewed API and consuming Solid implementations are jointly accepted.
Video Notifications remains required v1 coverage, not an owner-approved feature cut.

## Actual source map and missing interfaces

Paths marked N are in this linked api-next worktree; A is canonical api-next;
S is canonical pirate-web-solid, both under /media/t42/codedrive/Code/pirate-workspace.
Parent identifies Solid main594c4930, API main28f5f669 and held draft PR622/a9537ff1.
Read-only file snapshots, not Git/ref verification, ground this proposal; exact hashes accompany the task-local evidence.
The candidate does not rebase current D1 source or imply the draft's hosted dependency-install failure reached tests.

| Source | Observed boundary |
| --- | --- |
| N/A packages/application/src/post-slug.ts:12,71 | Descriptive/opaque slug allocation policy is typed for text/song; video has no source policy. |
| N packages/platform-cf/src/public-post-slug-repository.ts:318,349 | Both slug and canonical-by-ID reads join persisted post_slug_aliases; knowing a video ID does not supply an alias. |
| N db/postgres/migrations/0103_public_post_slug_aliases.sql:18,44; packages/platform-cf/src/public-post-slug-repository.ts:631 | Global slug PK, UNIQUE(post_id), logical-key checks and immutable rows; current allocator can reuse another alias or suffix a collision, so cannot guarantee receipt-exact allocation. |
| Canonical docs/specs/api-next/022-public-post-canonical-routes.md §§1,3 | post-slug-v1 is immutable generation provenance; multiple aliases/corrective uniqueness changes are outside that accepted checkpoint. New exact-video semantics need an explicit dated successor, not relabelling old rows. |
| N/A packages/application/src/use-cases/content/public-post-routes.ts:108,173 | Current detail lookup rejects types outside text/song, including an otherwise readable video. |
| N packages/contracts/src/public-post-routes.ts | Generated optional-session slug/ID reads return content plus nullable public route, or the existing wrapped age variant; route includes song activity paths. |
| N packages/contracts/src/v1.ts:2369; packages/platform-cf/src/content-repository.ts:1002 | Authenticated GetPost GET /posts/:postId can project video, including pending/unavailable media; this alone supplies no functioning browser destination. |
| N packages/application/src/video/publication.ts:636 | Published video receipts persist /posts/<encoded post ID>. This is not evidence of a matching logical alias. No receipt may be rewritten. |
| N packages/platform-cf/src/text-submission-repository.ts:156,537 | Published comment/reply href is /comments/:id; replay decodes persisted response_snapshot_bytes rather than rebuilding a destination. |
| N packages/platform-cf/src/video-publication-repository.ts:2236,2927 | Video publication writes public published posts/projections; these paths allocate no post slug alias. |
| N packages/application/src/video/access-authorization.ts; packages/platform-cf/src/video-access-authorization.ts | Playback/poster authorization checks current post/community/membership, publication revisions, rights, holds, platform safety and post/decision age floors. |
| N packages/contracts/src/video-access.ts | Poster GET and playback-access POST are media access operations, not post/comment detail destinations. Their contracts stay separate. |
| N packages/contracts/src/comment-navigation.ts; db/postgres/migrations/0269_notifications_inbox.sql | Resolver currently allows only persisted text/song aliases; shared bounded branch authorization underpins inbox/list/read and ordinary comment paging. |
| S src/routes/posts/[slug]/index.tsx; src/routes/post/[postId]/index.tsx | Real owned /posts/:slug and /post/:postId routes exist. Both currently depend on the restricted generated detail reader. |
| S src/features/posts/public-post/public-post-route.model.ts:118,183 | publicPostIdHref owns /post/<encoded ID>; nullable public route already renders content without canonical metadata. |
| S src/features/posts/public-post/public-post-route-view.tsx:118 | VideoPlayer branch exists; PublicPostEngagement with inline comments is mounted only for text/song. A player branch is not target acceptance. |
| S src/features/posts/video-feed/home-video-feed.tsx | Home video discovery is a feed, not a stable selected-video comment/thread destination. |
| S src/features/posts/post-engagement/comment-thread-api.ts, comment-thread-controller.ts | Generated immediate-child reader, 20-row paging and depth-eight presentation exist; no targeted window seeding/ancestor/focus interface exists. |
| S src/features/posts/public-post/public-post-preflight.ts, public-post-route-loader.ts; src/entry-server.tsx | Request preflight and loader ownership currently compare pathname; a comment selector/session must also fence targeted data. |

No current video route proves reachable nested comments. No /comments/:id route is present in current Solid main;
the already accepted resolving alias/controller remains a shared dependency for text/song and video.
PublicPostEngagement also gates the authenticated thread on viewer-vote readiness: targeted read success must not depend on an unrelated vote request succeeding.

## Directed primary route and mandatory exact aliases

/post/:postId is the primary video detail path independently of aliases. /posts/:segment remains a literal persisted logical-alias lookup.
Historical video publication /posts/<encoded post ID> links remain required v1 coverage; A alone does not repair them.
Reuse the owned post_slug_aliases registry/namespace without modifying old rows, but its policy CHECK and repository decoder currently admit only post-slug-v1.
Propose the minimal forward registry/owned-model extension admitting video-receipt-exact-v1 for new exact video records, with an insert guard binding that tag to an actual video and slug=post_id.
This tag records receipt-exact provenance, not a new title/transliteration/slug-generation policy. Preserve post-slug-v1 and all existing row values; no accepted migration is edited.
For an eligible video, the desired logical alias is its exact persisted post ID, decoded once from the existing receipt path and round-tripped through the owned slug codec.
No title slug policy, random alias, suffix, ID regeneration, ID inference after lookup failure or new route namespace is permitted.
The current producer chooses random post-<UUID> while persisted postId is null (packages/application/src/video/publication.ts:1484); that behavior cannot satisfy the rollback/collision identity boundary below.
Historical IDs/receipt segments must be audited, not assumed to share that shape. Invalid length/encoding/NFKC/path round trip blocks materialization; do not normalize a different identity into an alias.

The proposed ensureExactVideoReceiptAliasInTransaction in packages/platform-cf/src/public-post-slug-repository.ts must lock/validate the actual video/owned publication identity and insert exactly (slug=post ID, post_id=post ID, policy=video-receipt-exact-v1).
Use one exact INSERT with existing uniqueness enforcement, then inspect winning slug/post records; the same binding with recognized new or audited legacy provenance is idempotent success without relabelling.
The existing ensurePostSlugAliasInTransaction is not this operation: returning another alias or retrying suffix candidates would leave the immutable href broken.

| Observed persisted state | Required disposition |
| --- | --- |
| Exact binding already present | Verify video ownership/recognized policy; retain original provenance/timestamp, including audited legacy post-slug-v1; replay succeeds without another insert. |
| Neither slug nor post has an alias | Append the exact tuple atomically; no old row changes. |
| Desired slug belongs to another post/type | Hard namespace collision: retain its existing owner and normal authorized reader behavior; refuse video materialization and block live admission. No reader priority rule can make both immutable URLs identify different posts. |
| Video already has a different alias | UNIQUE(post_id) prevents appending the required exact alias. Preserve that row; block admission pending the structural successor below. |
| Invalid key, receipt/ownership mismatch or unknown commit | Record the precise internal audit category; stop/hold that item; reconcile unknown outcome by reading the exact persisted tuple. Never report a skipped conflict as completed coverage. |

If a different existing video alias is actually found, the directed coverage is impossible under current UNIQUE(post_id)/Spec022 single-alias semantics without an additional reviewed contract change. The smallest structural alternative is:
retain the global slug PK and immutable old rows, introduce an immutable primary-alias binding (post_id PK, slug FK with matching ownership) seeded from each existing row,
switch text/song canonical-by-ID selection to that binding, then replace UNIQUE(post_id) with constraints allowing only the additional exact video-receipt alias.
Keep all existing text/song canonical selections and namespace ownership exact; video primary navigation stays ID-based. No second uncoordinated alias store/lookup precedence is allowed.
That alternative must explicitly supersede the Spec022 single-alias/uniqueness checkpoint; it is not selected or authorized here. Until separately reviewed/adopted, that actual case blocks live admission.
An actual cross-post slug collision cannot be solved by that structural extension without further semantic authority; preserve both histories and hold live admission rather than choosing a winner.

Publication identity uses a fixed server-owned derivation for an unbound operation, not a random value retained only in a transaction that may roll back.
First load authoritative immutable submission_id/operation_id and all durable identity bindings; retain any already assigned/published postId and its historical receipts exactly. Conflicting/ambiguous prior bindings block reconciliation, not a new selection.
For a wholly unbound operation, K is UTF8("pirate/video-publication-post-id/v1") || 0x00 || u32be(byteLength(S)) || S || u32be(byteLength(O)) || O, where S/O are exact UTF8 bytes of immutable server-issued persisted submission/operation IDs, without normalization; u32be is a four-byte unsigned big-endian length.
Its selected postId is "post-" + lowercase hexadecimal SHA256(K):69 ASCII characters, compatible with the exact alias limits. The v1 rule is fixed for that operation even before postId becomes nonnull; it adds no title/slug policy or wire field.
Exclude actor/persona, intent, approval key, revision, time, randomness and retry count; never salt, suffix, rotate the derivation version or allocate another submission/operation to escape a blocked identity.
publishPreparedVideo must select this bound ID before intent dispatch; both original-audio and song-reference storage transactions recompute/validate it under the authoritative submission-row fence before any Post/alias write. Missing keys or a stale/conflicting proposed ID refuse and reload the existing binding.
Ordinary publication, owner approval and every scheduled/recovery path share that rule; storage must reject an old/random producer path for an unbound operation rather than trusting a caller's chosen ID. Parent must prove producer fencing before admission.
The owned publication transaction commits that same postId, Post, projection, exact alias and terminal receipt together; uniqueness conflicts must verify source ownership, never silently accept another operation's Post/alias.
On exact-alias collision or definite publication rollback, persisted postId may remain null but the next invocation derives the identical ID and remains blocked. Surface existing redacted InternalError/unavailable with cause; no replacement identity, new wire status or partial publication.
Concurrent attempts serialize on the source fence and converge on one binding. After lost acknowledgement/unknown commit, reconcile authoritative source/Post/projection/alias/receipt ownership before retry; committed state returns exact original bytes, definite rollback reuses the identical derived ID, and unresolved outcome stays held.
Historical published/durably assigned IDs are never converted to the new format. Replay never rebuilds receipts or acts as implicit alias repair; fixed derivation and existing bindings, not a request-local variable, survive restarts and approval revision changes.
Both real owner-approved publication and ordinary publication use this boundary in the existing publication/retry workers. Approved existing/missed-alias repair belongs to a maintained parent-operated API control-plane materializer using the exact allocator, not an automatic backfill cron, GET repair or unwired helper.

Existing published-video materialization requires a parent-reviewed plan before any data writes: inventory exact persisted publication IDs/href bytes and all desired slug/post collisions, including incompatible keys and different existing aliases.
Process at most50 candidate videos per (created_at,post_id) keyset batch, with durable checkpoint/audit outcomes and exact before/after binding evidence; supporting indexes must be reviewed, not presumed present, and LIMIT is not a physical scanned-history bound.
Audit inserted/already-exact/blocked-conflict/invalid/unknown separately; persist blocked items even when the scan advances, reconcile unknown commits by exact reads, and never discard conflicts as successful completion.
Perform a final race-safe namespace/coverage check under reviewed exclusion with publication before admitting the capability; live admission requires zero unresolved actual conflicts/missing required aliases.
The plan must fence all publication/materialization/alias writers in their actual lock order and prove future atomic producers are in force; its final transaction only validates completed coverage and installs admission, never performs an unbounded repair under exclusion.
There is no live DB inventory in this phase, no assertion of zero collisions, and no delegated migration/materialization. Parent owns preflight, write plan, grants/indexes and final migration review.
Alias materialization appends navigation records only; it cannot call notification delivery, reset outcomes, enqueue facts or backfill omitted video events.
Visual layout/autoplay/responsive decisions stay with the sequenced Solid/design owner; no Paper ruling, competing writer or implementation acceptance is implied.

## Exact proposed API/model boundary for A

1. Keep existing operation names/paths, auth and error families. Extend GetPublicPostCanonicalRouteById,
   GET /public/posts/by-id/:postId/canonical-route, with an explicit persisted-video branch independent of post_slug_aliases.
   It returns the existing PublicPostRouteResultV1 content variant with matching post_id/content.post.id and route:null.
   Reuse LocalizedPost/VideoPostProjectionV1 and the existing wrapped post-age variant; no compatible substitute DTO, new HTTP fetch or fabricated projection.
   Text/song ID/slug behavior stays unchanged. GetPublicPostBySlug accepts video only through an exact persisted alias bound to that video and the same current video guard; it never falls through to ID lookup.
2. The video branch uses a typed application-owned detail store in its own module, with real platform storage/composition.
   Do not alter frozen ports.ts or phase0 errors/auth/money/endpoint. Existing GetPost projection alone is insufficient authorization for this branch.
   Both primary-ID and exact-alias detail must use one read-only SQL statement, readVideoDetailSnapshotV1, selecting the literal persisted alias binding (alias mode) or actual Post ID (primary mode), with no fallback.
   That single statement captures Post/community, the exact publication/operation/creation/video/analysis/decision revision tuple, rights/holds/safety, membership/viewer lifecycle, both age floors and every LocalizedPost/video/enrichment/reference/persona-redaction field used in the response.
   Authorization must validate the same revision tuple the content projection uses. Subordinate read functions must use the statement's snapshot; no volatile helper/new connection or later contentStore/authorization read may splice in another view.
   In that boundary classify internal non-age denial, age-only denial, allowed content and malformed projection; evaluate visibility/lifecycle/rights/holds/revision integrity before an age-only result. Project no content-bearing result from a denied branch.
   Non-age denial wins when age and other restrictions coexist; content-shape validation is for an otherwise content-eligible branch. This is result precedence within the same snapshot, not reliance on SQL expression evaluation order or a second denial probe.
   Map those internal results to the unchanged wrapped post-age response, redacted NotFound, content or InternalError; invalid projection is unavailable, never invented defaults. Pure decoding after the statement may not fetch additional facts or reclassify denial.
   Existing resolvePost→getPost→authorizePublication calls, separate transactions or plain multi-query Read Committed do not prove this boundary. Do not implicitly change existing poster/playback authorization/error semantics to implement the new detail reader.
   A concurrent change may produce a wholly before-change or after-change snapshot; never authorization from one view with content, identity/redaction, revision or denial classification from another. Later requests/session fencing revalidate; this promises no instantaneous post-snapshot revocation.
3. Add VideoPostDetailPathV1 and PostDetailNavigationPathV1 in an owned nonfrozen contract module.
   PostDetailNavigationPathV1 is the union of unchanged PublicPostCanonicalPathV1 (/posts/:slug) and VideoPostDetailPathV1 (/post/:postId).
   AvailableCommentNavigationV1.post_path uses this union; every other field, discriminator and exact bare target-age response stays unchanged.
   The API-owned video encoder accepts the actual resolved bounded ID, encodes one segment, and validates a round trip through the owned route codec.
   Reject dot segments, controls and IDs incompatible with that codec; never return a path that URL normalization changes into another destination.
   The resolver validates video post_path identity against post_id. Text/song still require a real persisted alias and their existing encoder.
4. Extend ResolveCommentNavigationV1 only after the real video reader/inline consumer is accepted.
   For video, return the primary /post/<encoded ID> path, same bounded windows and exact requested target; no media URL or extra private fields.
   Missing/unsafe destination, unsupported type, current denial or missing required branch remains redacted NotFound.
   The new union is an explicit extension to the old alias-only post_path rule, not permission to change text/song destinations.
5. Factor the existing video authorization SQL facts into one shared current-read predicate, including publication/decision revisions,
   rights, unapproved holds/platform safety, membership, post rating and decision effective rating.
   Apply it to video detail, resolver, ordinary video ListPostComments and Notifications delivery/list/count/read; keep existing media endpoint behavior intact.
   Resolver ancestry/windows and this guard must share one SQL snapshot or suitable read-only isolation, not multiple Read Committed snapshots.
   Do not weaken ordinary thread authorization to make targeted lookup pass, or infer media permission from an inbox row.
6. Both primary and exact-alias video detail return route:null, omitting canonical_path, canonical URL, public structured metadata and song activity links.
   Extend the internal alias record/decoder for recognized exact-video provenance, with type/identity checks; do not change the text/song generation wrapper or expose provenance as a new public DTO field.
   Existing registry live-record and sitemap SQL currently lack a video type exclusion: before adding video aliases, explicitly retain text/song-only public canonical/sitemap selection and decoding.
   Preserve every existing text/song canonical path, activity path, sitemap eligibility/order/cursor and alias row; adding video aliases must not accidentally publish video SEO/activity metadata.
   Parent regenerates strict OpenAPI/client/provenance and reconciles its client121/release successor in actual order; no artifact is replaced here.

## Authorization, errors and lifecycle

The stored visibility vocabulary is public/members_only; there is no new private-video audience or owner override.
Public-general video detail may use the existing optional-session ID reader; comment/thread/navigation reads still require the current authenticated principal.
An invalid supplied session follows existing AuthError handling, never an anonymous authorization fallback.
Members-only, processing/draft, hidden/removed/deleted video, inactive community, invalid publication or current media hold is inaccessible to targeted navigation.
Author-only processing access in GetPost does not authorize a published comment destination. comments_locked retains its existing read/write distinction.
Age floors cannot be lowered by comment rating or an old projection: check both post and owned publication-decision ratings.
Resolver denial at the video/post or ancestor floor is NotFound; target-only age denial, after all parent/ancestor checks, is exactly bare AgeLockedResourceV1.
An independently authorized ordinary post-detail age refusal uses the existing wrapped post-age variant; never derive that reason from a media-access 404.
Hidden/removed targets refuse before age handling; siblings retain ordinary content-free age placeholders.
Account erasure does not automatically withdraw retained published content; use current permitted persona redaction, not historical account identity.
Missing/foreign/cyclic/inconsistent ancestry and denied media sources expose no post IDs, paths, evidence, internal revisions or private reason codes.
Malformed request/query uses existing BadRequest/400; unknown/missing/inaccessible target uses indistinguishable NotFound/404.
Backend/transport/invalid-response failures remain unavailable/InternalError with causes retained internally and redacted wire output; never recast them as missing.
Unknown read-command outcome permits only an explicit idempotent read retry, not implicit success. Navigation is read-only and never acknowledges an inbox item.
No playback-access creation, reward/activity, repair or publication write occurs during target GET/SSR/HEAD; normal explicit player access remains its separately owned operation.

## Solid route/controller behavior

/comments/:id is a resolving entry alias, with safe same-origin sign-in return, then the validated primary post_path plus one encoded comment selector.
/post/:postId?comment=:id and /posts/:slug?comment=:id must call the generated resolver and verify exact parent/path agreement before rendering targeted data.
For an exact video-alias entry, the generated alias result must first establish the same video post_id; require resolver post_id and primary /post/:id to match that recorded identity, not raw alias-path equality.
It may render the same video detail inline at the alias with route:null; no guessed redirect, public canonical claim or weakening of text/song path checks follows.
Do not navigate a forged post/comment pairing to a foreign thread. Duplicate or malformed selectors refuse; preserve a valid selector through allowed redirects/sign-in.
Plain anonymous /post/:id may show independently authorized public video. A comment selector uses normal guarded sign-in/return before target lookup, without an existence probe or anonymous comment windows.
The post page owns the content. Video uses existing VideoPlayer delivery states and an inline thread, not a feed sheet or a second comment article.
Published/authorized video with pending or unavailable playback can still host comments; playback readiness is not a new audience or notification eligibility rule.
Add a typed targeted-seed input to the existing controller: validated windows, ancestors, target and request/session generation, with explicit reset.
Keep it separate from pending mutation receipts; do not rewrite the broad engagement state machine or make private reads depend on vote/composer readiness.
Require distinct ancestry IDs, root termination, exact depths0..8, same post/community and one visible path member per window.
Use at most nine windows, twenty items each, bounded lookahead and indexed earlier-eligible existence; no page scan to find the target.
Seed sibling windows, expand root-to-parent in order, then focus/scroll the actual rendered published target exactly once using a safe DOM ref/identity.
A post200, fragment change or scroll without an exact target element is not success. A vanished target clears the targeted preview honestly.
Show earlier omission; View all resets to ordinary first-page paging. Continuations retain ordinary post/parent row-ID cursors, including hidden anchors.
Reauthorize the target branch before retaining seeded previews on continuation; another authorized reader may reuse the cursor, which conveys no authority.
SSR/preflight/query/hydration identity includes current session generation, principal, locale, parent and selector, not pathname alone.
Use request-local private,no-store state with existing Cookie/locale variance; never place windows or authenticated navigation in public metadata/cache.
Abort/discard stale detail, resolver, paging and focus work after sign-out, principal/persona change, proof/session refresh, route/target change or access loss.
On hydration session mismatch clear SSR windows before client rendering; browser back/forward revalidates ownership and target.
Unavailable/unknown offers finite explicit retry; 404 shows no parent from the refused resolver. A safe parent link requires an independent authorized read.
After age verification re-resolve and re-read; no stale preview becomes authorized merely because a proof action completed.

## Future Notifications admission and immutable delivery

Keep adopted fan-out: root comment→post author, reply→immediate parent author, actor excluded; authoritative persisted ownership, active accounts and current persona/privacy.
Keep sole comment_notification fact, including real owner-approved publication, and fact+recipient uniqueness, transactionality and recovery orchestration.
After paired destination admission, newly published eligible video facts may use the same durable inbox lane; no new event/channel, queue, enum or receipt field.
Use the same current video/branch/destination guard for delivery and list/unread/read; a later hold/access loss hides current entries/counts and read returns404 without deleting history.
Restoration may reveal an existing delivered row; it must not create one for a terminally suppressed fact or reset read_at/order/outcome.
Every old fact identity/payload/time, command receipt/href and terminal delivery outcome remains immutable. Do not reset markers, re-enqueue or backfill suppressed/omitted video events.
Alias materialization and notification admission are distinct operations: aliases do not change the current text/song-only delivery guard.
Before admission, drain existing outstanding comment_notification facts through the current50-fact recovery procedure with the old guard: video outcomes remain suppressed; existing delivered/suppressed receipts are only replayed/acknowledged.
Final cutover is one short parent-reviewed transaction: acquire content_publication_outbox EXCLUSIVE NOWAIT before any fact/recipient lock, excluding publication DML and delivery SELECT FOR UPDATE while allowing ordinary reads.
If exclusion cannot be obtained, abort without changing policy. Use bounded deadlines; do not wait holding recipient/comment locks or change unrelated scheduler/financial lanes.
Under exclusion verify zero outstanding comment_notification facts/private-ack repairs and complete reviewed alias/paired-consumer admission prerequisites; if any remain, abort and resume normal bounded old-policy draining outside the lock.
Only then install the reviewed video eligibility/read guard atomically and commit. No draining, alias materialization or unbounded historical work happens inside the final transaction.
Concurrent first fact insertions admitted after that commit are the new cohort, even if their request began earlier; created_at is never rewritten or used as an approximate cutoff watermark.
A recovery pass that selected a fact before cutover must only replay its now-terminal receipt, never reclassify it. Previously acknowledged missed facts must be included in the outstanding-marker drain.
Unknown commit must reconcile the installed source/transaction outcome and exact immutable receipts before retry; never blindly rerun a cohort transition or reset markers.
The final migration review must prove PostgreSQL lock order/DDL visibility, bounded aborts and concurrent publication/recovery behavior against real transactions; the stated protocol is a proposal, not a claim already implemented.
Batch LIMIT bounds returned facts, not physical scanned history; retain index/vacuum and concurrent lost-ack/replay evidence.
The exact cutover transaction/lock implementation is a required parent final-migration review dependency, not a migration or activation authorized by this document.

## Finite acceptance required after adoption

All rows are future proof obligations, not tests run in this specification phase.

| Layer/case | Required observed result |
| --- | --- |
| API/generated transport | Exact existing ID operation content/age/error variants, new strict path union/identity pairing, no ad-hoc DTO; text/song contracts unchanged. |
| API/DB primary + alias | Same authorized video renders via primary ID and exact recorded alias with route:null; missing alias404 never becomes ID lookup; primary works independently of alias presence. |
| DB alias collision | No-collision exact append, exact replay, same-post different alias, cross-post/type slug owner, invalid key and concurrent insert/unknown commit; conflicts persist in audit and block admission without changing any old row. |
| DB future publication | Both real video publication paths, including approval/retry, commit alias/Post/projection/receipt together; injected alias failure rolls back publication; restart returns exact original href bytes. |
| DB immutable ID | Fixed cross-runtime derivation vectors; both intents/approval/recovery; alias/Post collision, definite rollback with persisted postId still null, concurrent attempts, revision change and committed lost-ACK all retain one selected ID/block. Existing historical IDs/receipt bytes never rotate. |
| DB existing materialization | Finite keyset batches/checkpoints, all blocked classes retained, actual collision/coverage preflight and final exclusion proof; no GET repair or notification/event mutation. |
| API/SSR metadata | Video exact aliases add no canonical/sitemap/song activities; all existing text/song metadata, aliases, sitemap order/cursors and authorized reads stay identical. |
| API/DB real video sources | Ordinary and owner-approved root/reply facts on original-audio and song-reference videos reach the correct active recipient once; self/no-access suppression; real owned video projection, not a raw post-only fixture. |
| DB bounded target | Root and nested target beyond page20 at every level through depth8; ≤9×20 windows, exact member/ordering/lookahead/earlier existence; equal timestamps, arrivals and empty continuation. |
| DB adversarial | Cycle, duplicate/wrong depth/root, foreign post/community/parent/cursor and over-bound results refuse; current authorized cross-reader and hidden-anchor continuation remain correct. |
| API/DB revoked branch | Hidden/removed/adult ancestor, membership loss, community closure and target removal deny both targeted and ordinary video thread reads; no stale unread/target disclosure. |
| API/DB media privacy | Public/member/nonmember; deleted/hidden/processing video; current rights/hold/platform-safety/revision denial; both age floors; target-only bare age variant; no private reference/persona leakage. |
| DB detail snapshot races | Real concurrent hold, membership revoke, publication/decision/projection revision change and viewer/author erasure for primary and exact-alias reads: one complete permitted snapshot or refusal, never mixed content/guard/redaction. Combined age/non-age changes preserve denial precedence and exact age variants. |
| SSR public deep entry | Plain /post/:id public video may render with route:null/no public metadata; a comment selector takes guarded sign-in/return; adult/member cases retain existing refusal/verification boundaries. |
| SSR/hydration fencing | Concurrent accounts/targets, duplicate selector, session mismatch, refresh and late response cannot cross-seed or focus another branch; no private cache/serialized credentials. |
| Rendered desktop/phone | Actual video parent plus inline expanded ancestors and exact target focused once; pending/unavailable player honest; vote error does not erase authorized read-only target. |
| E2E navigation | Old /comments/:id and immutable video /posts/<encoded ID> receipt entries, primary/exact-alias targeted reads, sign-in return, percent normalization, text/song redirects, back/forward, View replies/all and ordinary paging. |
| E2E access loss | Sign-out/persona change, revoked membership/age/hold after lookup and during continuation cancel work and clear stale data/focus; safe retry/404/unavailable without writes. |
| DB delivery/cutover | Duplicate/concurrent delivery, crash/restart/committed lost-ack, preselected recovery, publisher blocked at final exclusion, failed lock/coverage check and unknown cutover commit; pre-extension outstanding/suppressed facts never become historical fan-out. |
| DB/transport immutability | Receipt/href/fact/ledger bytes, first read and erasure-only reference nulling retained across new support; GET causes zero delivery/read/activity writes. |
| Paired runtime | Same authenticated session reaches the real video inline target from a persisted inbox via published generated client; neither fixture fragment nor database row alone accepts v1. |

## Intake, risks and remaining choices

Parent has selected A plus mandatory persisted exact aliases as the owning source-design direction; this coherent successor still requires independent review and parent final adoption before runtime source implementation.
API author then owns typed schema/model/storage/authorization/resolver and meaningful persisted/transport proofs in its assigned source turn.
Parent owns latest-base/ordinal/index/baseline/catalog/client121/full gates and separate final migration/source review; this candidate reserves no ordinal or version.
The separately sequenced Solid writer owns alias/preflight/loader/controller/video-inline/inbox consumption and SSR/hydration/e2e evidence; no competing Paper or cloud writer.
API-only availability must not activate video delivery or fresh links before paired reachable-target acceptance; use no new live flag/binding to conceal an absent consumer.
Actual alias inventory is unknown: conflicts cannot be assumed away. A different existing video alias requires the reviewed structural extension; a cross-post slug conflict remains a hard admission block without further authority.
Remaining source proofs: storage-enforced stable identity, single-statement detail/revision/redaction classification, vote-independent target reads, audited alias publication/materialization, unchanged text/song metadata and atomic pre-extension recovery cutover.
Visual specifics remain unselected with the owning design/Solid lane. These are explicit review boundaries, not fresh owner-permission requests or claims of production acceptance.
All existing43 source files and artifacts remain unchanged; this single new document is a proposal. **QUIESCENT.**
