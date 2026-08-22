# Staging zone bridge

This temporary, secret-free Worker keeps `api-next-staging.pirate.sc` attached
to the canonical api-next staging Worker while the `pirate.sc` zone remains in
Cloudflare account `ff375d61cdc0c5dc946837f3e37725e0`.

The bridge owns no bindings or credentials. It forwards requests unchanged to
the canonical account's `workers.dev` origin. Deploy it only with a Wrangler
profile authenticated to the account pinned in `wrangler.jsonc`:

```sh
wrangler deploy --config infra/cloudflare/api-next-staging-zone-bridge/wrangler.jsonc
```

Retire the bridge after moving the `pirate.sc` zone to canonical account
`08a4c22cf52e2ecae883e36f80a33f4a`, attaching the custom domain directly to
`pirate-http-worker-staging`, and verifying health and JWKS through the public
hostname. Then disable the canonical Worker's `workers.dev` endpoint unless it
has another reviewed consumer.
