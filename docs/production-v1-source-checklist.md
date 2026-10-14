# Paused production v1 release checklist

This source successor prepares the ordinary `pirate.sc` web release on API
`78280f7662438e7afded89382eadaaceb40c0396`. It enables only song upload and
playback, song-backed videos, account Study and instrumental Karaoke in the
production candidate. Rewards, guest serving, Telegram, DATA registration,
song-source recording, spoken rerecording and unrelated maintenance stay off.
Default and staging configurations are unchanged. This source PR neither
lifts the October 10 production pause nor deploys or migrates anything.

Jobs wakes every minute for media maintenance and practice recovery. The HNS
root-health job retains its own half-hour due schedule and existing production
root custody. A fresh HNS connection and phone resolver are outside the first
ordinary-host web release gate. Preserve the existing HNS ingress and renewal.

The local coordinator owns the one deployment queue. The historical pinned
HNS-only runner is not the execution path for this release. Use the maintained
API and Solid deployment tools with reviewed sources, fresh readiness and a
compatible rollback. Do not build another release runner.

1. Confirm the scoped production release decision and exact tested API and
   Solid revisions. Take a PlanetScale backup branch before production
   migrations. On an isolated production copy, rehearse the same procedure
   already proven on staging: verify the contiguous ledger, apply the exact
   missing suffix and incremental serving-role grants, then run restricted-role
   registration, Study/Karaoke, media and source-gateway preflights. The latest
   production observation was ledger 243 and the prepared source ends at 265;
   verify that suffix 0244–0265 still applies. Dormant guest schema ships with
   guest serving off. This PR adds no migration or grant.
2. Recheck production resources and retained work before execution. The
   canonical account is `08a4c22cf52e2ecae883e36f80a33f4a`; existing production
   ingress, immutable, derived and learner-audio buckets, queues and Workflows
   were observed on October 14. All production source configurations use
   Hyperdrive `0c215865d7994c92b940d905f54ece37`. Reconfirm the actual database,
   serving principal, resource names and queue/Workflow ownership. Inventory
   retained Study/spoken-answer recovery and media work before Jobs receives
   `LEARNER_AUDIO` and minute ticks. Do not replay or terminate retained work
   implicitly. Jobs' Karaoke binding targets `pirate-http-worker-production`.
3. Distribute credentials only through maintained managed tooling. All thirteen
   formerly absent v1 entries were prepared in `prod/services/api-next` and
   independently read back on October 14; no Worker synchronization occurred.
   The new immutable-bucket read pair and account-scoped Stream token passed
   bounded provider reads. The one-key R2 listing found no object, so an object
   GET remains an acceptance check. Recheck provider availability, quotas and
   the Stream signing JWK/key pairing before deployment. Public configuration
   uses canonical Stream host `customer-ma1pwa54r5492drw.cloudflarestream.com`,
   key `f9429a3e99739200172de35e525f6d75` and ACR identify host
   `identify-eu-west-1.acrcloud.com`. A successful signed ACR request verified
   that project region. No secret belongs in public vars or this document.
4. Apply the rehearsed production database suffix and incremental grants after
   confirming the backup. Run restricted-role checks against the actual main
   database before any dependent Worker deployment. The serving role also
   needs the reviewed `UPDATE` grant on `api_next.recovery_inspection_cursors`
   for the existing alignment cursor; preserve its progress and grant no
   unnecessary `INSERT`. Rehearse this narrow privilege alongside the ordinary
   function grants. Compare installed secret
   names with the exact candidate declarations below. Deploy the capability-only
   source gateway through the maintained provenance tool and verify
   `https://video-source.pirate.sc`, then deploy Media and Jobs in that order.
   PR 610 declares the gateway custom domain and Media origin; the gateway was
   absent at the last runtime read. It exposes authorized provider GETs and
   keeps workers.dev and preview URLs disabled. Recheck route ownership before
   deployment. Uploads remain closed at HTTP during these prerequisites.
5. Coordinate database PCM admission after gateway/Media/Jobs readiness and
   before final HTTP activation. Source enables both
   `SONG_VIDEO_PCM_ADMISSION_ENABLED` switches and HTTP
   `VIDEO_PCM_REFERENCE_GATE_ENABLED`; the live database
   `media_song_video_pcm_admission_policy.enabled` is a separate control.
   Before activation, verify migration 0247's instrumental qualification
   policy, learner-audio archival/deletion, Study transcription and Karaoke
   finalization/recovery privileges. Newly generated PCM, master and published
   instrumental checks belong to the post-activation song canary below.
6. Build the exact paired Solid source and preserve its same-origin `/api`
   proxy, host-only cookies, CSRF and authenticated Karaoke WebSocket forwarding.
   The last accepted Solid revision is
   `32c35aa7e1223027fd46cf32eaecd38ed688d305`; recheck the selected revision and
   ingress composition fingerprint against the existing HNS gateway manifest.
   Any gateway rotation remains a paired coordinator operation. Use Solid's
   `scripts/deploy-production-with-hns-guard.mjs` and API's
   `scripts/deploy-worker-with-provenance.ts`. HTTP appends DO migration `v6`
   for the two playback rate-limiter bindings using
   `VideoPlaybackRateLimiterDO`; this requires a full HTTP deploy, not a
   gradual version rollout. Preserve migrations `v1`–`v5` and confirm the
   currently served migration history before executing.
7. Run the ordinary-host happy path on one serving source pair: sign in, open
   a community, upload a new song with both mandatory stems, complete Study
   and instrumental Karaoke, upload two song-backed videos and decode them on
   Home. Recheck presigned browser PUT authorization and readable ETags. Live
   production ingress CORS already allows `https://pirate.sc`, `PUT`,
   `Content-Type` and exposed `ETag`; no CORS mutation is needed for this
   ordinary-host release. The checked-in wildcard PUT-only policy remains a
   separately applicable proposal. API/session CORS is unchanged. Confirm
   Rewards, guest serving and Telegram remain off and existing HNS ingress
   still works. On the newly uploaded song, verify automatic timing,
   version-bound 48 kHz stereo PCM, CloudConvert master, published instrumental
   and video-ready readback before accepting the two new song-backed videos.

| Owning Worker | Exact v1 credential declarations |
| --- | --- |
| HTTP | Existing ingress PUT presigner pair and `OPENAI_API_KEY`; `ELEVENLABS_API_KEY`, `OPENROUTER_API_KEY`; `SONG_PLAYBACK_R2_ACCESS_KEY_ID`, `SONG_PLAYBACK_R2_SECRET_ACCESS_KEY`, `SONG_PLAYBACK_SOURCE_HMAC_BASE64`; `VIDEO_STREAM_SIGNING_JWK_BASE64`, `VIDEO_PLAYBACK_SOURCE_HMAC_BASE64` |
| Jobs | `VIDEO_WORKFLOW_READ_TOKEN` alongside the existing funding RPC |
| Media | `CLOUDCONVERT_RENDER_API_KEY`, `VIDEO_WORKFLOW_READ_TOKEN`, `VIDEO_STREAM_API_TOKEN`, `ACRCLOUD_ACCESS_KEY`, `ACRCLOUD_ACCESS_SECRET`, `ELEVENLABS_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `QENCODE_API_KEY` |

The song GET pair is scoped to production immutable objects and separate from
upload credentials. CloudConvert's runtime key is media-only with
`task.read`/`task.write`; it does not substitute the operator key. Keep all
existing HNS credentials unchanged. No production Rewards or other financial
credential expansion is included.

Record every serving revision, full-deploy migration tag, release result and
rollback candidate. After suffix 265 and DO v6, rollback must use a tested
schema-compatible source; do not restore ledger 243 or delete the DO class.
Preserve the backup and historical evidence. Stop on a failed readiness or
journey check and recover through the maintained tools.
