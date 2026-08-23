# Staging zone bridge

This temporary, secret-free Worker kept `api-next-staging.pirate.sc` attached
to the canonical api-next staging Worker before the `pirate.sc` zone moved out
of Cloudflare account `ff375d61cdc0c5dc946837f3e37725e0` on 2026-08-23.

The bridge owns no bindings or credentials. It forwards requests unchanged to
the canonical account's `workers.dev` origin. It is retained only for resolvers
that still cache the old 86,400-second delegation. Do not redeploy it during
the cache-drain window. Its historical deployment command requires a Wrangler
profile authenticated to the account pinned in `wrangler.jsonc`:

```sh
wrangler deploy --config infra/cloudflare/api-next-staging-zone-bridge/wrangler.jsonc
```

Canonical account `08a4c22cf52e2ecae883e36f80a33f4a` now owns the zone, and
the custom domain is attached directly to `pirate-http-worker-staging`.
Retire the bridge after public NS convergence and final health and JWKS checks.
Keep the canonical Worker's `workers.dev` endpoint as the reviewed operator
fallback recorded in the secrets contract.
