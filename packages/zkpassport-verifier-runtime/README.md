# ZKPassport verifier runtime

This is the separate Node/Bun-only verifier boundary for the api-next
ZKPassport adapter. It pins `@zkpassport/sdk` to `0.14.2`, uses only the SDK's
local `verify` implementation, and does not provide a hosted-verifier fallback.

`GET /health` is public but returns 503 until required configuration is valid;
the executable also refuses to start with invalid configuration. `POST /verify`
requires a bearer secret, enforces the configured body cap, and returns a
canonical HMAC-SHA256 envelope binding the
proof session, request hash, verdict, identifier (nullable on failure),
identifier type, protocol, fresh nonce, expiry, and active key ID. Logs contain
operational metadata only; raw proofs, query results, identifiers, and claims
are never logged.

Run it with `bun run start`. Both `ZKPASSPORT_VERIFIER_SHARED_SECRET` (request
authentication) and the distinct `ZKPASSPORT_VERIFIER_RESPONSE_SIGNING_SECRET`
and `ZKPASSPORT_VERIFIER_RESPONSE_SIGNING_KEY_ID` are required. The runtime
signs only with the active key. For a no-gap rotation, bring up a parallel
verifier endpoint with the new active secret and key ID, then switch the HTTP
Worker's endpoint and active pair in one deployment while configuring the old
pair as its time-bounded previous response key. Keep the old verifier available
until requests already sent to it have settled, and keep the previous Worker
key only through the maximum in-flight session window; remove both after
`valid_until`. An in-place verifier replacement and a later Worker deployment
are not atomic and require an explicit maintenance window. The verifier never
signs with a previous key and rejects unknown caller-selected key IDs. Bearer
and response-signing secrets must remain distinct. The optional port, host,
body-cap, and writing-directory settings fail closed or use their documented
safe defaults.

The HMAC envelope protects the Worker from unsigned, misrouted, replayed, and
cross-session responses, including compromise of only the request bearer. It
does not protect against a verifier host that is compromised together with its
response-signing key; that verifier can still mint signed evidence. Host
hardening, secret isolation, and key rotation remain part of the trust model.

This package is not deployment authorization. ZKPassport remains disabled in
the checked-in Worker environments. Before staging is enabled, a representative
`0.14.2` proof submission must be measured against the public HTTP Worker's
1 MiB request-body cap; this verifier's separately bounded 10 MiB input limit
does not raise the public ingress limit.
