# Community Telegram

Each community owner connects one community-owned bot and one content channel.
The bot answers private conversations after `/start`. `/songs` lists public
songs and current reward opportunities. Study, karaoke, authentication,
qualification and claims remain in Pirate. There is no Telegram account link,
group assistant or Mini App.

Owners manage the bot under Telegram in community moderation settings. The
Assistant section owns OpenRouter and ElevenLabs keys, model and voice choices,
instructions, message limits and speech limits. Credential writes require a
browser session and CSRF protection. Reads return status, never stored keys.
Replacement credentials are checked before replacing the current credential.

## Deployment configuration

All environments remain disabled. The prepared staging configuration uses
public links on `web-next-staging.pirate.sc` and webhooks on
`api-next-staging.pirate.sc`. Before enabling and deploying it, provision
the environment-specific `pirate-community-telegram-<environment>` queue and
apply the PostgreSQL migration before enabling either Worker.
The Wrangler configurations declare the queue even while the feature is
disabled, so provision the queue before deploying these configurations.

Both HTTP and jobs Workers need `TELEGRAM_PUBLIC_ORIGIN`,
`TELEGRAM_WEBHOOK_ORIGIN`, `TELEGRAM_CREDENTIAL_ACTIVE_VERSION`, and the secret
`TELEGRAM_CREDENTIAL_KEYS_JSON`. Public and webhook origins must use HTTPS.
The webhook origin is the API origin that serves `/telegram/bots/.../updates`.
The key-ring secret is an object mapping version identifiers to unpadded
base64url-encoded 32-byte AES keys. The active version must exist in the ring.
Never put wrapping keys, bot tokens or provider keys into Wrangler vars.

The staging wrapping key ring is held in the api-next Infisical project,
environment `staging`, path `/services/api-next`, under the exact secret name
`TELEGRAM_CREDENTIAL_KEYS_JSON`. Synchronize only that value to both staging
Workers. Community bot and provider credentials remain owner-entered encrypted
PostgreSQL records; they are not copied from platform provider credentials.
The staging jobs schedule runs once per minute.

Add `TELEGRAM_CREDENTIAL_KEYS_JSON` to both staging `secrets.required` lists
and enable `TELEGRAM_ENABLED=true` in both Workers only after the queue consumer,
producer bindings, migration and wrapping keys are available. The jobs
schedule performs configuration, publication reconciliation and recovery of
lost queue notifications. Its cadence determines recovery and automatic
publication latency; activation should explicitly review the current cron.
The existing production schedule is not accelerated by this change.

Rotate wrapping keys by adding a version to both Workers and then selecting
it as active. Retain old versions until all envelopes using them are replaced.
Changing a bot token creates a new bot epoch, resets channel selection and
fences pending work from the prior bot. Disconnect also fences pending work;
it leaves already published Telegram messages in place.

## Delivery and privacy

Webhook acceptance follows a durable inbox insert. Duplicate bot-epoch/update
IDs retain a tombstone after payload erasure. Queue messages contain only a
work kind and identifier. A scheduled scan repairs missing notifications.

Publication intent and confirmed Telegram payload are separate. A failed edit
does not advance the confirmed hash. Explicit Telegram rejection preserves
`retry_after`; a timeout, malformed acknowledgement or expired send lease
requires review rather than automatically creating a duplicate. The moderation
delivery panel lets an owner confirm an existing Telegram message, confirm
that it is absent before retrying, or cancel the delivery. A content-kind
change requires operator review. Existing publications are reconsidered for
withdrawal when they cease to be eligible.

The public post route authority gates all retrieved content. Reward copy uses
the existing direct-bonus and pool projections and never promises a personal
claim. Public-content publication includes canonical app links. It starts with
new posts after automatic publishing is enabled; a manual request can select
up to twenty post IDs, and an empty selection backfills the latest twenty
eligible posts.

Private raw inbox payloads and conversation text become eligible for deletion
after twenty-four hours and are removed on the next jobs cleanup. Context reads exclude
messages older than twenty-four hours and include at
most six exchanges. Private delivery payloads are also scrubbed after that
retention period. Voice downloads and synthesized audio stay transient.
Usage counters are independent of conversation retention. Speech attempts
reserve characters before contacting ElevenLabs, including retries.

OpenRouter, its selected model provider and ElevenLabs apply their own data
retention policies. No zero-retention guarantee is implied. Provider response
bodies and request URLs must not be logged: Telegram URLs include bot tokens.

## Acceptance

Local fixtures cover credential isolation, replay, webhook authentication,
durable intake, concurrent budgets, uncertain delivery leases and failed edits.
Before live activation, perform an authorized private/channel test covering
channel selection and confirmation, content publication/edit/withdrawal,
reward depletion, text/voice replies, credential replacement and disconnect.
Local fixtures and Storybook are not evidence of live provider delivery.

The voice adapter uploads MP3 through multipart form data, supported by
[Telegram sendVoice](https://core.telegram.org/bots/api#sendvoice) and
[ElevenLabs speech generation](https://elevenlabs.io/docs/api-reference/text-to-speech/convert).
OpenRouter credential validation uses its
[current-key endpoint](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key)
and rejects management keys. These provider contracts were rechecked during
local implementation review.

## Staging preparation, 2026-09-08

The staging queue was created in canonical Cloudflare account
`08a4c22cf52e2ecae883e36f80a33f4a`. A new v1 wrapping key was generated in
memory, stored under the exact Infisical custody path above and verified by
exact readback without rendering or writing its value to disk. It has not
been synchronized to the serving Workers. No community credentials were read
or imported.

A read-only staging inspection found schema `api_next` at migration `0109`.
The workspace task `community-persona-coordinated-staging-rollout` prohibits
independent deployment of descendants of the persona merge until its reset,
writer fences and paired release are verified. Telegram requires `0131` and
must follow that coordinated release, with an exact reviewed migration
manifest and runtime grants for the new tables. This preparation performs no
live migration, Worker deployment, webhook setup or provider acceptance.
