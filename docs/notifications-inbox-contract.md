# Recipient-private Notifications source contract

Source handoff for v1-notifications-contract-api-20261016. The parent task record
ADOPTS top-level comment → post author; reply → immediate parent author; actor
excluded; no ancestor/follower/community fan-out. This is current authority.
Earlier pending-rule/unwired handback receipts remain preserved as history.

The only fact is existing content_publication_outbox.comment_notification,
uniquely keyed by submission/event. Direct publication and real owner approval
of held comments/replies persist the same fact. Held/blocked content alone
creates no notification. No review event, outbox enum, receipt field, external
channel, queue or live binding is added.

Provisional migration 0269 installs an after-insert publication hook. Its
transaction derives actor and recipient from persisted submission/comment/post/
immediate-parent ownership. Callers cannot choose recipients; the database inbox guard enforces the same rule. Active accounts,
membership, community/post status, permitted age and complete published branch
authorization are required. Self, missing, inactive and unauthorized recipients
are terminally suppressed. Access restoration does not create later fan-out.

Current notification destinations require an existing owned text/song reader.
New facts on video or other unsupported parent types are terminally suppressed;
ordinary and owner-approved comments still publish their existing fact normally.
Current list, unread count and read commands omit unsupported parents under the
same policy; the navigation resolver retains its redacted NotFound. Previously
delivered rows, terminal outcomes, facts and historical receipt/href bytes remain
intact. Current omission does not erase history or revise delivery outcomes.
Notifications video coverage remains held pending a real owned video-navigation
contract. This source restriction is not an owner decision to cut that feature
and does not establish full MVP acceptance.

Fact, inbox row, private processing receipt and existing outbox acknowledgement
commit atomically with publication. A failure rolls them all back, including
the command receipt. Fact/recipient uniqueness, fact processing uniqueness and
row locks handle concurrent retries. The active recipient is locked before
delivery-order allocation, so a concurrent commit cannot insert a late lower
order behind an inbox cursor. Account deletion serializes with delivery and
clears the inbox; its ledger reference becomes null. The inbox delete guard
refuses active-account deletion even when the runtime has DELETE privilege;
receipt nulling is permitted only after the protected inbox row is gone. The ledger retains fact/
outcome, no recipient identity or content snapshot.

The production Jobs registry owns notifications.recover-publications, every
minute through the existing kernel and ControlPlaneDb. Each pass returns at
most 50 outstanding facts from a partial index on the existing outbox private
completion marker, regardless of pending or previously published state, and
commits one transaction per fact. The marker can advance only with a valid
immutable receipt and cannot be cleared; a valid receipt lacking its private
acknowledgement is repaired idempotently. There is no lossy time watermark.
LIMIT caps returned facts, not scanned index/heap history. The focused plans
retain dirty-MVCC and post-vacuum evidence separately: dead index tuples can
still require history-sized heap work until ordinary vacuum maintenance.
Restarted and overlapping passes are idempotent. Original control-plane outcome
classifications escape to the kernel so unknown commits stop ordinary retries.
No external queue, provider or new binding is needed.

GET /me/notifications returns at most 20 persisted entries, newest delivery
first, a recipient-owned UUID row cursor, and the count of currently readable
unread entries. The session principal selects the account; no account/persona
selector or staff override exists. POST /me/notifications/:notificationId/read
sets the first read timestamp; replay preserves it. Missing, foreign and
inaccessible entries share NotFound. Existing same-origin cookies/CSRF apply.
Responses are private/no-store. GET never marks read.

An inbox row stores only fact identity, recipient, order and read state. No
body/title/actor/moderation material, historical href or mutable presentation
snapshot is stored. List/count/read share current branch authorization:
active account/community, published readable post, required membership, post/
target/ancestor age, complete same-post/community ancestry, distinct IDs and
exact depths 0–8. Inaccessible entries expose neither targets nor unread
metadata. Recipient-owned cursor anchors survive target loss. A parameterized keyset
page selects at most 21 currently authorized candidates before constructing
20 item JSON documents. Unread count uses a separate partial unread index and
minimal authorization, without constructing inbox presentation JSON; both
queries share one statement snapshot. Filling a page can inspect inaccessible
candidates, and exact unread privacy requires checking current unread targets. New deliveries,
reads and hidden anchors cannot move older pages or reset first-read/order.

Current lifecycle has active/deleted states. No additional erasing state,
retention duration, account merge, mark-unread or bulk-read policy is invented.
A future erasure-owner intake must use its actual accepted contract.

ResolveCommentNavigationV1 is generated and wired into HTTP composition.
See [the consuming Solid handoff](notifications-solid-navigation-handoff.md).
Public metadata and historical creation/replay href bytes are unchanged.
Fresh links and navigation capability remain conditional on paired Solid intake.
This source handoff does not establish end-to-end inbox/runtime acceptance.

Parent owns migration order/index guards, baseline/reset/foundation catalog,
runtime-role grants (see notifications-runtime-privileges.md), independent review, serialized full gates and publication.
0269 is branch-local; accepted migrations/checksums through 0268 are immutable.
New storage is notification_inbox, notification_publication_deliveries and the
inbox identity sequence, with invoker functions/triggers. Parent must verify
publication/Jobs/deletion privileges in its disposable role gates.

Generated source differs from immutable client 0.119.0. Its artifact remains
unchanged. Parent must allocate a fresh version in actual integration order,
regenerate provenance, create its artifact/handoff and append its ledger entry.
No new release is prepared or claimed by this writer.
