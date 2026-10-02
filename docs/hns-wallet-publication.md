# HNS wallet publication

The owner connects to Bob before reserving a send. An authenticated request to
`POST /communities/:communityId/hns-root-imports/:sessionId/publication-attempts`
then reserves one attempt against the exact plan and session revision. A unique
partial PostgreSQL index fences unresolved attempts by canonical root, across
sessions and clients. Each environment database serves one configured chain.

`authorize_dispatch` and `cancel` compete under the same locks. Only the request
that changes `reserved` to `dispatch_authorized` receives that outcome. A retry
receives `already_authorized`; GET returns state only. Neither grants permission.
The authorization transaction checks the active actor, community route grant,
session revision, plan, authority generation and existing publication window.
A lost winning response can result in zero sends. It must never cause a replay.

The client retains its local receipt and checks the response's attempt, root,
session and plan before calling Bob once. Storage and Web Locks remain a local
safety layer. Their absence leaves manual acknowledgement available. Production
sign-in and the matching API contract are prerequisites for automatic publication.

| State | Permitted continuation |
| --- | --- |
| reserved | Cancel, or win dispatch authorization once. |
| dispatch_authorized | Report a txid, reconcile, or explicitly accept retry risk. |
| sent | Reconcile that exact txid, or explicitly accept retry risk. |
| confirmed | Acknowledge/check the import; do not offer another Bob send. |
| cancelled | A new reservation may be requested within the publication window. |
| retry_accepted | A new reservation may be requested; the previous sender may still run. |

No timeout, signing dismissal, unchanged tip, resource match or new session
releases a dispatched attempt. The existing safe observation loop gathers the
maintained incident evidence. Only independently qualified UPDATE inclusion
beneath the safe commitment can qualify its finding for wallet confirmation.
The attempt confirms only when its reported txid matches that finding's txid,
generation and encoded resource digest. Receipt reporting and observation can
arrive in either order. Missing transaction indexing leaves the fence intact.
An ordinary recovery finding alone cannot confirm a send.

An authenticated `accept_retry` with
`accept_duplicate_or_late_publication: true` records explicit risk acceptance
on the retained attempt. The UI requires a separate checkbox and action. This
is outside the one-send guarantee: an earlier browser may still publish, paying
another fee or overwriting newer records. The deadline never extends. Direct
manual wallet calls and old or modified clients are outside this protocol too.

Release this as a coupled migration, provisioner, API client and Solid change.
Migration 0236 revokes direct table privileges and pins definer search paths.
Before deploying, grant and read back the HTTP role's two public functions;
the provisioner needs table SELECT, the existing recovery-finding recorder and
`observe_hns_wallet_publication_v1(bigint)`. Do not grant it recovery authorization
or recovery-apply functions. The exact role grant examples are in
`db/postgres/roles.sql.example`; no grant is executed by this source change.

Prepare the migration and role readbacks first, then the provisioner/API and the
matching Solid client. Existing browser-scoped receipts without a server attempt
stay fenced for manual reconciliation. Account for older open clients when
reviewing the release; deploying this code cannot revoke their ability to use Bob.
A rollback keeps the attempt table and receipts. Do not roll back to an automatic
wallet-send UI that ignores them. An unavailable reservation API disables the
new UI's automatic send while retaining manual acknowledgement.

Local verification uses real PostgreSQL and the actual Solid button with a
stubbed Bob provider. The cross-session database case seeds a retained successor
session to isolate the reservation boundary; it does not prove retire/re-import.
The launch still requires real Bob acceptance, independent transaction inclusion
reader acceptance, ownership renewal/expiry/recovery, production sign-in and the
reviewed guarded deployment. Local tests grant no release authority.
