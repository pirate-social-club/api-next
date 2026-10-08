# Telegram staging practice pilot

This source implements native read-aloud practice in one explicitly configured
community bot. It does not enable Telegram, provision a bot or admit production
rewards. Every community retains its own owner-controlled Study bot. Phase one
of the study-first amendment (Specs 006, 014 and 026, approved 2026-10-06) lets a
learner practise without website sign-in. Pirate's separate Telegram login client
still proves identity on Pirate for the optional connection of an existing
account; chat navigation grants no account authority.

## Learner journey

The learner sends /start, then /study or /songs. The curated picker lists at most
eight ready English songs. Song selection expires after fifteen minutes.

Choosing a song is the deliberate lesson start. A sender with no practice
identity is then asked one question in chat. The message says the lesson is
practice only and earns no rewards, that voice notes are required, that the
community owner can read messages and listen to voice notes, and that no
sign-in is needed. It offers "I'm 16 or older" and "I'm under 16". Only the
affirmative button, pressed by the same sender against their current unexpired
song choice, creates anything. Declining, a stale or expired button, typed text,
/study and /resume create no account. The first card follows immediately.

The bot creates or recovers the actual Study session before displaying its real
card count and first-pass threshold. A restricted learner sees no persona line.
A learner with an explicit linked-account grant keeps the earlier behaviour and
sees the linked persona's display name. Completion offers every restricted
learner the same optional "Connect an existing Pirate account" button, which
opens the existing independent sign-in, persona choice and per-bot consent
flow. The copy promises no recovery or portability.

## Restricted practice identity

Migration 0246 adds telegram_restricted_learners and
telegram_restricted_study_personas. One private learner account is reserved per
numeric Telegram user across every bot, with evidence class ingress_observed and
the community, bot and ingress generation that carried the affirmation. The
account row, minimum-age-attestation-v1 (minimum_age 16, affirmed) and the
reservation commit in one transaction. The account has no credential, handle,
membership, browser session or Telegram association.

Each community gets one new active study persona with a neutral "Learner NNNNNN"
label, bound through activity_participation. No Telegram profile data is copied
and no wallet provider is called; a pending wallet assignment reserves the
ordinary persona slot for later promotion. The existing limits apply: ten
lifetime slots and three additional personas per rolling twenty-four hours.
Exhausted limits start nothing and never reuse a sibling persona. A per-user
advisory lock makes concurrent first use, retries and other bots converge.
Enrollment rechecks the current bot, ingress generation, private-chat start and
the sender's own conversation lease. Both tables are immutable by trigger.

An explicit linked-account grant is resolved first and keeps its authority.
Without one, the sender uses the restricted identity, including when a private
account association exists: that account is not read, written or revealed. This
is a deliberate simplification of the amendment's bot-local owner wording, since
one restricted account per Telegram user gives the same isolation with one
resume path. Phase two must decide promotion for such senders.

Sessions for a restricted learner are practice only. The Telegram admission
freezes the marker, and a trigger on study_sessions_v2 refuses any session for a
restricted learner account that is not practice only, whichever path starts it.
Recovery, claiming, promotion and erasure tooling are phase-two work.

Each card shows the line's text. The learner replies to that message with a
native voice note. Telegram's reply-to-message ID must identify the confirmed
current prompt. Old or unthreaded recordings are not graded. Feedback shows
what was heard and the missing or substituted words, then the actual next card
or repeated presentation selected by Study v2. /resume repeats the current
prompt; /cancel clears pending chat actions while keeping saved Study progress.
Expiry explains how to start again. Typed text spends no attempt and never
calls the assistant. Provider unavailability asks for a new recording without
spending an attempt. Unsupported commands receive help. Unknown and old button
presses are acknowledged and explain that their lesson ended, even before
/start; no old lesson or account is imported.

## Delegation and concurrency

Only private updates from the genuine Telegram sender through the secured
webhook reach Study. An owner-controlled bot token is not identity evidence.
The private association is global to the Pirate account; Study consent is keyed
to community and Telegram bot ID with an explicit active persona and revision.
Same-bot token rotation retains completed consent and persona choice, cancels
pending work through the epoch fence, and requires fresh /start ingress.
Replacing a bot still needs consent for its new ID. Browser linking remains
bound to account, exact session and a separate HttpOnly browser cookie.

The bot has only internal Study start/read/spoken-answer delegation. It gets no
browser session, machine bearer, account-change, claim or withdrawal authority.
Each durable Study operation locks community, integration, active account,
association, consent, persona binding and chat lease in the reconnect/revocation
order. It rechecks sender, bot ID, epoch, current consent revision, active owned
persona and private-chat ingress. Existing sessions must match account, persona,
community and practice mode. Revocation between reservation and grading prevents
acceptance. A transaction cannot accept a result under consent revoked before
its locks were acquired.

Per-sender chat leases serialize updates without holding a database transaction
across provider calls. Leases expire after two minutes. Saved answer checkpoints
pin inbox, session, item, presentation and voice file before download. Retries
use the same Study idempotency command; saved replies are persisted before
queue notification. Delivery remains durable and fenced by bot epoch. Callback
tokens rotate with saved state, contain no answer, and fit Telegram's payload
limit. A second voice update replying to an old prompt cannot grade the new one.
The existing delivery uncertainty policy remains in force; the parked broad
reliability branch is not merged here.

## Practice and content admission

The new practice switch requires API_NEXT_ENV=staging, a nonempty community ID,
an explicit unique list of one to eight post IDs, transcription credentials and
the learner-audio bucket. It is false in every checked-in environment. Both HTTP
and jobs must use the same reviewed configuration during a separately authorized
activation; neither a local fixture nor source publication establishes that.

The catalogue and start-time transaction require a public published general song
in the active community, ready current lyrics, both sealed stems, an accepted
English profile and at least four current eligible say-it-back exercises.
Songs containing eligible source exercises without admitted English profile
coverage are refused instead of silently shortening Study selection. Start
rechecks publication and submission under locks. Selection, first-pass scoring,
presentation count, retries and lifetime remain owned by Study v2. There is no
four-card setting or alternate denominator.

Migration 0239 adds an immutable telegram_practice_only marker. Shared spoken
and typed completion skips qualification and projection for those sessions,
even if later continued through the website. A database trigger independently
rejects Study qualification referencing a practice session. Existing funded
offers therefore cannot retroactively reward pilot practice. Existing web
sessions retain their normal reward behavior. Apply the additive schema before
serving the changed shared Study repository, even with Telegram disabled.

## Role and activation admission

The deploy wrapper checks actual effective privileges before uploading HTTP or
jobs when Telegram, linking or practice is enabled. Both runtime constructors
repeat the guard against the actual connected role, closing direct-upload and
dashboard-flag bypasses. The check requires api_next schema access, all six
objects, SELECT/INSERT/UPDATE, DELETE only on the three temporary/link tables,
and no DELETE on consent revisions, chat progress or interface preferences. TRUNCATE and owner-equivalent
access are refused throughout.

The two restricted-identity tables need SELECT and INSERT only, and enrollment
also inserts into users, account_minimum_age_attestations, personas,
persona_profiles, persona_wallet_assignments and persona_community_bindings
through the serving role. They are not part of the six-object guard, because a
staging role with broad default privileges would fail it and silently disable
the whole bot. The bounded block is in roles.sql.example.

Migration 0240 and bounded SELECT/INSERT/UPDATE access to
telegram_interface_preferences are required whenever Telegram is enabled,
including discovery-only operation with linking and practice disabled.

The bounded operator block and verification SQL are in roles.sql.example and
telegram-linking-review-followup.md. The read-only CLI is
db:preflight:telegram-activation. Staging and production each need independent
serving-role evidence. Shared staging may need an explicit revocation of broad
default DELETE. This source authorizes no serving grants or revocations.

## Measurements and acceptance

Chat state stores at most 64 stage observations with time, card ordinal
and presentation number. It records selection, the age question, prompts, completion,
cancellation and unavailable grading. No voice inference, transcript, Telegram
profile snapshot or recording is placed in those observations. Shared Study
presentations and commands retain their existing timing and outcome evidence.
Idle chat state, including temporary reply text, is cleared after twenty-four
hours by ordinary Telegram maintenance, including when practice is disabled; the consent history remains intact. Pilot feedback must
be collected separately without inferring learner intent from recordings.

Unit, PostgreSQL and native Worker fixtures test code behavior; they establish
no actual Telegram login, microphone quality, phone-browser behavior or money
proof. Before activation, a separate ceremony must create Pirate's login client,
register exact callback URLs, provision secrets, apply schema and bounded role
permissions, verify actual bot/community/song bindings and authorize real-client
acceptance. Verify Telegram's numeric login ID matches community-bot sender ID
and the requested nonce is returned. Test email codes, Google, X and wallets in
Telegram's in-app and system browsers, including new tabs and session refresh.
The callback page must never display, log or send login code/state to analytics.
Solid owns that website journey and remains a separate source task.

Production Study content, reference-audio decisions, rewards canaries and money
release gates remain separate. Practice is the next acceptance milestone; the
owner-confirmed production goal is still earning shared Megapot pool rights
through qualifying Study with verification at claim time.
