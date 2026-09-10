# Community reads deployment and acceptance

This lane adds comment children, published song rows in public community
threads, and full-mix song listening grants. API-client 0.68.5 carries the two
new operations. It does not alter the reset manifest or authorize a deployment.

The public feed stays anonymous and no-store. Vote readback uses authenticated
GetPost. GET /posts/:postId/comments requires a user or administrator, checks
post visibility and each selected parent's ancestry, and pages immediate
children oldest first. Hidden and removed comments are excluded; adult content
uses the content-free age-locked projection. The last comment ID is the opaque
continuation locator, checked against the same community, post and parent.

Song playback checks the current published post, community, membership when
required, rating, publication decision, and sealed audio revision on every
grant and renewal. Its full_mix kind matches Karaoke's full-mix concept without
claiming a Karaoke attempt, derivative permission or purchase entitlement.
A signed GET is bearer access to bytes until expiry; it is not DRM or an
instant revocation mechanism. Grants expire after 900 seconds and renew at
840 seconds. All three existing playback budgets apply in a distinct song key
space: six source/post, 120 source, and 6000 post grants per minute.

Before enabling SONG_PLAYBACK_ENABLED in a reviewed environment, supply
SONG_PLAYBACK_R2_ACCOUNT_ID and SONG_PLAYBACK_R2_BUCKET identifying that
environment's immutable audio bucket. Supply SONG_PLAYBACK_R2_ACCESS_KEY_ID
and SONG_PLAYBACK_R2_SECRET_ACCESS_KEY through the secret runner, restricted to
GET access to that bucket. Do not use the ingress upload credential. Supply a
32-byte SONG_PLAYBACK_SOURCE_HMAC_BASE64 key and the SONG_PLAYBACK_RATE_LIMITER
binding to VideoPlaybackRateLimiterDO. The existing class is reused unchanged,
with a separate song key prefix. Development and staging configuration declare
the binding; production remains disabled and needs its own reviewed binding.
The bucket must allow the approved web origin to GET audio, including Range
requests used for seeking. No public bucket access is required.

Acceptance first verifies the paired API/schema/Solid generation, including
persona community_binding and actual HTTP transport wiring. Join before voting
or commenting; follow alone is not participation authority. Publish text, a
song with reviewed lyrics, and an instrumental, then reload and confirm feed
visibility, saved votes, comments and replies. Play, pause and seek the song;
repeat access after renewal and verify hidden, removed and inaccessible posts
do not receive a new grant. Community IDs are supported without an HNS route.
These local implementations and tests do not substitute for that live run.
