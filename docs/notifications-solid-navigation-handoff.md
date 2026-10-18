# Notifications → inline comment navigation intake

## Current consumer guidance — 2026-10-17 supersession

The parent-adopted [video destination contract](video-notification-navigation-contract-candidate.md),
SHA256 `36e74a67ee280677436ff0d7ea7d1fd6243db3dc9432645a23a2402e2d03ec19`,
extends this intake. It supersedes the earlier text/song-only destination and
"video awaits an owned contract" guidance. The [video source handoff](notifications-video-source-handoff.md)
owns the implemented API/producer boundaries, historical proof and remaining
admission work. Video remains in adopted v1 scope. Implemented source does not
authorize the controlled eligibility cutover, serving installation, fresh links
or consuming Solid/runtime acceptance. Sealed historical records stay unchanged.

Local-proof supersession, 2026-10-17: parent executed exact source98 after its
independent preexecution acceptance. Native35 passed1348 assertions and hardening6
passed418, both with fresh exact fences and zero remaining fixture resources.
The disposable role proof includes real HTTP list/read, first Jobs and forward
deliveries, private-evidence denial and deletion/history retention. The
[video source handoff](notifications-video-source-handoff.md) binds source/log/timing
receipts; [runtime privileges](notifications-runtime-privileges.md) bounds the role
proof. Earlier UNRUN/unmeasured and5/1-failure statuses are historical.
Required full/committed review, actual six-shard CI, consumer, serving-role,
cutover and live gates remain pending; no fresh link or contract behavior changes.

Parent-authored accepted contract: workspace
.archive/v1-functional-repair-successor-20261015/adopted-feature-dispatch-20261016/comment-reply-navigation-contract-accepted.md.
SHA256: 0b9b8c4282957eb7c190c7d97a68be13607e73f64c1cc8d53c03108ff87b4bba.
Parent commit: cee4dee5b9a83889ca36327dce4f7b2391937606.
Independent review accepted those exact bytes. This is separate from runtime
and consuming Solid acceptance.

Generated ResolveCommentNavigationV1: GET /comments/:commentId/location, existing
user/admin authentication and AuthError/BadRequest/NotFound/InternalError.
Client method: get_commentsCommentIdLocation({ path: { commentId } }).
Browser requests continue through Solid's same-origin /api proxy/session.

Available fields: kind, post_id, community_id, post_path, target_comment_id,
root-to-parent ancestor_comment_ids, root-to-target windows. Window fields:
parent_comment_id, branch_comment_id, ordinary thread items,
earlier_items_omitted, nullable ordinary next_cursor. At most nine windows,
20 items each. Each starts at its branch member inclusively, with a bounded
21st-row lookahead. Earlier omission includes earlier published age placeholders
but excludes hidden/removed siblings. No earlier-page scan occurs.

One SQL statement/snapshot validates the whole branch and projects the windows.
Ordinary ListPostComments continuation now also authorizes and projects in one
snapshot, using the same exact ancestry/lifecycle guard and account redaction.
It refuses duplicate/cyclic/missing/foreign ancestry, wrong root/depth, depth
above eight, unpublished target/ancestors, inactive viewer/community, unreadable
post/membership/age and unsupported destinations. Target-only age denial returns
only existing bare AgeLockedResourceV1; post/ancestor denial returns NotFound.
Text/song retain real persisted aliases and their owned canonical path encoder.
Video `post_path` is the owned `/post/:postId`, independently of alias presence.
The generated GetPublicPostCanonicalRouteById detail operation has an explicit
video content/projection branch with `route:null`; it supplies no SEO/canonical,
sitemap or song-activity metadata. Existing text/song metadata rules remain.

Historical video `/posts/<encoded ID>` hrefs require literal persisted logical
aliases. The generated GetPublicPostBySlug read resolves only that exact record
and its recorded video identity under the same video guard. Never interpret a
segment as an ID, fall through after a failed alias lookup, suffix/reassign a
collision or require an alias for primary-ID detail. The alias may render the
same video with `route:null`; it creates no canonical claim. Missing/invalid
aliases, unsafe IDs and unsupported readers return redacted NotFound.
Both video selectors share statement-snapshot current publication/revision,
rights/hold/safety, membership, lifecycle and age authorization/projection.
Existing detail age response is wrapped; navigation target-only age stays bare.

The predecessor eligibility policy still suppresses video delivery and omits
current video list/unread/read targets until the separately reviewed atomic
old-policy drain/cutover and paired serving admission. Source includes that
controlled successor; alias materialization alone never activates eligibility
or event fan-out. After admitted cutover, delivery/list/unread/read share current
video/branch authorization and redact access loss consistently. Old facts,
receipt/href bytes and terminal outcomes remain immutable: no reset, re-enqueue
or backfill of suppressed/omitted video events. This is a hold, not a feature cut.
Authenticated navigation data remains separate from public metadata eligibility.
Deleted-account author identity is null while retained published text stays
readable. Every response is private/no-store; GET does not mark read.

Continuation is the existing row ID scoped to post and immediate parent, not
an actor-bound token. Authorized different readers can reuse it; hidden anchors
continue from their original (created_at,comment_id) tuple. Use ListPostComments
with current authorization. Re-resolve the target before retaining/replacing
seeded branch previews during continuation so target/ancestor access loss clears
stale private state.

The consuming Solid successor must implement these behaviors together:

1. /comments/:id is a resolving entry alias with authenticated safe sign-in
   return. Resolve and enter post_path + ?comment=<encoded target>. No standalone
   comment content, fabricated ID URL or fragment-only destination.
2. Preserve the comment query through text/song canonical redirects and retain
   their existing authenticated readers/metadata. Consume the generated video
   detail branch at primary `/post/:postId`, even without an alias. Exact-alias
   video entry must establish its recorded post_id and match the resolver's
   identity/primary path; raw alias equality is not identity proof. Plain public
   video detail may render when independently authorized; a comment selector
   uses the normal guarded sign-in/return and authenticated resolver. No public
   comment-window preload or new video metadata follows from `route:null`.
3. Seed all bounded windows, expand ancestors in order, render then focus/scroll
   the actual inline target on text, song and video. Detect the exact rendered
   target; a fragment, player alone or missing target is not success. Expose
   earlier omission and a View all reset for ordinary root/thread lists. Never
   scan pages linearly.
4. Bind SSR/hydration/cache/async state to session and target. Sign-out, account
   change, cancellation, NotFound, branch access/age loss must discard stale
   results/previews. No public caching or metadata for authenticated windows.
5. Only explicit inbox read commands mark read. Resolver/alias GET must not.
   Handle the bare age variant without revealing private target/ancestry.
6. Preserve historical creation/replay bytes and hrefs exactly. Only reviewed
   fresh-link/status/navigation consumers may use the new capability.

Consuming evidence must cover beyond-first-page roots/replies, depth eight,
equal timestamps, arrivals/hidden anchors, authorized cross-reader cursor use,
membership/session changes, moderation/age loss, community closure, account
erasure, missing/invalid/colliding aliases, primary video without an alias,
literal historical video entry, unsupported readers and unauthenticated entry/return.
Pending/unavailable playback must retain independently authorized inline reading;
unrelated vote failures must not erase it. Rights/holds, both video age floors,
reference privacy and deletion must fence detail, windows, continuations and focus.

This writer changed no Solid source and enabled no fresh links. Parent prepared
and package-verified immutable client0.121.0; its release/provenance binding and
paired Solid intake/acceptance remain parent-owned. Follow the current video
source handoff for exact gate failures and held cutover/serving eligibility.
The full MVP requires durable delivery and a reachable intended inline target in
the consuming Solid runtime.
