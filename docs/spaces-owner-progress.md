# Spaces owner return and recovery

The private browser-session endpoints recover existing ceremony records. They
do not create a parallel journal or change the owner start, poll, assignment or
activation commands. The browser uses its same-origin API proxy and the existing
session and CSRF boundaries.

## Finding and reading progress

`GET /communities/:communityId/spaces-ownership/roots` lists only roots with a
ceremony for the signed-in account and community. Pages contain at most twenty
canonical roots in byte order. Pass `next_cursor` as the next `cursor` until it
is null. These are locators, not evidence of current ownership or readiness.
No browser cache is needed to find them. An empty list says only that this
account has no saved ceremony in this scope.

`GET /communities/:communityId/spaces-ownership?root=harbor` reads one root. The
server serializes this read with admission and verification, then projects the
latest account-scoped ceremony. The response includes the exact saved challenge
and generation. It never includes a signature or another account's ceremony.
All progress responses are private and must not be cached.

An awaiting-signature ceremony can resume the original challenge while it is
valid. A verification-pending ceremony includes the saved poll idempotency key.
An ended or superseded ceremony cannot authorize the next step. Reads preserve
the underlying records, including an expired pending ceremony.

An accepted proof is returned with a separate current status: fresh, expired,
root changed, unavailable or superseded. Fresh requires the latest authority
reference and generation in this account, community and environment, a valid
deadline, and an independent observation matching the challenged outpoint and
key. An unavailable observation does not establish a root change. Read freshness
is descriptive; every subsequent command still performs its own checks.

The optional operator assignment reports prepared or confirmed, and whether its
generation is still current. It is disclosed only within retained proof scope.
An address confirmation is neither observed delegation nor operator capability.
It does not open names, and an expired proof does not itself pause an already
active namespace. Address attachment remains independent of issuance.

## Resuming an unanswered verification

`POST /communities/:communityId/spaces-ownership/resume` accepts the saved
`ceremony_id` and `idempotency_key`. The server retrieves the original signature
within the same account and community, then runs the existing poll command.
The original command owns retries, throttling, root checks and terminal replay.
Missing or inaccessible polls return the same generic not-found response.
The browser must not create a second poll merely because a response was lost.

## Consumer boundary

Read progress when opening the owner panel and after an uncertain write. Reject
responses for an older selected root, account or community. When several roots
are returned, preserve an explicit selection rather than treating list order as
authority. A confirmed current assignment can recover a lost confirmation
response without another confirmation command.

These endpoints cover proof and assignment recovery. Preparation and handover
still require the existing independently observed readiness evidence. Activation
remains an explicit command with fresh server checks and accepted funding terms.
No wallet command, broadcast, deployment or live-chain acceptance is introduced.
