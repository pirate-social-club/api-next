# Notifications → inline comment navigation intake

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
Missing/invalid aliases and types outside existing text/song readers use the
same redacted NotFound. post_path uses a real alias and the owned path encoder.
Notifications currently suppress new delivery and omit current list/unread/read
targets for unsupported parent types, including video, while preserving all
historical facts, receipts/hrefs and terminal delivery outcomes. Video coverage
remains held pending a real owned video-navigation contract; this source repair
does not cut the feature by owner decision or establish MVP/runtime acceptance.
It is authenticated navigation data, separate from public metadata eligibility.
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
2. Preserve the comment query through canonical post redirects and use existing
   authenticated text/song detail readers. Public SEO/metadata eligibility
   stays separate from authenticated post_path.
3. Seed all bounded windows, expand ancestors in order, render then focus/scroll
   the actual inline target. Expose earlier omission and a View all reset for
   ordinary root/thread lists. Never scan pages linearly.
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
erasure, missing/invalid aliases, unsupported parent readers and unauthenticated
entry/return.

This writer changed no Solid source and enabled no fresh links. Parent must
publish a new immutable generated client, obtain paired Solid intake/acceptance
and reconcile fresh-link/capability activation. The full MVP requires durable
delivery and a reachable intended inline target in the consuming Solid runtime.
