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

All checked-in environments keep Telegram disabled. The prepared staging configuration uses
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

Channel selection binds to the live setup intent. A selection that has expired,
was already used or was superseded is reported to the owner instead of being
confirmed as successful. A failed permission check replies with the specific
remedy: the bot needs administrator status with post, edit and delete rights,
and the selecting user must be a channel administrator. Bot membership changes
for the configured channel are recorded as readiness in the integration's last
error without changing the integration status, so a later webhook configuration
pass cannot clear a channel-level problem. Private-chat and unrelated-channel
membership changes are not readiness signals.

## Delivery and privacy

Webhook acceptance follows a durable inbox insert.Duplicate bot-epoch/update
IDs retain a tombstone after payload erasure. Queue messages contain only a
work kind and identifier. A scheduled scan repairs missing notifications.

Command replies such as `/start`, `/songs` and channel-selection
acknowledgements draw on a separate durable daily command budget rather than the
model message budget. Each command reservation is keyed to its inbox item, so a
replay does not charge twice. A per-chat lease serializes private-chat
processing across concurrent consumers and spaces consecutive processing runs
by a one-second interval. A chat that is busy or still inside the interval returns
its item to pending without spending a retry attempt and re-wakes it after the
interval. Delivery rejections carrying a Telegram retry-after delay the next
attempt instead of retrying immediately.

Cleanup and bot rotation fence running handlers. Before starting a provider
call, committing a stage result, publishing a reply or saving a conversation,
a handler verifies that its attempt still owns a processing inbox item with a
payload and that the bot epoch still matches the integration. Durable writes
take share locks on the integration epoch row and the claiming inbox row,
revalidate under those locks, and only then write. The claim must still be
inside its lease, and a write carrying a chat-lease token must still own that
lease, so an expired or superseded holder is refused. Cleanup and rotation take
conflicting locks, so persistence either commits before invalidation or
observes it and is refused. A provider call already issued when the fence trips
is left classified uncertain rather than repeated; external calls stay outside
this guarantee. Releasing a chat lease is bound to the holder token, so an
expired holder cannot release a newer holder's lease.

Publication intent and confirmed Telegram payload are separate. A failed edit
does not advance the confirmed hash. Explicit Telegram rejection preserves
`retry_after`; a timeout, malformed acknowledgement or expired send lease
requires review rather than automatically creating a duplicate. The moderation
delivery panel lets an owner confirm an existing Telegram message, confirm
that it is absent, or cancel the current operation. Confirming absence clears
the stored message ID and confirmed payload. A remaining desired publication
then becomes pending for a new send; a withdrawal becomes withdrawn without
another delete attempt. The API also accepts confirmed resolution without a
message ID when the desired payload is null, to acknowledge a completed deletion.
Confirming a delivered publication still requires its Telegram message ID. The
operator recovery list returns publication deliveries only, newest first, with
a keyset cursor over creation time and delivery id so pages do not skip rows
that share a timestamp; private reply, voice and setup deliveries are not
exposed to the owner panel.

Attempts are bounded per desired revision. Successful finalization or a changed
desired payload resets the retry counter; replaying the same failed revision
does not. Previously stranded pending rows without an error can resume, while
exhausted rows carrying a failure become failed and available for owner recovery.
Cancelling a publication suppresses that revision, but a newer desired revision
or withdrawal can proceed. Replaying the cancelled revision remains cancelled.
Private reply, voice and setup cancellations remain terminal. Sending and
uncertain operations retain their existing reconciliation fences. A newer
desired revision that arrives while an operation is sending or uncertain is
stored without disturbing that operation: the operation stays pinned to the
revision it started with, an owner confirms or discards that pinned revision,
and a differing newer revision becomes pending. Private deliveries still refuse
newer payloads while sending or uncertain.

A content-kind change requires operator review. Existing publications are
reconsidered for withdrawal when they cease to be eligible. Telegram's
message-to-delete-not-found response is recorded as deletion_target_unavailable
and requires review. It does not establish absence: Telegram's
[server implementation](https://github.com/tdlib/telegram-bot-api/blob/master/telegram-bot-api/Client.cpp)
also produces that description when message access is unavailable. Keep the
copy metadata until an operator confirms absence. The interaction between
deletion age and administrator rights remains a controlled live acceptance
check, with no universal cutoff or exemption asserted here.

The public post route authority gates all retrieved content. Reward copy uses
the existing direct-bonus and pool projections and never promises a personal
claim. Publication is one-way from Pirate to Telegram and currently sends text
and canonical app links; the public projection supplies no native media. There
is no inbound channel-post mirroring. It starts with
new posts after automatic publishing is enabled; a manual request can select
up to twenty post IDs, and an empty selection backfills the latest twenty
eligible posts.

Private raw inbox payloads and conversation text become eligible for deletion
after twenty-four hours and are removed on the next jobs cleanup. Context reads exclude
messages older than twenty-four hours and include at
most six exchanges. Private delivery payloads are also scrubbed after that
retention period. Voice downloads and synthesized audio stay transient.
Usage counters are independent of conversation retention. Speech attempts
reserve characters before contacting ElevenLabs, including retries. Usage
reservations and update tombstones are retained deliberately: both are the
replay guard for their bot epoch and neither has a deletion path; retention
bounds their content through counter expiry and payload erasure, not their
keys.

A durable provider stage is written before each transcription or completion
call. A confirmed result is reused on replay, a definite provider failure is
retried within the inbox attempt budget, and a stage left issued by an
interrupted attempt is never repeated automatically because the provider may
have processed the request. That uncertainty is resolved by a deterministic
fallback reply asking the person to send the message again. Stage rows are
deleted after twenty-four hours once their inbox item is terminal, so a
still-replayable item keeps its suppression marker.

Voice replies carry the audio without repeating the written answer, which
appears once in the text reply. Voice caption edits use Telegram's caption
method because voice messages cannot go through the generic media edit path.

OpenRouter, its selected model provider and ElevenLabs apply their own data
retention policies. No zero-retention guarantee is implied. Provider response
bodies and request URLs must not be logged: Telegram URLs include bot tokens.

## Acceptance

Local fixtures cover credential isolation, replay, webhook authentication,
durable intake, concurrent budgets, uncertain delivery leases, failed edits and
provider-stage reuse and uncertainty. The native PostgreSQL suite also covers
more than ten successful revisions, exhausted legacy rows, completed-deletion
and confirmed-absence recovery, cancelled-publication revival, same-revision
cancellation, private-delivery fences and the provider-stage lifecycle.
Membership and setup errors, pacing, cleanup fencing, owner recovery filtering
and voice presentation are implemented and covered by the native suite; live
provider, staging and browser acceptance remain open.

Repeated synthesis on a Telegram delivery retry is accepted for the current
scope: the speech reservation is per attempt, so a retry sends a new paid
synthesis request. A synthesis cache keyed to the delivery id and desired hash,
with bounded audio retention, is future work rather than part of this
hardening. The owner may direct otherwise.
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
