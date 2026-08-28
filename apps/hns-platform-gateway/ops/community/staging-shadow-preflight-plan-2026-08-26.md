# Community and handle staging shadow preflight plan

Status: refreshed populated discovery checkpoint, non-executable, 2026-08-27.

This plan proves the interactive `app.<root>` transport and may prove the
`hosted_persona_v1` handle-host transport on staging Pirate Workers and
isolated loopback listeners before the public Handshake ceremony.
It does not satisfy the production acceptance at `https://pirate.sc/c/<root>`.
It authorizes no provider, database, deployment, VPS, DNS, key, certificate,
Privy, Caddy, systemd, or Handshake mutation. Every marker beginning with
`__UNRESOLVED_` is a hard stop until a separately accepted population addendum
replaces it with an observed value.

## What this preflight proves

The preflight exercises the real gateway bundle, Cloudflare Access, Solid HNS
ingress, api-next HNS API and private-authority paths, both Durable Object
replay scopes, the staging control-plane authority repository, and a separate
VPS unit. Requests enter through `127.0.0.1:4269` with an exact synthetic or
owner-approved `Host: app.<root>` value. No HNS name is published and Caddy
does not route public traffic to this listener.

The preflight deliberately does not test public HNS resolution, DNSSEC, DANE,
the browser-visible HNS origin, production identity continuity, production
Privy, or the canonical `pirate.sc` route. Those remain in the production
disposable-root plan.

## Combined handle-shadow amendment — 2026-08-27

This amendment is preparation only. It makes no claim that the dated provider,
VPS, deployment, or database observations below remain current, and it
authorizes no refresh of them. The selected source, external inventory, and
migration ledger must be re-derived in a separately authorized population
addendum.

If the workspace owner selects the staging environment for the code-path
preflight, the same isolated gateway may exercise a second exact synthetic
host, `<handle-label>.<test_root>`, using profile
`pirate-hns-community-handle-persona-public-gateway-v1`. The fixture must use
an existing active wallet-backed public persona and the free-only
`hosted_persona_v1` lifecycle. It must not provision a persona or wallet, use
the protected `pirate` root, publish HNS or DNS records, attach the synthetic
host to Caddy, or represent loopback evidence as a public-root pilot.

The handle-shadow fixture and transcript must cover:

1. one sale-namespace activation and one broad free offering using
   `hns_ascii_ldh_1_63_v1`, a seller-narrowed 8–15-character launch band,
   `first_come_v1`, and the default one-active-grant cap; this is configuration
   inside the ratified seller-narrowable 8–32 broad band, not a contract or
   backend-grammar change;
2. quote, reservation, claim, and grant creation for one existing
   wallet-backed public persona, with every immutable id, generation, and
   hash pinned through the sequence;
3. exact public `GET /` and `HEAD /` behavior for the synthetic handle host,
   with query, body, session, wallet, write, redirect, hidden-exchange, and
   retry behavior rejected;
4. fail-closed responses for activation suspension, namespace-authority loss,
   DNS-zone or delegation drift, deployment or gateway mismatch, stale grant
   generation, non-public persona, malformed host, and unavailable authority;
5. retained-grant recovery through fresh current authority and required fresh
   generations, with stale and replayed evidence still rejected; and
6. offering suspension preventing a second quote while leaving the active
   grant intact; and
7. one label from the pinned platform-reserved set remaining unavailable
   through both broad and exact precedence. Owner-authored namespace
   blocklists are a parallel follow-up, not a prerequisite for this shadow or
   the first public pilot.

Any separately named optional exact-label fixture must use no more than 15
characters for this launch rehearsal. The backend exact-label grammar remains
1–63 characters and is not narrowed by this plan.

The staging tuple must be isolated from every production tuple. A root,
network, database, protected origin, gateway listener, credential, replay
scope, deployment, or evidence namespace selected for production cannot be
silently reused here. If the selected staging system cannot model a root and
delegation predicate without weakening the production contract, the handle
shadow is skipped and the reason is recorded; the public-root pilot is not
weakened to make staging pass.

## Source closure

The two repository blockers are merged and their task records are complete.
api-next PR 75 landed as `aa32b0f43438bf939b2bb3f7e8e7465abd854048`
after review of head `6848c2f`; it supplies the source-closed
`staging-shadow` mode, literal listener pair 4269/4271, separate release and
credential roots, manifest schema, and systemd unit. Solid correction
`c7aee1c` permits one exact protected api-next origin while retaining distinct
API and authority credentials. It is present in selected Solid source
`f34435451c19276faf24ef62234441de0d15d187`.

No third api-next deployment or third Access application is introduced. Any
change to either selected source commit invalidates its derived bytes and
requires a new reviewed population addendum before execution.

## Selected staging tuple

The application and database tuple is fixed as follows. Provider-generated
identifiers remain hard stops until their separately authorized creation or a
read-only authenticated provider inventory.

| Member | Exact staging selection |
| --- | --- |
| Solid canonical origin | `https://web-next-staging.pirate.sc` |
| Solid Worker | `pirate-web-solid-staging` |
| api-next canonical origin | `https://api-next-staging.pirate.sc` |
| api-next Worker | `pirate-http-worker-staging` |
| control plane | Hyperdrive `8cb7658a0f7143359c1becfec6a15c23` and its staging PostgreSQL origin |
| Privy application | `cmsw5pis300b80cladbxx7bsr`, observed but not changed or exercised |
| protected Solid origin | `https://hns-community-ingress-staging.pirate.sc` |
| protected api-next origin | `https://hns-community-api-staging.pirate.sc` |
| private-authority origin | the same protected api-next origin after the Solid correction |
| gateway listener | `127.0.0.1:4269` |
| health listener | `127.0.0.1:4271` |
| gateway mode | `staging-shadow` |

Authenticated read-only Wrangler inventory at 2026-08-27T00:03+04:00 bound
the current staging deployments and versions. The canonical OAuth profile was
already authenticated to account `08a4c22cf52e2ecae883e36f80a33f4a`; no login
or credential write was performed:

```text
solid_source_commit = f34435451c19276faf24ef62234441de0d15d187
api_next_source_commit = 94dcb875229e51b7d9838426de82a829eedae62d
solid_current_deployment = 40961596-d119-4555-8e19-2a34f7833c51
solid_rollback_version = f081e8a2-651e-4888-befb-d6abdd43e572
api_next_current_deployment = c44dcb12-cc5c-4b05-96fe-d12628de959b
api_next_rollback_version = cf907860-b066-4efd-bef9-e366602932da
protected_origin_availability = absent from the account Worker Domain inventory and unresolved in public DNS
```

The account has exactly four Worker Custom Domains: the canonical staging and
production Solid and api-next hosts. Neither proposed protected hostname is
present. api-next staging currently has seven secret-text bindings and Solid
staging has none; no HNS community secret-reference name is installed in
either Worker.

```text
web-next-staging.pirate.sc = 90fa14dfb8788c1fd14d051db88fac781471cd1e / c45c941a-38c9-4f4c-836c-70e742dad232
api-next-staging.pirate.sc = f57c5abdac65124fe156b6954d542888607d584b / c2b70353-bd8a-4e8a-8392-9d9c3ff2afb1
pirate.sc = 3da4eb163c455f98434b0491b04c2d7f7b515d79 / bedd2ef9-72f9-43fe-b0b9-49516dab02dc
api-next.pirate.sc = 91471e7dc83c81964f3ca4365c5077fc14284bd7 / 10513e34-40a9-44b3-ab80-cbb198567373
```

Each value is `Worker Domain id / certificate id`. This is rollback and
no-collision evidence only; none is a target of the staging preflight.

The OAuth profile can read Workers but cannot read Access. The organization
endpoint returned HTTP 403 / error 10000, while Access applications and
service tokens returned HTTP 403 / error 9999. The remaining provider-read
ceremony must supply `Access: Apps and Policies Read` and
`Access: Service Tokens Read` for this exact account, retain only the team
domain, application ids/domains/AUDs, policy shapes, and token metadata, and
never print credential bytes. Until then, the team domain and all Access
resource identifiers remain hard stops.

The two protected origins are new Worker Custom Domains. Cloudflare creates
DNS records and WebPKI certificates when a Custom Domain is attached. This
plan therefore makes a precise distinction: it changes no Handshake or
PowerDNS record and publishes no `app.<root>`, but its execution would create
two Cloudflare-managed ICANN DNS records. A claim that this preflight is
entirely DNS-free would be false. Using `workers.dev` instead is not accepted
without a source-closed proof that the Solid Worker can reach the api-next
Worker through that hostname while still exercising Access; same-zone Worker
fetches to `workers.dev` are not assumed to work.

## Durable mutations carried by the preflight

Execution would carry all of the following durable external changes. Plan
acceptance alone authorizes none of them.

1. Enable the account-wide Cloudflare Zero Trust organization and choose one
   durable team domain intended for later production use.
2. Create two hostname-scoped Access applications, two Service Auth policies,
   and three distinct service tokens.
3. Attach the two protected Worker Custom Domains, including the
   Cloudflare-managed DNS records and certificates they create.
4. Apply every missing migration in the staging PostgreSQL ledger through the
   exact migration expected by the selected api-next commit.
5. Deploy api-next and Solid staging. The first deployments carrying the
   current source declarations provision `HNS_COMMUNITY_APP_API_REPLAY` with
   Durable Object migration `v4` and `HNS_COMMUNITY_APP_REPLAY` with migration
   `v1`, even while both HNS switches remain false.
6. Install explicit staging variables and secret references in both Workers,
   plus a least-privilege staging database role and staging-only activation
   rows.
7. Install one isolated gateway release, credential directory, manifest, and
   systemd unit on the retained VPS.

No mutation may ride an unrelated deployment. Each step requires its own
pre-state, exact request or command, post-state, rollback target, timestamp,
and redacted evidence.

## Access and secret topology

The workspace owner chooses the account-global team domain before Access is
enabled. Cloudflare must then confirm the exact issuer and JWKS URL:

```text
issuer = https://__UNRESOLVED_ACCESS_TEAM_DOMAIN__
jwks_url = https://__UNRESOLVED_ACCESS_TEAM_DOMAIN__/cdn-cgi/access/certs
```

The two applications and three clients are:

| Boundary | Application origin and AUD | Admitted client |
| --- | --- | --- |
| gateway to Solid | `https://hns-community-ingress-staging.pirate.sc`, `__UNRESOLVED_STAGING_SOLID_ACCESS_AUD__` | staging gateway token |
| Solid to api-next `/api` | `https://hns-community-api-staging.pirate.sc`, `__UNRESOLVED_STAGING_API_ACCESS_AUD__` | Solid staging API token |
| Solid to private authority | same api-next origin and AUD | distinct Solid staging authority token |

Every application has only a Service Auth policy for its named clients. There
is no interactive group, bypass, wildcard domain, or account-wide Worker
policy. The api-next application admits both Solid tokens because the merged
api-next graph has one protected origin and one audience; api-next separately
enforces the forwarder-v3 `/api` contract and the private-authority v2 wire.

Service-token secrets are shown once by Cloudflare and are written directly
to approved custody. Evidence retains only resource ids, generated AUD tags,
secret-reference names, scopes, and timestamps. The candidate references are:

```text
HNS_FORWARDER_V3_HMAC_KEY_REGISTRY
HNS_COMMUNITY_APP_API_ACCESS_CLIENT_ID
HNS_COMMUNITY_APP_API_ACCESS_CLIENT_SECRET
HNS_COMMUNITY_APP_AUTHORITY_ACCESS_CLIENT_ID
HNS_COMMUNITY_APP_AUTHORITY_ACCESS_CLIENT_SECRET
hns-community-solid-access-client-id
hns-community-solid-access-client-secret
hns-community-authority-database-url
hns-community-forwarder-key-registry
```

Both Worker validators retain exact issuer and generated AUD checks, RS256
JWKS validation, at most 60 seconds clock skew, at most 3,600 seconds JWKS
cache, exactly one uncached unknown-`kid` refetch, a two-second JWKS deadline,
manual redirects, and zero retries. The private-authority deadline is two
seconds. A client-supplied Access or forwarder field is never authority.

## Staging migration ceremony

A read-only query at 2026-08-27T00:07:56+04:00 proved that staging is an exact
checksum prefix through `0055_megapot_claim_reconciliation.sql`. The selected
api-next commit expects 58 migrations and staging has 55. The only missing
ordered suffix is:

```text
0056_media_processing_runtime_bridge.sql = 52b7e2075d87ff91274774bafd94270744847728ada07deb2ff7a6aa35f4f054
0057_data_registration_persistence.sql = a11f28beba567660b4350ab6de117a3999c495e70ecc51a5897aa2638d1e1921
0058_data_ipfs_and_signing_intent_repair.sql = 550be77e955da377a0de24df9496e0d1a37a0b1f4ad133d1ff309d34647aed07
```

The frozen source and migration inputs are:

```text
api_next_source_commit = 94dcb875229e51b7d9838426de82a829eedae62d
expected_latest_migration = 0058_data_ipfs_and_signing_intent_repair.sql
checksums_ledger_sha256 = a745dddc147e75029488041c9383e8373a95b2529d7adaefb67e2c91c37028c0
staging_backup_reference = __UNRESOLVED_VERIFIED_STAGING_BACKUP_REFERENCE__
staging_migration_command = infisical run --env=staging --path=/services/api-next/operator -- bun run db:migrate
```

A read-only credential must compare every applied migration from 0001 through
the selected commit with `db/postgres/migrations/checksums.json`. Record the
exact missing ordered suffix and each expected digest. A separately authorized
ceremony takes and independently verifies a staging backup, applies the suffix
once in order, stops at the first precondition or digest failure, and proves
the complete post-state ledger before any api-next deployment. Recovery is
forward repair or database restoration, not a Worker rollback.

## Staging authority fixture

Root custody is not a prerequisite for the isolated preflight. This plan uses
the opaque synthetic HNS-valid label `hnsr-f49ac37b`, derived from the bound
profile digest rather than an owned name. Read-only transactions found zero
operator-route, DNS-zone-current, and app-host-revision rows in staging at
2026-08-26T23:43:37+04:00 and production at
2026-08-27T00:07:14+04:00. The production query used the documented Infisical
slug `prod`; the earlier `production`-slug 404 was operator error and is
superseded. No index-to-name mapping is written to this repository.

The exact staging-only values remain unresolved:

```text
test_root = hnsr-f49ac37b
community_id = __UNRESOLVED_STAGING_COMMUNITY_ID__
route_activation_id = __UNRESOLVED_STAGING_OPERATOR_ROUTE_ACTIVATION_ID__
route_activation_generation = __UNRESOLVED_STAGING_OPERATOR_ROUTE_GENERATION__
dns_zone_activation_id = __UNRESOLVED_STAGING_DNS_ZONE_ACTIVATION_ID__
dns_zone_activation_generation = __UNRESOLVED_STAGING_DNS_ZONE_GENERATION__
app_host_activation_id = __UNRESOLVED_STAGING_APP_HOST_ACTIVATION_ID__
app_host_activation_generation = __UNRESOLVED_STAGING_APP_HOST_GENERATION__
gateway_deployment_reference = __UNRESOLVED_STAGING_GATEWAY_DEPLOYMENT_REFERENCE__
synthetic_certificate_spki_sha256 = __UNRESOLVED_STAGING_NONPUBLIC_SPKI_ASSERTION__
```

Create these records through the accepted operator control-plane path, never
raw ad hoc SQL. The route remains `operator_managed_route_v1`; all six
`HNS_OWNERSHIP_ENABLED` values remain false and no ownership verifier or
observer-driver binding is added. The activation documents and health facts
are staging fixtures that must be internally consistent with the source
resolver, but they do not claim a real DNSSEC, DANE, or chain observation.
The gateway's `postgres-readonly-v1` role can execute only the accepted
authority resolver and cannot mutate, migrate, own, or administer data.

If the current operator tooling cannot create and revoke a staging fixture
without claiming external DNS evidence, population stops and registers a
bounded tooling task. The plan does not bypass an invariant with direct SQL.

## Forwarder and replay plan

One exact registry document serves the gateway signer and both Worker
verifiers and contains exactly one signing key:

```text
registry_reference = __UNRESOLVED_STAGING_FORWARDER_REGISTRY_REFERENCE__
registry_version = __UNRESOLVED_STAGING_FORWARDER_REGISTRY_VERSION__
active_key_id = __UNRESOLVED_STAGING_FORWARDER_ACTIVE_KEY_ID__
freshness_window_seconds = 300
future_clock_skew_seconds = 5
```

Solid consumes unsafe nonces under
`pirate:hns-forwarder-v3:pirate-web-solid-community-app:v1`. api-next consumes
the same nonce independently under
`pirate:hns-forwarder-v3:api-next-community-app-api:v1`. Durable Object shards
are keyed by `${consumerScope}:${keyId}` and retention is 306 seconds. A store
failure fails closed. Pruning is lazy within an active shard; expired rows in
a retired key's inactive shard remain until a separately accepted namespace
retention or deletion ceremony.

## Gateway isolation

The merged source freezes this exact isolated profile:

```text
mode = staging-shadow
gateway_listener = 127.0.0.1:4269
health_listener = 127.0.0.1:4271
unit = pirate-hns-community-app-gateway-staging-shadow.service
release_root = /srv/pirate-hns-community-app-gateway-staging-shadow
credential_root = /etc/pirate/hns-community-app-gateway-staging-shadow
```

The source-closed artifact remains
`dist/pirate-hns-community-app-gateway.mjs`. A clean build using the
repository-pinned Bun 1.4.0 at the selected commit produced the following
candidate digest. The generated artifact was removed after hashing. The
populated deployment manifest is not created until the remaining provider and
authority values exist, so its final digest remains a hard stop:

```text
api_next_source_commit = 94dcb875229e51b7d9838426de82a829eedae62d
bundle_sha256 = 44a7df4b2393438e3ac0e308b0dccf2e39d4bf10296dec8bcb9f669776bfb0dc
manifest_template_sha256 = 892fbb7a9fbb13c027bfea2c1f079951fdb22f7b8b06098b6b2e7da5da118937
systemd_unit_source_sha256 = 1e8063a5b97e992264c99e742e9f8c7d55acc38451996dac508583fafbfe201d
manifest_sha256 = __UNRESOLVED_STAGING_DEPLOYMENT_MANIFEST_SHA256__
```

The retained VPS runs Bun 1.3.14. Execution must prove the selected bundle
starts and passes its focused checks under that runtime before installation;
changing the source commit, lockfile, Bun build version, or bundle bytes
invalidates this digest.

The staging unit may write only its staging release and credential roots and
own only 4269/4271. It may not read or write the production community paths,
production shadow paths, `app.pirate` paths, Caddy configuration, PowerDNS,
HSD, certificate material, or ports 4049/4051, 4069/4071, or 4169/4171.

The manifest binds the 622-byte profile and SHA-256
`f49ac37bd45da71bdf1e1cc65f184729d85f9d72ce811f0551a70f7785aa8d86`,
the staging protected Solid origin, exact Access AUD, staging authority
endpoint, registry version, limits, listener pair, source commit, bundle
digest, and the synthetic nonpublic SPKI assertion. The assertion is only an
authority-tuple equality fixture; it is not evidence that a TLS certificate or
TLSA exists.

## Read-only retained-estate baseline

The primary inventory at 2026-08-26T19:36Z found the live `app.pirate`
release at
`/srv/pirate-hns-platform-gateway/releases/e7b0b247613691c27aedfd80da63d8a79615f10d`
with installed bundle SHA-256
`619c035de3b8588cd9a429d03df1e997febaf27ebfe5e55ac325e33b00548120`.
Its 4049/4051 service was active and enabled, and both health probes returned
204. Ports 4069/4071, 4169/4171, and 4269/4271 were unowned. The active Caddy
configuration SHA-256 was
`4e9f56608383a66771ac27510f1aca25bef8a908784ee8b601840b89fd5b294f`;
the retained pre-target file SHA-256 was
`2e450f1ebee39a0f33bf2a0fcf17de093088c47fdd6b1bc9fe5df7177608c8db`.
No Caddy change is part of this preflight.

The daily state-backup service and deployment-verifier units were failed at
inventory time. Their repair or baseline refresh is not included in this
plan: a separately authorized preflight must produce a verified staging
database backup reference, and every retained-estate verifier needed as a
promotion gate must be healthy or explicitly dispositioned before execution.

At 2026-08-26T19:44Z, local queries on both retained authorities returned the
same signed `pirate` SOA serial `2026072002`, `app.pirate` A record
`94.103.168.161`, and TLSA `3 1 1`
`5c8ddd3dbf63dbab698c726708b06177adda4a21416c675197f97e3b27ab20d8`.
Both direct public port-53 queries from the discovery runner were refused.
These authority-local results are regression diagnostics only, not the two
independent public views required by the production rehearsal.

## Ordered execution after separate authorization

1. Re-derive the selected repository refs and candidate bundle digest, then
   complete the Access organization, application, policy, and service-token
   inventory with the two missing read permissions. Recheck Worker versions,
   secret-reference names, Custom Domains, VPS state, listener ownership,
   synthetic-root absence, and both database ledgers immediately before
   execution.
2. Populate every unresolved marker and accept a new addendum. Stop if the
   selected tuple differs from this document.
3. Enable the account Zero Trust organization with the owner-selected team
   domain. Create the two Access applications, Service Auth policies, and
   three tokens into custody.
4. Attach the two exact staging Custom Domains and prove that the existing
   canonical staging origins remain reachable and outside those Access apps.
5. Complete the separately authorized staging backup and migration ceremony.
6. Deploy api-next staging with the HNS switch false, explicitly provisioning
   its replay namespace and migration `v4`. Record the prior and new Worker
   versions.
7. Deploy Solid staging with the HNS switch false, explicitly provisioning its
   replay namespace and migration `v1`. Record the prior and new Worker
   versions.
8. Install the registry, Access credentials, exact variables, and distinct
   service-token references while both switches remain false. Prove ordinary
   staging and `workers.dev` reserved-header rejection.
9. Create the staging read-only gateway role and the staging authority fixture
   through the reviewed operator path. Record each id and generation.
10. Install the staging gateway release, manifest, credential files, and
    staging-only systemd unit. Start only 4269/4271 and prove `/livez` and
    `/readyz`; do not install a Caddy route.
11. Enable api-next only on its protected staging origin, then Solid only on
    its protected staging origin. Probe ordinary origins after each deploy.
12. Exercise the accepted loopback request matrix, replay, authority failure,
    suspension, new-generation recovery, and revocation.
13. Disable both HNS switches and the staging unit before any credential,
    Access, database-fixture, release, or namespace cleanup.

There is no retry-until-green policy. One failed predicate stops the sequence,
records the exact redacted failure, and rolls back only the current reversible
layer.

## Acceptance transcript

The transcript must prove:

- `GET` and `HEAD /` map to `/c/<test_root>` and other reads preserve the
  exact path and query;
- only bounded `POST` and `PATCH` to `/api` and `/api/*` preserve the body,
  Origin, host-only cookies, and CSRF value;
- gateway, Solid, and api-next agree on the exact profile, deployment
  reference, authority generation, registry, HMAC, timestamp, method, path,
  body digest, key id, and nonce;
- Access validates the exact issuer, generated application AUD, signature and
  time claims, including the cache, unknown-key, deadline, redirect, and retry
  rules;
- an unsafe nonce succeeds once in each independent replay scope and fails on
  reuse;
- stale, mismatched, unavailable, suspended, and revoked authority fails
  closed, while recovery requires a new current generation;
- canonical staging Solid and api-next traffic stays available and rejects
  `cf-access-*`, `x-pirate-gateway-*`, and
  `x-pirate-hns-forwarder-*` fields;
- `app.pirate`, its 4049/4051 health listeners, bundle, Caddy route, DNS,
  DNSSEC, TLSA, certificate, and rollback release remain unchanged; and
- 4069/4071 and 4169/4171 remain unowned by the staging unit throughout.

The loopback transcript uses an exact `Host: app.<test_root>` and unsafe
`Origin: https://app.<test_root>` against 127.0.0.1:4269. It retains hashes,
ids, versions, status classes, and timestamps but no token secret, HMAC key,
database password, cookie, raw account identifier, or test credential.

This evidence is transport and authority preflight evidence only. It is not a
DNSSEC, DANE, browser, Privy, production account-continuity, or public-root
acceptance transcript.

## Retirement and retained state

Disable Solid and api-next HNS switches first, stop and disable the staging
unit, and revoke the staging app-host and route generations. Service tokens
are revoked before their secret references are removed. Staging fixture rows
are retained as revoked audit history unless the accepted schema lifecycle
provides a reviewed deletion operation.

The owner-selected Access organization and team domain remain because the
production rehearsal is expected to reuse their issuer and JWKS URL. Access
applications, Custom Domains, Worker secrets, replay namespaces, gateway
files, and the staging database role each need an explicit retain-or-remove
decision in the populated lifecycle addendum. A Worker rollback does not
unprovision a Durable Object namespace or reverse a PostgreSQL migration.

## Parallel public-root owner decisions

The following owner inputs may proceed in parallel and do not block the
isolated preflight draft:

1. Prove custody and no production or third-party use for candidate-05 in an
   access-controlled transcript. Keep its label and index mapping out of this
   repository.
2. Decide whether the existing Handshake delegation and candidate-specific
   DNSSEC key, observed with key tag 39280, may serve as the public rehearsal's
   key material. Retaining them can avoid a Handshake UPDATE; requiring a new
   keyset requires a new DS and mined transaction.
3. Confirm that the public rehearsal will issue a distinct DANE-EE
   certificate. Candidate-05 currently carries a TLSA matching the production
   `app.pirate` SPKI, which is prohibited rehearsal key-material reuse and must
   be replaced by a zone-only TLSA update before public traffic.
4. Choose the Cloudflare Access team domain with production reuse in mind.

The earlier DNS observations came from one execution runner querying two
authorities. They are diagnostics, not the production plan's required two
independent validation vantages.

Stop here. Do not execute this plan in the same authorization step that
accepts, reviews, or populates it.
