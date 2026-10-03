# Durable Telegram linking

Each community keeps its own owner-controlled study bot. Pirate's independent
Telegram OIDC client supplies learner identity on Pirate's website. The
workspace_owner confirmed this identity method and retention of completed
same-bot consent on 2026-10-03. The control-plane scope record contains the
explicit confirmation; the earlier pending-confirmation wording in local
Spec 026 is historical.

This source slice implements linking and consent. It runs no Study session,
credits no reward, and gives bots no account-change or wallet authority.
TELEGRAM_LINKING_ENABLED is false in every checked-in HTTP environment. Login
client registration, credentials, serving schema and actual Telegram/mobile
acceptance remain prerequisites for activation. Runtime-role privileges must
also be admitted with the schema, before existing maintenance uses migration
0237; see [the review follow-up](telegram-linking-review-followup.md). No
production operation was performed for these local tests.

## Browser flow

The future chat runner creates a fifteen-minute navigation reference from an
authenticated private-chat sender after the current bot epoch's /start. Storage
keeps only its hash and bound community, bot, epoch, sender and song. Creation
checks an active ready bot and a public published song. It does not prove Study
readiness; the future picker and lesson start must use shared Study/content
readiness. A copied reference grants no account authority.

The signed-in learner starts a ten-minute transaction through Solid's same-origin
API proxy. It expires no later than its navigation. Browser-session-only auth,
Origin and CSRF protection are enforced before any write handler. The transport
hashes the authenticated session cookie and passes a separate HttpOnly Secure
SameSite=Lax binding to the ceremony. Neither value is accepted from a body.
The database stores only their hashes. Nonce and PKCE verifier are encrypted
using the Pirate-controlled wrapping key ring with a transaction-specific
AES-GCM context. State is hashed. There are at most three outstanding
transactions per account.

The callback verifies browser/account/session possession, checks signing-key
availability, then atomically claims the transaction before exchanging its
one-time code. Every exchange also preflights key availability. A cold-cache
or failed-key preflight leaves the pending callback unconsumed, allowing retry
within the transaction/provider-code lifetime. Start and callback need not
reach the same Worker isolate. Unknown signing-key rotation after preflight
can still require fresh Telegram approval; preflight cannot predict the key ID
inside an unexchanged code. There is no automatic token-exchange retry.

Only a verified numeric Telegram ID equal to the navigation's actual sender
advances to confirmation. Verification creates no account association or grant.
Raw provider tokens, subject, profile, name, username and picture are discarded.
The confirmation projection shows the numeric identity, community, bot and song.
The website must ask for the exact active owned community persona explicitly.
No first-persona fallback or membership requirement is added.

Confirmation atomically creates the private ID-to-account association and
restricted per-community/bot consent. An existing association to another account
is a conflict. A Telegram ID has one account association; this slice imposes no
additional one-Telegram-ID-per-account policy. A lost confirmation response is
replayable only to its original browser/account while the exact grant revision
and persona remain current. A new consent choice cancels competing pending
transactions. Provider secrets are purged after verification/failure/cancellation,
and bounded maintenance deletes expired transactions and navigation.

## Private API

Every endpoint below requires an authenticated browser session. Ceremony reads
and writes use the private binding; account summary, revocation and unlink need
no unexpired ceremony cookie. Even a malformed linking cookie cannot prevent
browser-authenticated revocation. Responses are private/no-store and have
no-referrer headers.

| Endpoint | Result |
| --- | --- |
| GET /telegram/link/account | The account's private associations and active consent grants. |
| POST /telegram/link/transactions | Bound transaction and Telegram authorization URL; binding goes only into an HttpOnly cookie. |
| GET /telegram/link/transactions/:transactionId | Browser-bound transaction projection. |
| POST /telegram/link/transactions/:transactionId/verify | Single code exchange and verified identity, without consent. |
| POST /telegram/link/transactions/:transactionId/confirm | Explicit persona consent and association in one transaction. |
| POST /telegram/link/grants/revoke | Revoke this account's selected community-bot consent and cancel pending operations. |
| POST /telegram/link/association/unlink | Remove this account's identity association and revoke its related consent. |

Generated api-client 0.106.0 contains this additive surface. Its local artifact
and immutable release receipt are in docs/api-next. Solid intake and UI are
separate work; no existing client was silently upgraded.

## Rotation and future delegation

A reconnect's epoch/status change cancels pending consent and navigation.
Completed same-bot grants and persona choices survive. A replacement bot
revokes grants for other stable bot IDs. Disconnect or error status prevents
resolution, and a current-epoch /start remains required. Reconnect's existing
channel-binding reset is unchanged. Account deletion clears its association,
revokes grants and cancels pending consent.

Revocation and unlink retain a monotonically increasing consent revision fence.
Reassociation or a new persona requires fresh proof and explicit consent;
an old completed transaction cannot recreate its prior authority. None of this
moves or deletes committed Study progress or rewards.

The repository's resolveGrant is a read for the future chat runner, not a durable
Study admission boundary. It checks account, association, community, bot/epoch,
/start and active exact-community persona. The Study integration must recheck
and lock the grant revision and shared Study authority inside each durable
acceptance transaction. No fake browser principal or direct bot call to signed-in
Study endpoints is admitted by this slice.

Real acceptance remains open: Pirate login-client custody and exact BotFather
Allowed URLs, nonce echo, numeric OIDC ID matching the community Bot API sender,
and iOS/Android Telegram/system-browser handoffs for every offered sign-in method.
Practice still needs production Study content; rewarded launch also needs the
separate money gates and reference-audio decision.
