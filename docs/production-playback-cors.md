# Production signed playback CORS

Signed song and instrumental playback URLs point to the private
`pirate-media-immutable-production` R2 bucket in account
`08a4c22cf52e2ecae883e36f80a33f4a`. Browser playback from `https://pirate.sc`
and Handshake community app hosts requires its CORS policy as well as a valid
signed URL. Upload-ingress CORS does not configure this separate bucket.

The reviewed candidate is
`infra/cloudflare/song-production/media-immutable-production-cors.json`.
It permits GET from any origin, replacing the earlier ordinary-origin-only
policy so newly provisioned Handshake app hosts can play signed media. This
is a reviewed policy change: any browser origin possessing a valid, unexpired
signed GET URL may read its bytes, including sharing or hotlinking. The bearer
signature binds the method, object path, host and expiry; it does not bind an
Origin. CORS adds no public bucket access, credentials or write methods.

The API still authorizes issuance of fresh playback grants using the existing
session, CSRF, verified community app host, publication, visibility, rating and
exact Karaoke source checks. Redeeming an issued R2 URL is a separate bearer
operation and does not repeat those API checks. This policy provides no DRM,
instant revocation or removal of downloaded bytes when a URL expires. It does
not change Privy origin admission, upload ingress, the signer or the native
gateway. Static name hosts serve public persona pages; they do not hydrate
activities under the current name-host contract.

Before applying, record the source commit, policy digest, independent review,
current bucket policy and exclusive release custody. Use the existing
Cloudflare account and managed operator credentials. Apply only this bucket's
policy through the Cloudflare API or the repository's pinned Wrangler R2 CORS
command, then compare the returned policy with the exact candidate. A Worker
deploy is not needed.

Verify fresh signed full and range instrumental GETs from the ordinary origin
and a verified Handshake app origin return wildcard allow-origin and play
through normal browsers. Confirm an unrelated origin can read an otherwise
valid signed URL, as the policy intentionally permits. Invalid, expired and
unsigned URLs must remain refused, and write-method preflights must remain
denied. Record that the bucket remains private and no credential CORS is
enabled. Complete a scored Karaoke take through the normal app-host browser.
A successful object GET without browser playback does not prove acceptance.

Staging has a separate bucket and policy. This production candidate does not
apply or accept a staging change. Fresh name claim, activation and public
persona rendering also require separate acceptance.

Preserve before and after receipts without signed URL query strings. If the
policy differs or browser verification fails, stop acceptance and reconcile
the observed result. Recovery restores the recorded prior CORS policy only;
it does not delete media or enable public access.
