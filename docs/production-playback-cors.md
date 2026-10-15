# Ordinary production playback CORS

Signed song and instrumental playback URLs point to the private
`pirate-media-immutable-production` R2 bucket in account
`08a4c22cf52e2ecae883e36f80a33f4a`. Browser playback from `https://pirate.sc`
requires its CORS policy as well as a valid signed URL. Upload-ingress CORS
does not configure this separate bucket.

The reviewed candidate is
`infra/cloudflare/song-production/media-immutable-production-cors.json`.
It permits GET from the ordinary production origin. It adds no write methods,
wildcard origins, public bucket access or credentials. HNS-origin playback
needs a separate reviewed origin policy and acceptance.

Before applying, record the source commit, policy digest, independent review,
current bucket policy and exclusive release custody. Use the existing
Cloudflare account and managed operator credentials. Apply only this bucket's
policy through the Cloudflare API or the repository's pinned Wrangler R2 CORS
command, then compare the returned policy with the exact candidate. A Worker
deploy is not needed.

Verify a fresh signed instrumental GET with `Origin: https://pirate.sc`
returns the matching `Access-Control-Allow-Origin`; confirm a disallowed
origin receives no matching allow-origin header and an unsigned object GET
remains refused. Finally load the instrumental through the normal production
browser and complete a scored Karaoke take. A successful object GET without
the CORS header does not prove browser playback.

Preserve before and after receipts without signed URL query strings. If the
policy differs or browser verification fails, stop acceptance and reconcile
the observed result. Recovery restores the recorded prior CORS policy only;
it does not delete media or enable public access.
