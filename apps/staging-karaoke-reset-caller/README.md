# Staging Karaoke reset caller

This temporary operator Worker forwards bounded commands to the HTTP Worker's
named `KaraokeResetOperatorEntrypoint`. It is not a product route, a database
reset runner, or an evidence verifier. It has no database, bucket or queue
binding. Its only command target is the reviewed named service binding.

The checked-in configuration is disabled, has no route, and disables both
workers.dev and preview URLs. Deployment alone grants no reset authority.
Before a reviewed release enables it, provision the human Access application
with the owner-selected email, verify its issuer/audience and exact human
subject, and configure the same identity at the caller, named entrypoint and
Durable Object. Never use the email string as the subject or enable service
tokens. Do not record assertions or actual identity values in source or logs.

The release must supply `KARAOKE_RESET_CALLER_ORIGIN` as the exact HTTPS origin
protected by that Access application, and the existing
`KARAOKE_RESET_ACCESS_ISSUER`, `KARAOKE_RESET_ACCESS_AUDIENCE`, and
`KARAOKE_RESET_ACCESS_SUBJECT` bindings. `KARAOKE_RESET_ENABLED` remains false
until release review and the maintained ingress fence are established.

POST `/command` and read-only POST `/inspect`, without a query, require the exact
Origin, JSON content type, an authenticated Access assertion, and at most 2048
body bytes. Cross-site requests fail closed. Commands use the existing frozen
six-object generation and active/retired schema; both downstream boundaries
authenticate independently. Responses are private/no-store, and dependency
exceptions are never returned or logged. A 502 is an uncertain RPC outcome,
not evidence that installation did not occur: read back/reconcile before
deciding the next action.

`/inspect` accepts the exact target without a state field and returns the
snapshot schema documented in `docs/staging-karaoke-collector-protocol.md`.
It does not install, cancel, close or retire anything. Invalid or absent
evidence never becomes a quiescence claim.

The checked-in Wrangler types are module-scoped with an explicit type export
to avoid augmenting every other Worker's environment. After regeneration,
retain that export. The entrypoint binds the remote RPC shape explicitly;
binding-contract tests check the generated fields against configuration.

The owning release record must separately review the hostname, Access policy,
identity and pinned runtime descendant. This source does not establish fresh
live marker observations, database drain, authenticated evidence provenance, R2
reconciliation, reset admission, or rollout completion.
