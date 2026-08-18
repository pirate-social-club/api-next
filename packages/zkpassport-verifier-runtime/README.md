# ZKPassport verifier runtime

This is the separate Node/Bun-only verifier boundary for the api-next
ZKPassport adapter. It pins `@zkpassport/sdk` to `0.14.2`, uses only the SDK's
local `verify` implementation, and does not provide a hosted-verifier fallback.

`GET /health` is public. `POST /verify` requires a bearer secret, enforces the
configured body cap, and returns only `verified`, `uniqueIdentifier`, and the
SDK's non-salted identifier type. Logs contain operational metadata only; raw
proofs, query results, identifiers, and claims are never logged.

Run it with `bun run start`. `ZKPASSPORT_VERIFIER_SHARED_SECRET` is required;
the optional port, host, body-cap, and writing-directory settings fail closed or
fall back to their documented safe defaults.

This package is not deployment authorization. ZKPassport remains disabled in
the checked-in Worker environments. Before staging is enabled, a representative
`0.14.2` proof submission must be measured against the public HTTP Worker's
1 MiB request-body cap; this verifier's separately bounded 10 MiB input limit
does not raise the public ingress limit.
