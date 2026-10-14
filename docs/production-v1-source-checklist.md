# Paused production v1 source checklist

Prepared from `main` at `b8efd833af7e9729c1e988f81aa8804776cf74fe`.
This PR prepares HTTP/jobs/media configuration for songs, videos, account Study
and instrumental Karaoke. All existing v1 product gates stay OFF, including
both PCM admission switches and CloudConvert rendering. Rewards and
`GUEST_STUDY_SERVING_ENABLED` are explicitly OFF. HNS, Telegram, database
migrations, contracts and generated clients are unchanged. No live provider
state has been verified or changed here. The local coordinator retains the
credentials, provider operations, database, DNS and deployment queue.

- [ ] **Storage and Worker resources:** verify canonical account
  `08a4c22cf52e2ecae883e36f80a33f4a`, private production ingress/immutable/derived
  R2 buckets and `pirate-learner-audio-production` (shared by HTTP and jobs).
  Verify media-processing primary queue/DLQ and the media/video-analysis/Study
  Workflows against their production names and owning Workers in the configs.
  Jobs' Karaoke binding must target `pirate-http-worker-production`. HTTP's
  `SONG_PLAYBACK_RATE_LIMITER` and `VIDEO_PLAYBACK_RATE_LIMITER` both use
  `VideoPlaybackRateLimiterDO`; creating that class through appended migration
  `v6` requires a **full HTTP deploy**, never a gradual version rollout. Verify
  deployed migration history first; `v1`–`v5` are retained verbatim.
  The learner-audio binding also admits retained spoken-answer recovery on the
  existing jobs cron even with product flags OFF; verify its database privileges
  and retained work before a later deployment. The HNS cron cadence is unchanged.
- [ ] **Gateway and database drift:** all four production source configurations
  already use Hyperdrive `0c215865d7994c92b940d905f54ece37`. Verify the serving
  versions, production database/schema and serving-role privileges, including
  the source gateway's grant/excerpt/PCM-admission reads. A different deployed
  Hyperdrive is runtime drift to reconcile locally, not another source ID fix.
  Gateway deployment/existence and reachable `VIDEO_SOURCE_GATEWAY_ORIGIN` are
  **unknown**. Its source disables workers.dev and declares no custom route;
  the coordinator must select and verify public capability-only ingress for
  provider GETs. Do not invent a workers.dev URL or expose storage credentials.
- [ ] **Provider values:** `VIDEO_STREAM_CUSTOMER_HOST`,
  `VIDEO_STREAM_SIGNING_KEY_ID` and production `ACRCLOUD_IDENTIFY_HOST` are
  **unknown** and remain empty. Verify the production Stream key/JWK pairing,
  account scope and ACRCloud project region. Verify provider access, quotas and
  the staging-matched Study model `google/gemini-3.8-flash`; configuration is
  not evidence of live availability. The prepared video safety policy is
  `sampled_frame_openai_v1`.
- [ ] **Exact credential distribution:** verify/install only the names below
  using existing secret tooling. No values are present in this PR. Production
  Infisical admission is optional inventory, not provisioning or activation;
  Wrangler declarations describe the prepared candidate. Compare installed
  names with the candidate before any later deployment.

| Owning Worker | Prepared v1 credential declarations |
| --- | --- |
| HTTP | Existing ingress PUT presigner pair and `OPENAI_API_KEY`; `ELEVENLABS_API_KEY`, `OPENROUTER_API_KEY`; `SONG_PLAYBACK_R2_ACCESS_KEY_ID`, `SONG_PLAYBACK_R2_SECRET_ACCESS_KEY`, `SONG_PLAYBACK_SOURCE_HMAC_BASE64`; `VIDEO_STREAM_SIGNING_JWK_BASE64`, `VIDEO_PLAYBACK_SOURCE_HMAC_BASE64` |
| Jobs | `VIDEO_WORKFLOW_READ_TOKEN` alongside the existing funding RPC |
| Media | `CLOUDCONVERT_RENDER_API_KEY`, `VIDEO_WORKFLOW_READ_TOKEN`, `VIDEO_STREAM_API_TOKEN`, `ACRCLOUD_ACCESS_KEY`, `ACRCLOUD_ACCESS_SECRET`, `ELEVENLABS_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `QENCODE_API_KEY` |

The song GET pair must be scoped to production immutable objects, separate
from ingress upload credentials. The CloudConvert runtime key is media-only
with `task.read`/`task.write`; it never substitutes the operator's
`CLOUDCONVERT_API_KEY`. Retain existing HNS credentials unchanged. No Rewards,
guest, Telegram or operator credential expansion is included.

- [ ] **PCM admission and instrumental Karaoke:** coordinator verifies the
  existing migration suffix and runtime-role admission with maintained
  database preflights; this PR adds/applies no SQL migration. Verify
  `media_song_video_pcm_admission_policy.enabled` separately from jobs/media
  `SONG_VIDEO_PCM_ADMISSION_ENABLED` and HTTP `VIDEO_PCM_REFERENCE_GATE_ENABLED`.
  Both Worker switches and the HTTP gate are OFF in source; live database policy
  and migration/grant readiness are **unknown**. Later activation must coordinate
  the database policy and both Worker switches. Require a newly uploaded song's automatic timing,
  version-bound 48 kHz stereo PCM reference, video-ready readback, verified
  CloudConvert master and playback before admitting song-video traffic.
  Verify the existing instrumental qualification policy (migration `0247`),
  published instrumental artifact, account Study audio archive/transcription,
  Karaoke finalization/recovery and learner-audio deletion privileges.
- [ ] **Upload-ingress CORS proposal:** maintained
  `infra/cloudflare/song-production/media-ingress-production-cors.json` now
  proposes origin `*`, method `PUT` only, allowed header `Content-Type`, exposed
  `ETag`, and a 3,600-second preflight cache. Live bucket CORS is **unknown**;
  only the coordinator applies and reads it back. API/session CORS stays
  unchanged. Verify a presigned browser PUT from the paired production Solid
  origin before uploads are enabled.
- [ ] **Paired Solid/gateway change and later execution:** Solid owner prepares
  its same-origin `/api` proxy, including authenticated Karaoke WebSocket
  forwarding, host-only cookies and CSRF, against this API candidate. Retain
  HNS ingress/handle-host routing. Review the resulting Solid ingress
  composition fingerprint against the HNS gateway manifest and both gateway
  deployment references; any required gateway/Solid update is paired and owned
  by the coordinator. Exact paired Solid head and live gateway manifest are
  **unknown**. Use API `scripts/deploy-worker-with-provenance.ts` and Solid
  `scripts/deploy-production-with-hns-guard.mjs` after accepted source and a
  coordinator release decision. The historical HNS-only pinned runner is not
  this v1 release. Preserve their existing guards and record serving/rollback
  versions. No new runner, merge, auto-merge or deployment is authorized by
  this preparation PR.
