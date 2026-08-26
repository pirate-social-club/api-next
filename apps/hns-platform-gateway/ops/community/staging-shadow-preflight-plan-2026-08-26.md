# Interactive community staging shadow preflight plan

Status: draft discovery checkpoint, non-executable, 2026-08-26.

This plan proves the interactive `app.<root>` transport on staging Pirate
Workers and isolated loopback listeners before the public Handshake ceremony.
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

## Source-closure stops

The staging plan is not populatable until two bounded repository tasks are
reviewed and merged.

`hns-community-app-gateway-staging-shadow-profile` must add a source-closed
`staging-shadow` executable mode. The current gateway accepts only
`production` and `shadow`; its manifest and listener selection hard-code
4069/4071 and 4169/4171. Reusing 4169/4171 would prevent the production
rehearsal from starting its own shadow and would share release and credential
paths across environments.

`solid-hns-community-app-shared-protected-api-origin` must correct the Solid
production composition so the API and private-authority clients may use the
same exact api-next protected origin while retaining distinct service-token
credentials. Current Solid source rejects
`HNS_COMMUNITY_APP_API_ORIGIN === HNS_COMMUNITY_APP_AUTHORITY_ORIGIN`, while
the api-next composition exposes both paths behind one exact protected origin
and one pinned Access audience. The accepted two-application topology cannot
assemble until that contradiction is removed and covered by tests.

No third api-next deployment or third Access application is introduced as an
operations workaround. If review chooses a different topology, this plan must
be rewritten against the merged source before population.

## Selected staging tuple

The application and database tuple is fixed as follows. Provider-generated
identifiers and the exact source commits are re-derived at population time.

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

The discovery rollback baselines were Solid version
`f081e8a2-651e-4888-befb-d6abdd43e572` and api-next version
`ba5c573b-015d-410d-a8a0-d6d5b0a12f7c`. They are inventory, not frozen
rollback targets. Population must re-read both and bind:

```text
solid_source_commit = __UNRESOLVED_MERGED_SOLID_SHARED_ORIGIN_COMMIT__
solid_rollback_version = __UNRESOLVED_CURRENT_STAGING_SOLID_VERSION__
api_next_rollback_version = __UNRESOLVED_CURRENT_STAGING_API_NEXT_VERSION__
protected_origin_availability = __UNRESOLVED_EXACT_HOST_AVAILABILITY_EVIDENCE__
```

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

The staging database ledger is unresolved. The production 0048 observation
does not establish staging state, and the source tree's latest filename at
discovery is not a permanent migration ceiling.

At population time, select one clean api-next commit and freeze:

```text
api_next_source_commit = __UNRESOLVED_EXACT_STAGING_DEPLOYMENT_COMMIT__
expected_latest_migration = __UNRESOLVED_LATEST_MIGRATION_AT_SELECTED_COMMIT__
checksums_ledger_sha256 = __UNRESOLVED_CHECKSUMS_JSON_SHA256__
staging_backup_reference = __UNRESOLVED_VERIFIED_STAGING_BACKUP_REFERENCE__
staging_migration_command = __UNRESOLVED_ACCEPTED_STAGING_MIGRATION_COMMAND__
```

A read-only credential must compare every applied migration from 0001 through
the selected commit with `db/postgres/migrations/checksums.json`. Record the
exact missing ordered suffix and each expected digest. A separately authorized
ceremony takes and independently verifies a staging backup, applies the suffix
once in order, stops at the first precondition or digest failure, and proves
the complete post-state ledger before any api-next deployment. Recovery is
forward repair or database restoration, not a Worker rollback.

## Staging authority fixture

Root custody is not a prerequisite for the isolated preflight. The staging
operator may use candidate-05 for continuity only after the owner supplies its
label out of band, or may generate an opaque synthetic HNS-valid root label
that is proved absent from production and staging. No index-to-name mapping is
written to this repository.

The exact staging-only values remain unresolved:

```text
test_root = __UNRESOLVED_OPAQUE_STAGING_TEST_ROOT__
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

The staging source task must freeze this exact isolated profile:

```text
mode = staging-shadow
gateway_listener = 127.0.0.1:4269
health_listener = 127.0.0.1:4271
unit = pirate-hns-community-app-gateway-staging-shadow.service
release_root = /srv/pirate-hns-community-app-gateway-staging-shadow
credential_root = /etc/pirate/hns-community-app-gateway-staging-shadow
```

The source-closed artifact remains
`dist/pirate-hns-community-app-gateway.mjs`, but its source commit and bytes
are derived together only after both code blockers land:

```text
api_next_source_commit = __UNRESOLVED_EXACT_STAGING_DEPLOYMENT_COMMIT__
bundle_sha256 = __UNRESOLVED_STAGING_COMMUNITY_GATEWAY_BUNDLE_SHA256__
manifest_sha256 = __UNRESOLVED_STAGING_DEPLOYMENT_MANIFEST_SHA256__
```

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

## Ordered execution after separate authorization

1. Merge both source blockers, then re-derive repository refs, configuration,
   Worker versions, protected-host availability, VPS state, listener
   ownership, and the staging ledger.
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
