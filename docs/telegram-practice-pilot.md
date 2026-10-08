# Telegram staging practice pilot

This source implements native read-aloud practice in one explicitly configured
community bot. It does not enable Telegram, provision a bot or admit production
rewards. Every community retains its own owner-controlled Study bot. Phase one
of the study-first amendment (Specs 006, 014 and 026, approved 2026-10-06) lets a
learner practise without website sign-in. Pirate's separate Telegram login client
still proves identity on Pirate for the optional connection of an existing
account; chat navigation grants no account authority.

## Learner journey

The flow follows the legacy bot. The learner sends /start and sees "Choose a
song to study:" with at most eight ready English songs as buttons, and nothing
else. /study and /songs show the same list, and the menu offers one "Songs"
action. Song selection expires after fifteen minutes.

Tapping a song is the deliberate lesson start. It issues the sender's practice
identity if they have none and shows the first prompt, with no question,
website step or sign-in. Typed text, /study and /resume create nothing. No age
question is asked; the workspace_owner removed it on 2026-10-08. Buttons left on
screen by that question are answered as stale choices.

A prompt is the localized instruction and the line, for example "Say this
back:" followed by the lyric. It carries no card count, threshold, persona or
command footer, and nothing follows the line. The bot says nowhere, in a
prompt, in /help or elsewhere, who can hear a learner's voice notes: the
workspace_owner removed that notice completely on 2026-10-08, after it had
moved from the welcome line to the first prompt. A decision to release Telegram
practice to production has to take that into account. The learner answers by
replying to the prompt with a voice note. The verdict is its own short message,
sent as a reply to the voice note:
"✅ Correct", or "❌ Incorrect" with what was heard, or a request to record
again. The next prompt follows as a separate message. The two are stored as
separate deliveries, and the prompt is ordered after the verdict, so a retry or
a queue reordering cannot swap them. Completion is "🎉 Lesson complete!" and
the first-try score, for example "8/10 correct on the first try.", with two
buttons: "Choose a song", which shows the song list, and "Practice again",
which starts a new lesson on the same song and expires with the song choice
after fifteen minutes. /resume on a completed lesson shows that ending again
with fresh buttons and a new fifteen-minute choice window; it does not restart
the lesson. Once the session has expired, /resume instead explains how to start
again. Nothing restarts by itself and nothing links to the website. The optional
account connection is not offered at completion, because
the Telegram login it leads to still fails.

## Restricted practice identity

Migration 0246 adds telegram_restricted_learners,
telegram_restricted_study_personas and telegram_restricted_bot_affirmations. One private learner account is reserved per
numeric Telegram user across every bot, with evidence class ingress_observed and
the community, bot and ingress generation that enrolled the learner. Those three
columns are still named affirmed_*, from the removed age question; renaming
them would break a deployed Worker for no gain. The account row and the
reservation commit in one transaction. No minimum-age attestation is written,
because none is asked for, so these accounts carry no age assertion. Any later
promotion to a full account must collect it then. The account has no
credential, handle, membership, browser session or Telegram association.

telegram_restricted_bot_affirmations holds the per-bot answers recorded while
the age question existed. It is kept as history and is no longer read or
written.

Each community gets one new active study persona with a neutral "Learner NNNNNN"
label, bound through activity_participation. No Telegram profile data is copied
and no wallet provider is called; a pending wallet assignment reserves the
ordinary persona slot for later promotion. The existing limits apply: ten
lifetime slots and three additional personas per rolling twenty-four hours.
Exhausted limits start nothing and never reuse a sibling persona. A per-user
advisory lock makes concurrent first use, retries and other bots converge.
Enrollment rechecks the current bot, ingress generation, private-chat start and
the sender's own conversation lease. All three tables are immutable by trigger.

The persona limits apply to the one cross-bot learner account. An isolated
owner holds a single study persona, so those limits never reach it. That
asymmetry is unobservable while one practice community is admitted and needs an
owner decision before a second community is.

An explicit linked-account grant is resolved first and keeps its authority.
A sender whose Telegram identity is independently associated with a Pirate
account, but who has no grant for this bot, gets an isolated practice owner for
this bot alone: a separate reservation row naming local_bot_id, with its own
neutral persona and no link to the associated account. Only the existence of the association is consulted. The associated
account is never read, written or revealed, and no second promotable account is
created for that person. Another bot isolates the same sender separately.

An identity already in use for a community is always reused before that rule
is applied, so linking or unlinking an account later never moves or discards
local progress. Only a reservation with no local_bot_id is a candidate for the
phase-two recovery and promotion contract.

Sessions for a restricted learner are practice only. The Telegram admission
freezes the marker, and a trigger on study_sessions_v2 refuses any session for a
restricted learner account that is not practice only, whichever path starts it.
That trigger runs on every Study session insert, including ordinary website
Study, so it reads the reservation with definer rights and needs no table grant
on the serving role. EXECUTE on the function is revoked from every role, so
nothing but the trigger can run it.
Recovery, claiming, promotion and erasure tooling are phase-two work.

Telegram's reply-to-message ID must identify the confirmed current prompt. Old
or unthreaded recordings are not graded. After the verdict comes the actual next
card or repeated presentation selected by Study v2. /resume repeats the current
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

The reservation and study-persona tables need SELECT and INSERT only: admission
reads them without a row lock, because a row lock would require UPDATE. The
affirmations table needs no access. Enrollment
also inserts into users, personas,
persona_profiles, persona_wallet_assignments and persona_community_bindings
through the serving role. They are not part of the six-object guard, because a
staging role with broad default privileges would fail it and silently disable
the whole bot. The bounded block is in roles.sql.example.

Apply migration 0246 and that block before serving this source with Telegram
enabled in any mode. The learner interface reads the reservation and
study-persona tables on every private update to decide whether to offer Resume,
including for a discovery-only bot with practice disabled.

## Where updates are processed

Cloudflare placement applies only to fetch handlers, so a queue consumer cannot
be placed beside the database. On 2026-10-08 the first release took 16 to 25
seconds per interaction on staging, with the chat running in the unplaced jobs
consumer behind two queue hops. The HTTP Worker has targeted placement at the
database host, so it now does the work itself: after storing an update it
processes it in the request's background and sends the replies that update
produces directly. Updates and replies are still written durably first.
Messages enqueued by anything else, such as an owner publishing posts, are
queued as before.

Background work is cut off about thirty seconds after the response. Each
inline update therefore also sends a queue message delayed 130 seconds, just
past the two-minute inbox lease, so the jobs Worker re-drives an interrupted
update without waiting for the scheduled scanner. For a finished update that
message finds nothing to claim. A send interrupted mid-flight ends uncertain
and is not resent, as before; if it was the prompt, /resume shows it again. The
jobs Worker and the scanner remain the recovery path, so both Workers must run
this source. Each inline update logs only its outcome and duration.

Inline work, queued work and the caller all use one services object. The first
release of this path gave the inline callbacks a copy without the practice
service, so a real webhook update was handled as a discovery-only bot while
queued work behaved correctly. `telegram-http-practice.pg.test.ts` goes through
the webhook accept function with the HTTP option against a real database to keep
that from recurring; a test that inserts inbox rows for the queue cannot see it.

A prompt ordered after a verdict is sent only once the verdict is delivered. It
waits while the verdict is pending, being sent or awaiting a retry. A verdict
that can never be sent, or whose outcome is unknown, is cancelled first, so it
cannot arrive after the prompt.

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
and presentation number. It records selection, prompts, completion,
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
