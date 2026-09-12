# Provider budget for the local fixture journey

Enforced by the local media processor entrypoint at
`.tmp/local-pair/media-processor/entrypoint.ts`. Every outbound fetch whose
host matches a provider suffix is counted for the life of the wrangler dev
session, which includes workflow retries and recovery replays of the same
stage. A request over the cap logs `provider-budget-exhausted` and throws, so
the workflow step fails and the run stops with evidence instead of spending
further.

| Provider | Host suffix | Hard cap |
| --- | --- | --- |
| ACRCloud identify | `acrcloud.com` | 2 |
| OpenAI moderation | `api.openai.com` | 3 |
| OpenRouter classifier | `openrouter.ai` | 1 |
| ElevenLabs alignment | `api.elevenlabs.io` | 1 |

Total hard cap: 7 provider requests per session. Each cap allows one retry for
its stage.

Expected consumption for the instrumental fixture (no lyrics): one ACRCloud
identify request and one to two OpenAI moderation calls. The OpenRouter
classifier and ElevenLabs alignment are gated on lyrics and are expected to
remain at zero; their caps exist only to stop an unexpected path.

Evidence: `journalctl --user -u song-local-processing.service` contains one
JSON `provider-request` line per call with the provider, host, running count
and cap, and a final `provider-budget-exhausted` line if a cap is crossed.
Restarting the session resets the counters. R2 remote-binding operations are
not counted here; they mutate the staging ingress, immutable and derived
buckets as configured and are bounded by the single fixture upload.
