# Provider changes needed for the localhost song onboarding pair

Prepared 2026-09-12. Nothing here has been applied. Both changes are additive
and preserve every existing value. Approval and execution belong to the
workspace owner or an explicitly authorized operator.

## 1. Privy staging app allowed origin (provider change)

The staging Solid app uses Privy app `cmsw5pis300b80cladbxx7bsr`, named
`Pirate Staging`. Production uses a different app, `cmnbdx9xk00ty0clapn2q8pdj`,
named `Pirate`, so this change does not touch production. The two apps have
separate domain lists.

Current allowed domains on the staging app:

    https://app.pirate
    https://pirate.sc
    https://web-next-staging.pirate.sc
    https://www.app.pirate
    https://www.web-next-staging.pirate.sc
    https://www.pirate.sc

Add exactly one entry: `http://localhost:8787`

Rollback: remove exactly `http://localhost:8787`. The remaining six entries
must be unchanged. Verification after rollback is the same readback listed
below with the entry absent.

Verification: read the public app configuration and confirm the entry is
present. A `POST https://auth.privy.io/api/v1/passwordless/init` with
`Origin: http://localhost:8787` then returns 200 instead of the current
403 `{"error":"Origin not allowed","code":"invalid_origin"}`. The test
identity is not affected by this change.

## 2. Ingress bucket CORS origin (provider change)

Bucket `pirate-media-ingress-staging` currently has one CORS rule:
origins `https://web-next-staging.pirate.sc`, methods `PUT`, headers
`content-type`, no exposed headers, max age 0. The browser PUT to the
presigned upload URL is preflighted from the page origin and is refused.

Change: add `http://localhost:8787` to the rule's origins, preserving the
existing origin, methods and headers. Prepared files:

    .tmp/local-pair/ingress-cors.with-localhost.json
    .tmp/local-pair/ingress-cors.rollback.json

Apply and roll back with:

    bunx wrangler r2 bucket cors set pirate-media-ingress-staging \
      --file .tmp/local-pair/ingress-cors.with-localhost.json
    bunx wrangler r2 bucket cors set pirate-media-ingress-staging \
      --file .tmp/local-pair/ingress-cors.rollback.json

Verify with `bunx wrangler r2 bucket cors list pirate-media-ingress-staging`.

## No provider change required

The API's remote R2 bindings are local configuration only. Wrangler dev opens
a transient OAuth proxy session for the two bindings marked `remote: true`;
there is no durable deployment or bucket change. Operations write real objects
to the staging ingress and immutable buckets and incur standard R2 costs.

Playback configuration is local only: account and bucket identifiers are vars,
the source HMAC is generated locally, and the locally prepared worker reuses
the ingress presign credential, which was verified to read the immutable
staging bucket. The reviewed staging boundary requires a separate read-only
token for a deployed Worker; that is a deployment-time provider change and is
not needed for this local pair.

The immutable bucket has no CORS configuration and does not need one for this
player: the song player loads a native `<audio>` element without the
`crossOrigin` attribute, so media loads and Range seeks are not CORS-gated.
This becomes a provider change only if playback later moves to a fetch-based
player.
