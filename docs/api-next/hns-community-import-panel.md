# Community import discovery and publication checks

GET /communities/:communityId/hns-root-imports returns community_id and a
nullable session. It requires authentication, an active community using the
optional-route model, and the caller's active manage_routes grant. Missing or
unauthorized communities return the same not-found response. Sessions remain
scoped to the initiating actor, matching the existing session-keyed API.
The response is not cacheable.

Discovery prefers the import serving the current active canonical HNS route,
then the most recent import, including terminal outcomes. Creation time and
the session identifier determine the order. The schema permits only one open
route attachment per community. Failed or expired ownership sessions are terminal in this projection
even before the import row is reconciled. Null means no import for this actor
and community; it does not mean that the community has no route attachment.

The awaiting_owner_update and observing responses may include
publication_check_pending. True means verification was requested and the
import still needs checking. It does not prove a wallet broadcast, transaction
inclusion, or a matching chain resource. GET reconstructs this signal from the
retained completion attempt, so navigation or a device reload does not erase
the request to check. Provider unavailability also leaves checks pending.
The poll response carries the completion service's retry_after_seconds.

Solid should discover the current import when no session locator is present,
retain locators as optional deep links, and map a pending publication check to
its wait action. A poll still performs live ownership verification before
readiness observation begins. Rejected and expired ownership results return
the durable terminal projection with no retry interval.

This API change does not deploy the panel, renew authority inventory, or adopt
the retained operator root. Release the reviewed API target before switching
Solid to the regenerated client and these behaviors.
