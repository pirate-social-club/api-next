# Creation avatars

Avatars use private, dedicated R2 ingress and sealed buckets. They never enter
song submission, Filebase or IPFS. The Images binding decodes and normalizes the
source once; reads serve the stored JPEG through the ordinary contract router.

## Protocol and ownership

An authenticated caller reserves an image with an idempotency key, community or
persona purpose, JPEG/PNG/WebP content type, and exact byte length (up to 5 MiB).
There are at most 20 new reservations per account per rolling day. An identical
retry returns the same reservation while its ten-minute upload window remains.
A conflicting or expired key requires a new selection/reservation.

The presigned PUT binds Content-Type and Content-Length. Send the raw File or
Blob of the declared size, not multipart form data. Set the returned
Content-Type header. A browser supplies Content-Length itself; JavaScript must
not try to set that forbidden header. Machine clients must also send the exact
length. Send no API session cookie or Authorization header to the R2 URL.
Provider-backed acceptance must verify this browser PUT against actual R2 CORS.

Finalize checks account ownership, stored bytes and actual format, bounds the
image at 16 million pixels, applies Images normalization to a static JPEG of
at most 512 pixels per side, removes JPEG APP/COM metadata and trailing bytes,
and records its SHA-256 and dimensions. SVG is rejected. The sealed object is
write-once and separate from ingress: overwriting a still-valid upload URL
cannot change a ready avatar. A retry after sealing but before database commit
adopts that same sealed object. The database row lock serializes finalization,
attachment and cleanup. Corrupt codec input is rejected; provider outages are retryable and do not affect
community creation without an image.

The optional creation draft fields are `community_avatar_ref` and
`persona_avatar_ref`. They contain asset IDs, never upload URLs. The first owned
creation intent to claim an owned, matching-purpose asset binds it permanently.
Removing or replacing a draft reference does not free it for reuse in another
intent; the abandoned asset expires after 24 hours. This prevents an old upload
or request replay from gaining authority over a different draft.

Only the terminal creation commit attaches ready, unexpired, owned assets.
A new persona receives the avatar after wallet activation. An existing persona
must be unbound and have a null image; an existing image is preserved. Identity
synchronization preserves an image accepted through this path. The community,
profile revision, asset targets and attachment outcomes commit in one database
transaction. `avatar_outcomes` records attached, omitted, or preserved-existing
results and is frozen with the commit. An unavailable optional image never
prevents otherwise valid creation. Late finalization does not update a completed
community or persona.

## Delivery, removal and cleanup

Read projections return `/api/avatars/{assetId}` for the standalone application's
same-origin API proxy. The backend route is `/avatars/{assetId}`. Delivery checks
attached and nonremoved state before serving bytes or a conditional 304. It uses
the existing JPEG binary contract: `private, no-cache`, ETag and `nosniff`.
An authoring disable does not disable existing reads or cleanup. Delivery needs
only the sealed bucket, not upload credentials or Images. A previously
downloaded image cannot be recalled.

The DELETE contract requires an admin principal with `avatars:moderate` and the
ordinary session age authorization. Production session issuance currently emits
users, not admins, so this HTTP moderation route is not yet operator-accessible.
Until scoped admin issuance exists, operators use
`bun scripts/remove-avatar.ts --database-url-env CONTROL_PLANE_POSTGRES_ADMIN_URL --asset-id avatar-UUID`
to preview one asset, then repeat with `--apply` after reviewing the target.
The command requires a database owner or superuser and reports the connected
database and operator role. Retain preview and apply output with the incident
record; this tranche does not add a separate moderation audit table.
The command uses the same repository removal operation; it never accepts a
database URL on the command line or prints driver errors. Production execution
requires the usual operator authorization.
The database immediately revokes delivery; deletion waits until any upload
capability expires. Profile/community references remain so clients must use their
ordinary broken-image/initials fallback. Removal is idempotent and stays recorded.
All uploads remain explicitly `unscanned`; format validation is not moderation.
A future provider can scan the indexed unscanned rows and use this same removal
path for retroactive decisions.

The jobs Worker claims small batches with `FOR UPDATE SKIP LOCKED`. It removes
abandoned ingress and masters after expiry, and only ingress for attached assets.
Each five-minute run drains up to 100 batches of three, within its 45-second
time budget. Failed deletes increment `cleanup_attempts`, emit an aggregate
alert and remain scheduled for retry after one hour.
Do not configure an age-based lifecycle rule on the sealed bucket: accepted
images outlive their reservation. An ingress lifecycle rule is a secondary
backstop, never a replacement for the database cleanup job.

## Provisioning and acceptance

No buckets, Images binding, secrets, deployments or migrations were provisioned
by this implementation. Authoring and cleanup default to false in every Worker
environment. Before enablement, provision distinct ingress and sealed buckets,
limit ingress signing credentials to the ingress bucket, and bind both Workers
as `AVATAR_INGRESS` and `AVATAR_SEALED`. Bind Images to the HTTP Worker as
`AVATAR_IMAGES`. HTTP also requires `AVATAR_R2_ACCOUNT_ID`,
`AVATAR_R2_BUCKET_NAME`, `AVATAR_R2_ACCESS_KEY_ID` and
`AVATAR_R2_SECRET_ACCESS_KEY`; the latter two are secrets. Give the ingress bucket
narrow PUT CORS for the actual Solid origins and Content-Type header. Keep both
buckets private. Enable `AVATAR_CLEANUP_ENABLED` in jobs before
`AVATAR_AUTHORING_ENABLED` in HTTP. Bindings must be configured separately in
all intended named environments.

Deploy migration 0194 before the candidate Workers. Before enabling the Solid
flag, consume client 0.85.0 and verify real R2 PUT/finalization, corrupt and
oversized inputs, pixel bounds, orientation and metadata, image reload across
community and persona surfaces, storage outage continuation, revocation, and
cleanup retry. Rasterize the app-owned generated persona default locally, upload
it through the same contract, and retain its chosen random seed across retries.
The UI must present omission/retry without turning optional upload into a
creation requirement. The follow-on Solid record owns that browser acceptance.

Cloudflare's Images binding documentation is at
https://developers.cloudflare.com/images/optimization/binding/.
Its stream interface was checked against the pinned Workers types and current
documentation; a local workerd test exercises actual decoding and R2 sealing. Neither local
runtime tests nor mocked adapters establish live provider acceptance.
