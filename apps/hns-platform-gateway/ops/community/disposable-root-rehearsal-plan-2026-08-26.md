# Disposable-root community and handle rehearsal plan

Status: combined draft, non-executable

Plan date: 2026-08-26

Evidence cutoff: 2026-08-26T18:07:58+04:00

This is the dated discovery checkpoint for the first interactive external
community origin. It does not authorize any provider, database, DNS, key,
certificate, deployment, Privy, Access, Caddy, systemd, or Handshake mutation.
Every unresolved marker beginning with `__UNRESOLVED_` is a hard stop. The
execution transcript must be a separately accepted addendum; this draft may
not be treated as that addendum.

The intended result is one coherent pair:

```text
https://pirate.sc/c/<root>   canonical community route
https://app.<root>           direct interactive HNS application origin
```

The 2026-08-27 amendment below adds a third surface on the same disposable
root:

```text
https://<handle-label>.<root> public hosted persona origin
```

The production `pirate` root, `app.pirate`, its certificate, its DNSSEC keys,
and its gateway release are preservation targets, not rehearsal inputs.

## Staged acceptance amendment — 2026-08-28

The first live pilot uses Handshake mainnet and the disposable `11qx` root,
but it is hosted by the staging application, database, and Privy tuple. This is
a true acceptance gate for public HNS resolution, NS/glue and DS delegation,
DNSSEC, DANE, the freshly provisioned gateway, the direct `app.11qx` origin,
the hosted-persona origin, and the complete free handle lifecycle. It is not a
non-binding shadow and it does not prove the canonical
`https://pirate.sc/c/11qx` route.

The canonical `pirate.sc` route, production Privy composition, and production
application/database integration move to a separately populated and separately
authorized second pilot. Passing stage one does not authorize stage two. Stage
one must not apply a production migration, create production activation,
offering, reservation, claim, grant, route, replay, or evidence state, or use
the production Privy application. Any production data-plane write remains a
hard stop until the second pilot's exact migration and mutation ceremonies are
accepted.

Each stage has one internally coherent environment tuple. The mainnet root and
public gateway evidence from stage one may be retained for comparison, but no
database identity, activation generation, replay store, protected origin,
credential, deployment reference, or evidence record may be shared across the
staging and production tuples. Moving from stage one to stage two is a new
pilot population, not promotion of staging rows in place.

## Combined rehearsal amendment — 2026-08-27

This amendment consolidates the third-party-root `hosted_persona_v1` pilot
into the existing disposable-root rehearsal. The community application and
handle-persona surfaces share the root-selection, NS/glue and DS delegation,
authoritative zone, gateway release, source-closure, migration, custody,
observability, suspension, recovery, and rollback ceremonies. They therefore
must use one populated environment tuple and one mutation authorization rather
than independent rehearsals competing for the same root.

The provider, VPS, chain, and database observations later in this document are
historical evidence at their stated cutoffs. They are not claims about current
external state. No provider inventory was refreshed for this amendment. A
separately authorized population addendum must re-read every external input
and freeze the exact api-next and Solid commits before any execution.

The current public api-next source contains PostgreSQL migrations through
`0064_media_persona_recipient_trigger.sql`. The earlier `0049` through `0055`
gap below remains a dated discovery finding, not a sufficient migration plan.
The population addendum must compare the live ledger against
`db/postgres/migrations/checksums.json` at the exact selected deployment
commit and name every missing migration. Plan review does not authorize any
migration, including the previously identified `0049`-onward production
ceremony.

### Owner decision register

Document preparation may continue, but stage-one population and execution stop
until the workspace owner records these decisions:

1. one exact disposable Handshake root, its network, and access-controlled
   custody proof;
2. the staging application, database, Privy, gateway, protected-origin,
   credential, replay, deployment, and evidence tuple for the first live
   pilot;
3. the exact stage-one migration and mutation scopes, including rollback
   limits and proof that production is unreachable from the selected tuple.

The production tuple and its migration and data-plane mutation decisions are
deferred. They become hard stops only if the workspace owner elects to
populate the optional second pilot after stage one passes.

Staging containment is not permission to publish a root. Stage one requires a
separately authorized mainnet root mutation and real public HNS, DNSSEC, DANE,
gateway, and browser-origin proof while keeping application and database state
in staging. It proves no production identity or canonical `pirate.sc` behavior.
The populated addendum must reject any attempt to mix the two environment
tuples or to reuse the platform's protected `pirate` root.

### Frozen handle pilot profile

The handle portion is the ratified free-only V1 profile. It uses family `hns`,
fulfillment `hosted_persona_v1`, and a public host of
`<handle-label>.<root>`. It never delegates a child zone and never grants DNS
control. It must not introduce payment, auction, renewal, resale, transfer,
wallet provisioning, Spaces, or delegated-zone behavior.

The first public grant uses a broad `label_rule_v2` offering with grammar
`hns_ascii_ldh_1_63_v1`, a seller-narrowed launch length band of 8 through 15
characters, `first_come_v1`, `free_v1`, and the default cap of one active grant
per account for the offering. The 8–15 setting is launch configuration inside
the ratified seller-narrowable 8–32 broad band; it does not change the contract
or backend grammar. The selected label must be canonical lowercase LDH, must
not be reserved, and must be inside the configured 8–15 launch band.

An exact-label direct grant may be rehearsed only as a separately named
optional case using the recipient-generated, short-lived token flow; it is not
required to prove the first free pilot. The backend exact-label grammar remains
1–63 characters, but this pilot must not select or invite an exact label longer
than 15 characters.

The first pilot pins the existing platform-reserved label document and proves
at least one label from that resolved set is unavailable through both broad and
exact precedence. Namespace-owner-authored reserved labels remain a parallel
follow-up and are not a prerequisite for this first pilot.

The buyer must already own one active public persona with its confirmed,
indexed EVM wallet. Handle operations must neither create nor repair a persona
or wallet. The transcript retains opaque ids, generations, hashes, outcome
classes, and timestamps, but not account identifiers, wallet credentials,
recipient-token bytes, cookies, or other authentication material.

Before execution, the population addendum must replace these identifiers:

```text
sale_namespace_activation_id = __UNRESOLVED_SALE_NAMESPACE_ACTIVATION_ID__
sale_namespace_activation_generation = __UNRESOLVED_SALE_NAMESPACE_ACTIVATION_GENERATION__
offering_id = __UNRESOLVED_FREE_BROAD_OFFERING_ID__
offering_revision = __UNRESOLVED_FREE_BROAD_OFFERING_REVISION__
offering_v2_hash = __UNRESOLVED_FREE_BROAD_OFFERING_V2_HASH__
buyer_persona_public_id = __UNRESOLVED_EXISTING_WALLET_BACKED_PERSONA_REFERENCE__
handle_label = __UNRESOLVED_CANONICAL_8_TO_15_CHARACTER_LABEL__
quote_id = __UNRESOLVED_HANDLE_QUOTE_ID__
reservation_id = __UNRESOLVED_HANDLE_RESERVATION_ID__
claim_id = __UNRESOLVED_HANDLE_CLAIM_ID__
grant_id = __UNRESOLVED_HANDLE_GRANT_ID__
grant_generation = __UNRESOLVED_HANDLE_GRANT_GENERATION__
handle_host = __UNRESOLVED_HANDLE_LABEL__.__UNRESOLVED_ROOT__
```

### Handle lifecycle after separate authorization

The handle lifecycle is appended to, and cannot bypass, the infrastructure
sequence later in this plan:

1. Complete source closure and the authorized migration, deployment, gateway,
   root, NS/glue, DS, DNSSEC, DANE, custody, and observer gates. Prove the
   selected root is purpose-dedicated and the platform `pirate` root is
   excluded.
2. Establish one sale-namespace activation only after the seller-management
   authority, verified namespace authority, active DNS zone, current Pirate
   NS/glue and DS selection, exact gateway, and literal whole-zone replacement
   confirmation all agree. Record its id and generation.
3. Create and activate one broad free offering with the frozen profile above.
   Record the immutable revision and hash used by every downstream object.
4. Select the already-active wallet-backed persona, request a quote for the
   canonical label, reserve it once, and finalize one claim into one active
   grant. Each step must pin the activation, offering revision and hash,
   fulfillment, persona, handle identity, and prior-object hash required by
   its contract.
5. Resolve and request exact public `GET /` and `HEAD /` on
   `<handle-label>.<root>`. The HNS gateway, Solid authority path, and api-next
   authority path must agree on profile
   `pirate-hns-community-handle-persona-public-gateway-v1`, the exact host,
   current deployment, activation generation, namespace-authority generation,
   grant generation, and public persona. Query strings, request bodies,
   sessions, wallet authority, writes, redirects, hidden exchanges, and
   retries are forbidden on this profile.
6. Exercise the failure matrix one cause at a time: sale activation
   suspension, namespace-authority loss, DNS-zone or NS/glue/DS drift, gateway
   or deployment mismatch, grant-generation mismatch, non-public persona,
   malformed host, and unavailable authority. Commerce and public serving
   must fail closed while the grant remains retained.
7. Restore only through fresh current authority and the generations required
   by the governing contracts. The same retained grant becomes serviceable
   again without release, reissue, or resale. Replayed envelopes and all stale
   generations remain rejected.
8. Suspend the offering and prove new quotes stop without invalidating the
   active grant. Then retire or retain each reversible pilot resource exactly
   as named in the accepted cleanup addendum. Never infer that a mined
   Handshake UPDATE or an applied database migration is reversible.

### Combined acceptance additions

In addition to the community-application acceptance transcript later in this
document, the combined transcript must prove:

- the seller storefront contract is `/c/<community_id>/names`, while the
  public handle host serves only the persona-public `GET /` and `HEAD /`
  profile;
- one 8–15-character broad label is granted for zero price to one pre-existing
  wallet-backed persona, and the default one-active-grant cap rejects a second
  concurrent grant for the same account and offering;
- one label from the pinned platform-reserved set is unavailable through both
  broad and exact precedence; owner-authored namespace blocklists are not a
  prerequisite for this first pilot;
- the quote, reservation, claim, grant, activation, offering revision,
  namespace authority, DNS zone, gateway, forwarder, and deployment evidence
  are mutually consistent and current;
- exact host matching rejects unknown labels, sub-subdomains, alternate roots,
  malformed names, and the protected `pirate` root;
- the public response identifies the selected public persona without exposing
  account, wallet, session, recipient-token, or private-persona authority;
- loss of any current root, delegation, zone, gateway, activation, grant, or
  persona predicate fails closed without deleting the grant; and
- recovery uses fresh authority generations and the retained grant, while
  stale and replayed evidence remains unusable.

Passing the community application surface does not imply that the handle
surface passed. A private staging shadow proves neither public surface; the
stage-one mainnet pilot is distinct because it exercises the public root and
gateway while retaining staging application and database state. Community,
handle, and canonical production-route evidence must be reported separately.

## Decision summary and stop conditions

The three activation-wiring blockers are complete in source. No fourth
activation-code task is presently required. api-next production assembly,
Solid production ingress assembly, and the separate VPS community executable
all exist at the accepted repository heads described below. Every declared
HNS enable switch remains `"false"`, so nothing is live.

This plan selects the staging application/database tuple for the first live
mainnet pilot. That stage deliberately excludes the canonical route at
`pirate.sc`; proving that route is a separate production-tuple acceptance run
that cannot be inferred from stage one or performed under its authorization.

No disposable root is proposed yet. The read-only HSD observer proved public
chain state for several names, but no wallet or owner-account source was
available and every inspected name already has on-chain records and an
authoritative zone. Naming one as unused would therefore contradict the root
selection gate. The workspace owner must perform the read-only owner-account
ceremony in this plan and nominate exactly one root before the plan can be
populated or accepted.

External work remains stopped for these reasons:

1. `__UNRESOLVED_OWNER_VERIFIED_DISPOSABLE_ROOT__` and its owner account are
   not known.
2. Production is recorded as applied only through PostgreSQL migration 0048,
   while the current repository ledger runs through 0055. Live ledger state
   has not been proved with a migration-reader credential, and the separately
   authorized 0049-through-0055 migration ceremony has not occurred.
3. Cloudflare Access is not enabled for the account, so there is no team
   domain, application, AUD tag, or service token to bind.
4. `pirate-deployment-verify@gateway.service` reports a checksum mismatch for
   `/etc/caddy/caddy.json`: its installed-file manifest expects the retained
   pre-target digest while the active, separately validated configuration has
   a different digest. The primary and secondary DNS verifiers exit
   `NOTCONFIGURED`. The encrypted backup job uploads and verifies retention,
   then exits `NOTCONFIGURED`. These pre-existing conditions require a
   separately reviewed resolution or explicit risk disposition before
   mutation.
5. The gateway bundle, disposable DNSSEC keyset, DANE certificate, complete
   zone bytes, Caddy candidate, and Handshake transaction bytes do not exist.
   Their placeholders make this plan non-executable.

## Evidence sources and read-only inventory

Repository evidence was re-derived from clean canonical heads and the claimed
worktree on 2026-08-26, most recently at the evidence cutoff above. VPS clock
observations were `2026-08-26T13:11:21Z` on the primary and
`2026-08-26T13:16:03Z` on the secondary. Provider state was queried through
the active Wrangler OAuth session on 2026-08-26. Provider-generated resource
creation times are retained below where available. All external values must
be re-read immediately before an accepted mutation.

The source authorities for this record are:

- `docs/specs/api-next/009-hns-verification-host-topology.md`, especially
  sections 5.1, 5.2, 5.7, and 6;
- `docs/specs/api-next/012-community-routes-and-handles.md` for operator-route,
  DNS-zone, app-host, and environment authority;
- `docs/specs/api-next/014-account-persona-wallet-privacy.md` for identity and
  persona isolation;
- `apps/hns-platform-gateway/ops/COMMUNITY.md` and its adjacent deployment,
  systemd, and Caddy templates;
- `docs/api-next/secrets-contract.md` for custody boundaries and the last
  recorded production migration ceremony;
- the task record
  `tasks/active/hns-disposable-root-infrastructure-rehearsal.md` in the parent
  workspace;
- read-only Wrangler queries against account
  `08a4c22cf52e2ecae883e36f80a33f4a`;
- read-only SSH, systemd, socket, Caddy, Docker, HSD, PowerDNS, OpenSSL, backup,
  and deployment-verifier queries on the two retained authority hosts.

No secret value or private-key byte was printed or retained. The Cloudflare
OAuth token was passed only in process memory to read-only API calls.

### Repository and source closure

The source-closure audit used discovery base
`4930e8aaf75c9a19cd90fe67f9c6586602c32ccb`, which contains the merged HTTP
Worker production composition and separately named community VPS bundle. By
the correction review, api-next `main` and `origin/main` had advanced to
`1e0b4e561b6cb12e9bce275f9fe90762365f4f4f`, including changes under a package
consumed by the gateway bundle. Neither commit is frozen as the future
deployment candidate. The population ceremony must re-derive the exact clean
api-next commit, audit its delta from the source-closure base, and build the
bundle from that same commit.

The accepted Solid source-closure commit is
`37e09a1080f52f3506bf7a5327907ea1f872a0f2`. Both canonical trees were clean at
discovery.

api-next now assembles `makeProductionHnsCommunityAppApiComposition` from the
production Worker graph. Activation of one environment requires all of these
values in that exact environment:

```text
HNS_COMMUNITY_APP_API_ENABLED
HNS_COMMUNITY_APP_API_PROTECTED_ORIGIN
HNS_COMMUNITY_APP_API_ACCESS_ISSUER
HNS_COMMUNITY_APP_API_ACCESS_JWKS_URL
HNS_COMMUNITY_APP_API_ACCESS_AUDIENCE
HNS_FORWARDER_V3_KEY_REGISTRY_REFERENCE
HNS_FORWARDER_V3_KEY_REGISTRY_VERSION
HNS_FORWARDER_V3_HMAC_KEY_REGISTRY
HNS_FORWARDER_V3_FRESHNESS_WINDOW_SECONDS
HNS_FORWARDER_V3_FUTURE_CLOCK_SKEW_SECONDS
HNS_COMMUNITY_APP_API_REPLAY
```

The private authority capability is
`POST /internal/hns/solid-host-authority/v2/resolve`. The protected application
branch is `/api` and `/api/*`. Unsafe requests require the exact dynamic Origin
`https://app.<normalized-root>`. Current authority comes from the selected
control-plane database. Both branches are intended to share one exact
protected api-next origin, Access validator, and pinned api-next audience;
their downstream wire validation is different. Solid task
`solid-hns-community-app-shared-protected-api-origin` completed on 2026-08-26
at commit `c7aee1c1c6f938861558a4c39e308141ddc8a28e`. Current Solid source
permits equal `HNS_COMMUNITY_APP_API_ORIGIN` and
`HNS_COMMUNITY_APP_AUTHORITY_ORIGIN` values while retaining distinct API and
authority service-token credentials. Its production configuration and direct
composition fixture use the shared protected api-next origin required by the
api-next graph. The populated addendum must pin source commits that retain
this model and rerun both repositories' assertions; it may not invent a third
Access application or api-next deployment. The Durable
Object migration tag is `v4`, the class is
`HnsForwarderReplayStoreDO`, and the consumer scope is
`pirate:hns-forwarder-v3:api-next-community-app-api:v1`.

Solid compares the request origin with
`HNS_COMMUNITY_APP_INGRESS_ORIGIN` before assembling the HNS graph. Ordinary
ICANN, preview, and `workers.dev` requests never await HNS assembly. An HNS
assembly failure is contained to the protected origin as a redacted,
`no-store` 503, and a rejected assembly is not cached. Activation requires:

```text
HNS_COMMUNITY_APP_INGRESS_ENABLED
HNS_COMMUNITY_APP_INGRESS_ORIGIN
HNS_COMMUNITY_APP_CANONICAL_ORIGIN
HNS_COMMUNITY_APP_API_ORIGIN
HNS_COMMUNITY_APP_ACCESS_ISSUER
HNS_COMMUNITY_APP_ACCESS_JWKS_URL
HNS_COMMUNITY_APP_ACCESS_AUDIENCE
HNS_COMMUNITY_APP_AUTHORITY_ORIGIN
HNS_COMMUNITY_APP_GATEWAY_DEPLOYMENT_REFERENCE
HNS_FORWARDER_V3_KEY_REGISTRY_REFERENCE
HNS_FORWARDER_V3_KEY_REGISTRY_VERSION
HNS_FORWARDER_V3_HMAC_KEY_REGISTRY
HNS_FORWARDER_V3_FRESHNESS_WINDOW_SECONDS
HNS_FORWARDER_V3_FUTURE_CLOCK_SKEW_SECONDS
HNS_COMMUNITY_APP_API_ACCESS_CLIENT_ID
HNS_COMMUNITY_APP_API_ACCESS_CLIENT_SECRET
HNS_COMMUNITY_APP_AUTHORITY_ACCESS_CLIENT_ID
HNS_COMMUNITY_APP_AUTHORITY_ACCESS_CLIENT_SECRET
HNS_COMMUNITY_APP_REPLAY
```

The two Solid service-token pairs must be different. After the shared-origin
correction, equality of the two protected api-next origins is allowed only
when those credentials remain distinct. The Solid replay Durable Object
migration tag is `v1`, its class is
`HnsCommunityAppReplayStoreDO`, and its consumer scope is
`pirate:hns-forwarder-v3:pirate-web-solid-community-app:v1`.

The gateway uses the separate
`dist/pirate-hns-community-app-gateway.mjs` artifact. The accepted authority
boundary is `postgres-readonly-v1`: the VPS receives a distinct, server-
enforced, TLS-verified read-only database credential and calls
`resolve_hns_community_app_host_authority_v1(TEXT, TIMESTAMPTZ)`. It does not
call the Solid private wire, avoiding a circular gateway-to-Solid-to-api-next
authority path. The database role may read only that function's dependencies
and may not mutate, migrate, own, or administer data.

The immutable interactive profile is exactly 622 UTF-8 bytes with SHA-256:

```text
f49ac37bd45da71bdf1e1cc65f184729d85f9d72ce811f0551a70f7785aa8d86
```

The production gateway and health listeners are `127.0.0.1:4069` and
`127.0.0.1:4071`. Shadow uses `127.0.0.1:4169` and `127.0.0.1:4171`. The unit
names are:

```text
pirate-hns-community-app-gateway.service
pirate-hns-community-app-gateway-shadow.service
pirate-hns-community-app-gateway-rollback.service
```

The manifest names four logical systemd credentials without containing their
values:

```text
hns-community-authority-database-url
hns-community-forwarder-key-registry
hns-community-solid-access-client-id
hns-community-solid-access-client-secret
```

The optional staging engineering preflight is specified separately in
`staging-shadow-preflight-plan-2026-08-26.md`. It requires a source-closed
`staging-shadow` mode on 4269/4271 and may not consume the production shadow
listeners 4169/4171. That staging-only executable mode does not change the
production listener plan above.

### Cloudflare account and Worker estate

The active account id is `08a4c22cf52e2ecae883e36f80a33f4a`. The expected
named Wrangler profile `api-next-canonical` is absent; only the active default
profile was available. Before any accepted provider call, either restore that
named profile or explicitly bind the verified default session to the account
id in the execution addendum. A profile label is not account identity.

The `pirate.sc` zone is active, full, and not paused. Its id is
`b027d7e2ef3fc3a089713fe118eafbca`; its assigned Cloudflare authorities are
`nelci.ns.cloudflare.com` and `yahir.ns.cloudflare.com`. The OAuth grant could
read zone identity but lacked DNS-record scope, so current ICANN record content
was not inventoried through the API.

The current production Worker rollback baselines are:

| Boundary | Worker | Current version | Created | Runtime state |
| --- | --- | --- | --- | --- |
| Solid | `pirate-web-solid-production` | `d20fa9cc-2e3f-41c1-b76d-f73383e5ad26` | 2026-08-25T17:54:59.825266Z | no HNS secret or replay binding |
| api-next | `pirate-http-worker-production` | `1d959450-d0c6-4338-921e-1929069119e3` | 2026-08-25T13:50:07.314186Z | migration tag `v3`; HNS ownership false; no community replay binding |

The exact current Solid binding names are `API_NEXT_ORIGIN`, `ASSETS`,
`PRIVY_APP_ID`, and `VERIFICATION_UI_ENABLED`. The exact current api-next
binding names are:

```text
API_NEXT_ENV
COMMUNITY_PURCHASE_FUNDING_RPC_URL
CONTROL_PLANE
CORS_ORIGIN
HNS_OWNERSHIP_ENABLED
PIRATE_API_PUBLIC_ORIGIN
PIRATE_APP_JWT_AUDIENCE
PIRATE_APP_JWT_ISSUER
PIRATE_APP_JWT_PRIVATE_KEY
PIRATE_APP_JWT_PUBLIC_KEY
PIRATE_APP_JWT_SCOPE
PRIVY_API_URL
PRIVY_APP_ID
PRIVY_APP_SECRET
PRIVY_JWKS_URL
PRIVY_JWT_AUDIENCE
PRIVY_JWT_ISSUER
REGISTRATION_APPLICATION_LIMIT
REGISTRATION_APPLICATION_LIMITER
REGISTRATION_APPLICATION_WINDOW_SECONDS
REGISTRATION_IP_LIMIT
REGISTRATION_IP_LIMITER
REGISTRATION_IP_WINDOW_SECONDS
SELF_PASS_APP_NAME
SELF_PASS_ENABLED
SELF_PASS_MOCK_PASSPORT
VERIFICATION_CALLBACK_CREDENTIAL_HEADERS
VERY_OAUTH_ENABLED
```

The two existing registration Durable Object namespace ids are
`020a631829c24dbba93e8d1640dec778` and
`1d3a38c02abe47da92169b5ff908069d`; they are unrelated preservation targets.

The current staging rollback baselines are Solid version
`f081e8a2-651e-4888-befb-d6abdd43e572` and api-next version
`ba5c573b-015d-410d-a8a0-d6d5b0a12f7c`. They are inventory only and are not
part of the selected tuple.

The production api-next Worker currently uses Hyperdrive id
`884b68c5a7904982a86620ed90032b77`, name `api-next-production`, database
`postgres` at `us-east-1.pg.psdb.cloud:5432`, with a connection limit of 60.
No credential was disclosed. Current api-next production secret names are
`COMMUNITY_PURCHASE_FUNDING_RPC_URL`, `PIRATE_APP_JWT_PRIVATE_KEY`, and
`PRIVY_APP_SECRET`; Solid has no production secrets. None of the required HNS
registry or Access secret references exists.

The currently assigned Worker custom domains are:

| Host | Worker |
| --- | --- |
| `pirate.sc` | `pirate-web-solid-production` |
| `api-next.pirate.sc` | `pirate-http-worker-production` |
| `web-next-staging.pirate.sc` | `pirate-web-solid-staging` |
| `api-next-staging.pirate.sc` | `pirate-http-worker-staging` |

No Cloudflare Tunnel exists in the account. Cloudflare Access application
enumeration returned `access.api.error.not_enabled`; therefore no team-domain
issuer, Access application, generated AUD tag, or service token can be
recorded yet.

The first post-merge Solid deployment would provision
`HNS_COMMUNITY_APP_REPLAY` and apply Durable Object migration `v1`, even while
its switch is false. The first post-merge api-next deployment would provision
`HNS_COMMUNITY_APP_API_REPLAY` and apply migration `v4`. Each is an explicit
provider mutation in the execution plan; neither may ride an unrelated
deployment.

### Retained primary VPS

The primary is `94.103.168.161`, observed through its role account. It runs
Bun `1.3.14`. The current static gateway unit is enabled and active from
release:

```text
/srv/pirate-hns-platform-gateway/releases/e7b0b247613691c27aedfd80da63d8a79615f10d
```

Its bundle SHA-256 is:

```text
619c035de3b8588cd9a429d03df1e997febaf27ebfe5e55ac325e33b00548120
```

That process owns `127.0.0.1:4049` and `127.0.0.1:4051`; `/livez` and
`/readyz` both returned 204. Ports 4069, 4071, 4169, and 4171 were unowned and
no community unit was installed. A path-preserving bare-root probe redirected
to `https://app.pirate/example/path?probe=1`; an unowned host returned 421.

Caddy is enabled and active. The live bytes and retained rollback bytes are:

| File | SHA-256 | Validation |
| --- | --- | --- |
| `/etc/caddy/caddy.json` | `4e9f56608383a66771ac27510f1aca25bef8a908784ee8b601840b89fd5b294f` | valid with `/usr/local/bin/pirate-caddy` |
| `/etc/caddy/caddy.json.pre-target-static-gateway-20260825` | `2e450f1ebee39a0f33bf2a0fcf17de093088c47fdd6b1bc9fe5df7177608c8db` | valid with `/usr/local/bin/pirate-caddy` |

The stock `caddy validate` rejects the installed custom `rate_limit` handler;
that is a binary mismatch, not evidence of invalid active bytes. Every planned
validation command must use `/usr/local/bin/pirate-caddy`.

The gateway drift signal was re-derived read-only. Unit
`pirate-deployment-verify@gateway.service` last failed at
`2026-08-26T04:44:10Z`. Its manifest
`/srv/pirate-hns-gateway/config/INSTALLED_SHA256SUMS` expects this entry:

```text
2e450f1ebee39a0f33bf2a0fcf17de093088c47fdd6b1bc9fe5df7177608c8db  /etc/caddy/caddy.json
```

The observed active file is:

```text
4e9f56608383a66771ac27510f1aca25bef8a908784ee8b601840b89fd5b294f  /etc/caddy/caddy.json
```

The manifest was last modified `2026-08-13T19:31:34.545176523Z`; the active
Caddy file was modified `2026-08-24T20:56:42.892088233Z`. All other six host
files in that manifest passed, as did the two runtime-executable checks, five
effective-systemd-unit checks, and config hash. This evidence localizes the
mismatch to the later Caddy promotion, but it does not authorize updating the
manifest or dismissing the verifier. The owner must accept the expected active
bytes and separately authorize a verifier-baseline repair before rehearsal
mutation.

The production DANE certificate is evidence only and must not be reused. It is
`CN=Pirate HNS DANE gateway`, serial
`6E6606010FAA1405B56BD2BE5C0D697D2D8FE078`, valid from 2026-07-19 through
2027-08-20 UTC. Its SPKI SHA-256 is:

```text
5c8ddd3dbf63dbab698c726708b06177adda4a21416c675197f97e3b27ab20d8
```

HSD runs mainnet in healthy container `pirate-hsd-observer` from image
`pirate-hsd-observer:8.0.0` on `127.0.0.1:12037`. At observation its block and
header height were 344322, progress was 1, and best hash was
`0000000000000011350a491c12c0c2f838c233f2e44970943eb2faac0b110e34`.

PowerDNS runs in `pirate-hns-authdns`. Its inventory contains the eight opaque
candidate zones indexed in the root inventory below, the protected `pirate`
zone, and one unrelated retained child zone. The public repository deliberately
does not retain candidate index-to-name mappings. The production `pirate` zone
is master, serial `2026072002`, and allows AXFR through logical TSIG reference
`pirate-axfr`. It has NSEC semantics and is signed by PowerDNS key id 1, an
active and published 257 CSK using algorithm 13 with tag 34383. Its type-2 and
type-4 DS digests are respectively:

```text
2c16acbc6081a8eeca4582ff967ebba29f30e2df5abd845dd2d1992449ebeecd
3c48cc64c1ed89b267850e3d97de40672c4be4ef4f0538c775c68412faa81dc3c5c65418aa24db3bdd7b5ffec8e64005
```

`app.pirate` resolves to `94.103.168.161` and its TLSA matches the SPKI above.
The production zone check returned zero errors and one existing wildcard-TLSA
warning. These production values are invariants, not reusable rehearsal key
or certificate material.

Encrypted backups are uploaded to logical remote
`pirate-b2:pirate-hns-state-backup/snapshots`, with at least 30 days retained
under compliance mode. Local source paths include the PowerDNS database under
`/srv/pirate-hns-authdns/shared/data/pdns.sqlite3`, runtime state under
`/var/lib/pirate-hns`, and certificate material under
`/etc/caddy/hns-dane`. Recent logs showed upload and retention verification,
then exit 6 `NOTCONFIGURED`. No backup or key bytes were opened.

### Retained secondary authority

The secondary is `81.15.150.159`, observed through its role account. It runs
`pirate-hns-secondary-dns`, serves TCP and UDP 53, and carries `pirate` as a
presigned slave zone from the primary. At observation its serial was
`2026072002`, with the same DNSKEY and DS data; the recorded transfer update
was `2026-08-26T12:45:47Z`.

Its zone inventory also contains the primary set plus retained `ai.sdk`,
`wallet.sdk`, and `agent.sdk` zones. Those unrelated zones are preservation
targets and are not imported into or modified by the rehearsal.

Host-local direct queries on both authorities returned identical `pirate` SOA,
`app.pirate` A, TLSA, and DNSKEY data. Direct queries from the execution
environment to both public port-53 endpoints were refused. This discovery is
not independent external-view proof. Acceptance therefore requires two
separate deployment-vantage transcripts, not two queries issued from the same
runner or two recursive answers derived from one cache.

The secondary deployment verifier reports no byte drift but exits 6
`NOTCONFIGURED`. No local `.age` snapshot was found in the inspected paths.

### Owner-controlled HNS root inventory

The observer is on Handshake mainnet. The name and resource query was refreshed
immediately before `2026-08-26T13:55:35Z`. All candidate names were registered,
closed, and unrevoked. The public owner fields below are chain outpoints, not
proof that an available wallet account controls them. The opaque indices are
local to this public plan. The index-to-name mapping belongs only in redacted,
access-controlled owner-ceremony evidence and must not be committed.

```text
candidate-01
  owner 1a96226223c2b653147996f84ac23a2bdd0963b50c72e39c66f8745c0ae54ea6:0
  renewal 327265; expiry 432385; remaining 88057 blocks
  NS ns1.pirate.
  TXT pirate-verification=nvs_066a3309c6604cc4bcce06a2cc531275

candidate-02
  owner ce240df33c375ab6994e75d402501f43aa4bc8fc5eb53d239318152e98c77e9d:0
  renewal 340917; expiry 446037; remaining 101709 blocks
  NS ns1.pirate.; NS ns2.pirate.
  TXT pirate-verification=nvs_77cce470d4c44448b07cc10324778e17
  DS 56075 13 2 0ab3ce5c1e2964f49c879e1608cf609686eaf21e5f998dfe26a2ca9ecd15ed2e
  DS 56075 13 4 32aa9524ab977fca45947dd81504acd177498cc6bd9ea580483ba0cdbee7d3a5d614a204465fdc821b914f3d0d35a446

candidate-03
  owner 8ae8663fefc0cff064901e5e142e11e91110931507e07cecaa4ecbccc505b497:0
  renewal 326567; expiry 431687; remaining 87359 blocks
  NS ns1.pirate.; NS ns2.pirate.
  TXT pirate-verification=nvs_c041dd8faeb44572a2cfd55a185cb18d
  DS 49194 13 2 053c8350a8e967bc4c3a9e4705e8a133f136fc9ba1f7cd0ae1e33d97609531f1
  DS 49194 13 4 1559ca37322d04104d50d4ed8aa4eede8c2cc3252efbfd6d363b398b936793f00df0b5bc9cce08ba8366053d19b30190

candidate-04
  owner 385bc9bd22ceb39cd7d010b1e4e052a0ea6405e7eb3baa35e65b5a22687de898:0
  renewal 327935; expiry 433055; remaining 88727 blocks
  GLUE4 ns.<candidate-root>. 45.79.214.114
  NS ns1.pirate.; NS ns2.pirate.
  TXT pirate-verification=nvs_cb84a8d43d594c02a208a68d1f2c30fd
  DS 48854 13 2 53524406e5eb3509a67e897d1301109148739d04b9e41f123e6f9261805aea46
  DS 48854 13 4 6bc07f5ae04b5c4f27f15440b10e1400fe6da8ea8ea97e70c23357b4554319ba2346976f6630851bd9f5cf0ec0bfd039

candidate-05
  owner 2fc060eeb66f0d99f5daa5cdecc66ba924da2c56325ba2446eef72fa314e8026:0
  renewal 326576; expiry 431696; remaining 87368 blocks
  NS ns1.pirate.; NS ns2.pirate.
  TXT pirate-verification=nvs_95f773c476c84acb8a237af7ea64b96e
  DS 39280 13 2 7763394f08c984b2fb71c10a8284bb7d5204a76c3a90867be3768417e27ac8e6
  DS 39280 13 4 cfc21a4cfab1a96646b472e3769aea41b28c7c4956b6f17741eb5b82b478c3781e8465a9f3c7ffebdd10443b67df46b8

candidate-06
  owner 219a573488da79ac6325b94c240e2992469a037d0795a829c4762a67edf2ae64:0
  renewal 313242; expiry 418362; remaining 74034 blocks
  GLUE4 ns1.<candidate-root>. 44.231.6.183; NS ns1.<candidate-root>.
  GLUE4 ns2.<candidate-root>. 54.214.136.246; NS ns2.<candidate-root>.

candidate-07
  owner 1d0e6b54354562d4fa2cb901cf7bdcd22bc6b1718b91a3e902bbc4e832277707:0
  renewal 326567; expiry 431687; remaining 87359 blocks
  GLUE4 ns1.<candidate-root>. 44.231.6.183
  NS ns1.pirate.
  TXT pirate-verification=nvs_b90d88b73b63409eaf445969d39176e6

candidate-08
  owner e4e1afbd730f79908c06cc2567403dd49e0b37af981d145c560df99d7530def8:0
  renewal 333451; expiry 438571; remaining 94243 blocks
  NS ns1.pirate.; NS ns2.pirate.
  TXT pirate-verification=nvs_9cc970eae6194214ad98a76bfa5af3ac
  DS 10875 13 2 ba5d84ad6e3e7ec452a569ee2e6c447ba2b9b533de65c58e59f2f0b7f0773045
  DS 10875 13 4 fde2c7af467092476b5572f9ac43fbbbbe82f63f7c785af984dc5884a2dae0384519dea6982fdbd19c375756b4ebaf70
```

Every candidate already has on-chain NS, glue, DS, or TXT records and an
authoritative zone. The protected `pirate` name had owner outpoint
`adeb7e7dbc0681ad0755bf353aa3b4a5d376e6a413ed6ce8544c84c817e58e07:0`,
renewal 338296, expiry 443416, and 99088 reported blocks remaining. Its exact
NS, glue, and DS values match the protected production inventory above and
were left untouched.

No wallet database or owner-account view was present on either VPS. The
observer proves name state, not custody. Production API probes showed no
old-style `/c/app.<root>` community route for the candidates, while bare-root
requests hit a deployed runtime older than the merged route implementation.
Those probes do not prove absence of third-party use. Root selection remains
unresolved.

### Control-plane database

The repository ledger expected by the current candidate line runs through
`0055_megapot_claim_reconciliation.sql`. The secrets contract records
production migration application only through 0048. No authorized
migration-reader credential was available, so the complete live ledger was not
established. No connection was made and no route, DNS-zone, or app-host row was
created.

At this correction checkpoint, the unapplied candidate range and immutable
repository SHA-256 values are:

```text
0049_bare_hns_community_route_v2.sql       2a6f4614b3cd159fa640e9b77dcc588e06b740fa97aca50b0fa24ff144e1a02c
0050_song_lyrics_foundation.sql            09318fe6ba64eb98d7d98a85d3dd22c631af907f62aedc01ba2448a8cbc61b57
0051_activity_qualification.sql            6358017bcdfbe50b2707d5a2677d5b4ede4e80a00953c3b262fe299af00a70e7
0052_media_finalize_fence.sql              2bb62ec5a5575457cace6abd4bbdbaac0a1ab6b7d508a3dafbb709382cd6d644
0053_rewards_song_offers.sql               5c6175c5e684f6adb0742cb75141e528810ab8b2cb44b1a90391dc72dc730cc0
0054_community_handle_sales.sql            869f13813fb28af2f850b17865057f532500a94a997c9b47587bbe499d6713bf
0055_megapot_claim_reconciliation.sql       7080bc0156f8dfb36202c3e67321bf8bcc7fd4a6d5bd9ccf5710a26aabb7c552
```

These are evidence for the current gap, not a permanent upper bound. Plan
population must derive the final expected migration from the exact deployment
commit and compare the complete `checksums.json` ledger with production. Any
new migration extends the required ceremony before the candidate can be built
or deployed.

## Frozen environment tuple proposals

Subject to separate population and mutation authorization, the selected
stage-one tuple is:

| Member | Proposed exact value |
| --- | --- |
| Pirate environment | `staging` |
| Solid canonical origin | `https://web-next-staging.pirate.sc` |
| api-next origin | `https://api-next-staging.pirate.sc` |
| Privy application | `cmsw5pis300b80cladbxx7bsr` |
| Handshake network | `main` |
| disposable root | `11qx` |
| staging community route | `https://web-next-staging.pirate.sc/c/11qx` |
| public HNS origin | `https://app.11qx` |
| Solid source | `4f511992b3473c620ff48a459672464328cb0561` |
| api-next source | `72619e2817cb268f170d9044e5d586643e54957e` |
| Solid Worker | `pirate-web-solid-staging` |
| api-next Worker | `pirate-http-worker-staging` |
| control plane | Hyperdrive `8cb7658a0f7143359c1becfec6a15c23`; PostgreSQL origin `postgresql://us-east-3.pg.psdb.cloud:5432/postgres?sslmode=verify-full`, schema `api_next` |
| gateway authority endpoint | `postgresql://us-east-3.pg.psdb.cloud:5432/postgres?sslmode=verify-full` without credentials |
| Solid protected origin | `__UNRESOLVED_EXACT_STAGING_SOLID_PROTECTED_ORIGIN__` |
| api-next shared protected origin | `__UNRESOLVED_EXACT_STAGING_API_NEXT_PROTECTED_ORIGIN__` |
| private authority origin | the same `__UNRESOLVED_EXACT_STAGING_API_NEXT_PROTECTED_ORIGIN__` |

The unresolved staging members are hard stops. The populated addendum must
prove that every selected staging resource is isolated from production and
that the mainnet gateway cannot write production application or database
state. Stage one does not use `https://pirate.sc/c/11qx` and cannot satisfy or
claim canonical production-route acceptance.

The separately gated stage-two production proposal is:

| Member | Proposed exact value |
| --- | --- |
| Pirate environment | `production` |
| Solid canonical origin | `https://pirate.sc` |
| Solid Worker | `pirate-web-solid-production` |
| api-next origin | `https://api-next.pirate.sc` |
| api-next Worker | `pirate-http-worker-production` |
| control plane | Hyperdrive `884b68c5a7904982a86620ed90032b77` and its production Postgres origin |
| gateway authority endpoint | `postgresql://us-east-1.pg.psdb.cloud:5432/postgres?sslmode=verify-full` without credentials |
| Privy application | `cmnbdx9xk00ty0clapn2q8pdj` |
| canonical route | `https://pirate.sc/c/11qx` |
| HNS origin | `https://app.11qx` |
| Solid protected origin candidate | `https://hns-community-ingress.pirate.sc` |
| api-next protected origin candidate | `https://hns-community-api.pirate.sc` |
| private authority origin candidate | `https://hns-community-api.pirate.sc` (same protected api-next origin) |

The production proposal shares the live production Postgres data plane and
Privy application used by ordinary production traffic. Accepting stage two
therefore authorizes neither a disposable sandbox nor reversible test state:
its namespace activation, offering, reservation, claim, grant, route, replay,
and evidence records are production writes, and cleanup is forward repair.
The separately accepted stage-two transcript must state that consequence and
name every production mutation explicitly.

The production candidate protected hosts returned NXDOMAIN and were not
present in the Worker custom-domain inventory at discovery. They are
stage-two reservations only. They must not be reused for stage one, and
creating DNS, Worker domains, Access resources, or secrets for either stage is
prohibited until that stage's populated plan is accepted.

The following identity values remain unresolved:

```text
disposable_root = __UNRESOLVED_OWNER_VERIFIED_DISPOSABLE_ROOT__
handshake_network = main
owner_account = __UNRESOLVED_OWNER_ACCOUNT_REFERENCE__
community_id = __UNRESOLVED_CANONICAL_COMMUNITY_ID__
route_activation_id = __UNRESOLVED_OPERATOR_ROUTE_ACTIVATION_ID__
route_activation_generation = __UNRESOLVED_OPERATOR_ROUTE_GENERATION__
dns_zone_activation_id = __UNRESOLVED_DNS_ZONE_ACTIVATION_ID__
dns_zone_activation_generation = __UNRESOLVED_DNS_ZONE_GENERATION__
app_host_activation_id = __UNRESOLVED_APP_HOST_ACTIVATION_ID__
app_host_activation_generation = __UNRESOLVED_APP_HOST_GENERATION__
gateway_deployment_reference = __UNRESOLVED_GATEWAY_DEPLOYMENT_REFERENCE__
```

## Owner and database read-only ceremonies

Before any mutation, the workspace owner must expose a read-only wallet or
hardware-wallet account view that proves one exact candidate's current
outpoint belongs to the selected account. The transcript records the account
reference, network and genesis identity, tip height and hash, renewal and
expiry heights, all current NS, glue, DS, and TXT bytes, and an explicit
statement that the root has no production or third-party dependency. No seed,
private key, signing prompt, or raw wallet credential enters retained evidence.

The selected name must not be `pirate`, must not collide with a community in
service, and must have enough renewal horizon for the rehearsal and rollback
observation window. Its root label must contain at least one ASCII letter. An
all-digit final hostname label enters the WHATWG IPv4 parser and can make
`https://<handle-label>.<root>/` invalid before DNS resolution, so an
all-numeric root cannot satisfy the browser acceptance path. If no inventoried
name passes, the operation stops; it does not weaken the criteria.

The read-only candidate population for `11qx` is recorded separately in
`disposable-root-population-addendum-2026-08-28.md`. That addendum is evidence
and unresolved-decision tracking only; it does not replace this plan's owner,
environment, migration, or mutation authorization gates.

A separately supplied read-only migration credential must first query the
selected staging database's authoritative migration ledger and prove that the
complete ledger from 0001 through the exact stage-one deployment commit's
latest migration is applied once, in order, with the repository-expected
digests. The stage-one transcript also verifies that the target staging
community and all proposed activation ids are absent before creation. Any
missing staging migration requires its own exact authorization; the stage-one
ceremony must not connect to or mutate production Postgres.

If stage two is later populated, a different read-only ceremony must query the
production database ledger and derive its complete missing range from the
exact stage-two deployment commit. The recorded 0001-through-0048 state and
0049-through-0055 gap below remain dated discovery evidence only. Applying any
production migration and creating any production pilot state require the
separate stage-two authorization. Neither migration-reader credential is
reused by the gateway or allowed to mutate schema or data.

## Cloudflare Access and secret plan

The protected-origin contract is source-closed for one shared api-next origin,
one Access application and pinned audience, and two distinct Solid outbound
credential pairs. Solid commit
`c7aee1c1c6f938861558a4c39e308141ddc8a28e` removed the obsolete inequality,
and current production configuration plus the shared-origin fixture retain
that contract. The populated addendum must cite exact Solid and api-next
source commits, run both repositories' topology assertions, and stop if either
selected commit has drifted from the shared-origin model. This is a source-pin
verification gate, not an unresolved implementation dependency.

The production values below are retained as the stage-two proposal. Stage one
must populate its own staging protected origins and Access resources after the
topology decision; it must not reuse these production reservations.

The account requires an Access organization and two separate self-hosted
applications. The team domain is not guessed. Once the workspace owner chooses
and Cloudflare confirms it, bind these exact values:

```text
issuer = https://__UNRESOLVED_ACCESS_TEAM_DOMAIN__
jwks_url = https://__UNRESOLVED_ACCESS_TEAM_DOMAIN__/cdn-cgi/access/certs
```

The applications and policies are:

| Boundary | Exact protected origin | Generated AUD | Only admitted client |
| --- | --- | --- | --- |
| gateway to Solid | `https://hns-community-ingress.pirate.sc` | `__UNRESOLVED_SOLID_ACCESS_AUD__` | gateway service token |
| Solid to api-next | `https://hns-community-api.pirate.sc` | `__UNRESOLVED_API_ACCESS_AUD__` | Solid API service token |
| Solid to private authority | `https://hns-community-api.pirate.sc` | the same pinned api-next AUD | distinct Solid authority service token |

There are two Access applications and three service tokens. The gateway token
is admitted only to the Solid application. Both Solid tokens are admitted only
to the one api-next application, because the merged api-next graph has one
protected origin, one Access validator, and one pinned audience for both
`/api` and the private-authority path. The two Solid token pairs remain
different and are stored and used by separate outbound clients; api-next then
enforces the distinct v3 `/api` contract and exact private-authority wire.
Creating a third Access application with another AUD would not be source-
closed by the current api-next composition and is therefore prohibited by this
plan. No application has an interactive group or bypass rule.

Cloudflare generates each AUD and one-time secret; neither is invented in this
document. The ceremony writes secret values directly into approved custody and
retains only resource ids, AUD tags, secret-reference names, timestamps, and
redacted checks.

Candidate secret references are:

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

The shared forwarder registry identity is unresolved until its custody record
is created:

```text
registry_reference = __UNRESOLVED_FORWARDER_V3_REGISTRY_REFERENCE__
registry_version = __UNRESOLVED_FORWARDER_V3_REGISTRY_VERSION__
active_key_id = __UNRESOLVED_FORWARDER_V3_ACTIVE_KEY_ID__
```

One registry document serves the gateway signer and both Worker verifiers and
contains exactly one signing key. Secret bytes are never placed in Wrangler
variables, manifests, logs, or evidence. Rotation installs a new version at
all three consumers before promotion, preserves only the explicitly bounded
verification overlap allowed by the schema, then disables and destroys the
retired key after evidence retention.

Both Access validators require issuer, one pinned AUD, RS256 JWKS validation,
at most 60 seconds of clock skew, and a JWKS cache of at most 3600 seconds. One
unknown `kid` triggers exactly one uncached refetch. The two-second private
authority deadline and two-second JWKS deadline are preserved; redirects are
manual and retries are zero. A client-supplied `Cf-Access-Jwt-Assertion` or
service-token header is never authority and is removed at the trusted edge or
rejected on ordinary routes.

## Replay-store plan

Both Workers consume the same unsafe-request nonce independently. The Solid
scope is
`pirate:hns-forwarder-v3:pirate-web-solid-community-app:v1`; the api-next scope
is `pirate:hns-forwarder-v3:api-next-community-app-api:v1`. Durable Object
shards are keyed by `${consumerScope}:${keyId}`. A nonce is atomically accepted
once in each scope and duplicate consumption fails closed.

The configured forwarder freshness window is 300 seconds and future clock
skew is 5 seconds. Replay expiry is freshness plus skew plus one second. Store
unavailability fails the protected request; it never falls back to an in-
memory set or the other consumer's scope.

Pruning is lazy within the shard on later `consume` calls. After a key is
retired and its shard receives no more calls, expired rows remain physically
stored, bounded by nonces accepted during that key's active life. The accepted
lifecycle addendum must choose either retained forensic namespaces for the
transcript retention period or an explicit post-retention namespace deletion.
It may not claim automatic global cleanup.

## Chain, authoritative DNS, DNSSEC, and DANE plan

After root selection, the proposed target delegation is isolated per root:

```text
GLUE4 ns1.<root>. 94.103.168.161
NS    ns1.<root>.
GLUE4 ns2.<root>. 81.15.150.159
NS    ns2.<root>.
DS    <key-tag> 13 2 <SHA-256 digest>
DS    <key-tag> 13 4 <SHA-384 digest>
```

No GLUE6 or AAAA is published because the retained estate does not serve an
authorized IPv6 listener. `app.<root>. A 94.103.168.161` is exact and
`app.<root>. AAAA` is explicitly absent. Any later IPv6 proposal requires a
new network and listener inventory.

The disposable zone uses a new algorithm-13 ECDSAP256SHA256 keyset, NSEC denial,
and a new per-root AXFR credential. It does not reuse the `pirate` DNSSEC key,
certificate private key, or an unscoped production transfer credential. The
key tag and exact DS values remain:

```text
dnssec_keyset_reference = __UNRESOLVED_DISPOSABLE_DNSSEC_KEY_REFERENCE__
dnssec_keyset_version = __UNRESOLVED_DISPOSABLE_DNSSEC_KEY_VERSION__
dnskey_key_tag = __UNRESOLVED_DNSKEY_KEY_TAG__
ds_sha256 = __UNRESOLVED_DS_DIGEST_TYPE_2__
ds_sha384 = __UNRESOLVED_DS_DIGEST_TYPE_4__
```

The DANE-EE certificate is deliberately managed and distinct from production.
Its proposed identity is `CN=Pirate disposable HNS community gateway
<root>`. It may be self-signed because DNSSEC-authenticated TLSA 3 1 1 is the
service identity. These values remain unresolved:

```text
certificate_reference = __UNRESOLVED_DISPOSABLE_DANE_CERTIFICATE_REFERENCE__
certificate_serial = __UNRESOLVED_DISPOSABLE_DANE_CERTIFICATE_SERIAL__
certificate_not_before = __UNRESOLVED_CERTIFICATE_NOT_BEFORE__
certificate_not_after = __UNRESOLVED_CERTIFICATE_NOT_AFTER__
certificate_spki_sha256 = __UNRESOLVED_DISPOSABLE_CERTIFICATE_SPKI_SHA256__
_443._tcp.app.<root>. TLSA 3 1 1 __UNRESOLVED_DISPOSABLE_CERTIFICATE_SPKI_SHA256__
```

Key and certificate creation occurs only during an accepted ceremony. Private
bytes go directly to restricted custody; encrypted backups are independently
restored in a throwaway check before activation. Rotation publishes and proves
a new zone revision and activation generation, with an explicitly bounded
two-TLSA overlap if required. Revocation suspends the app host before removing
the TLSA. Destruction occurs only after the transcript retention period and
requires a separate destructive-action approval.

The complete authoritative zone is generated only after root, key, certificate,
and activation values exist. Its required logical content is:

```text
$ORIGIN <root>.
@ SOA ns1.<root>. hostmaster.<root>. __UNRESOLVED_ZONE_SERIAL__ 3600 900 1209600 300
@ NS ns1.<root>.
@ NS ns2.<root>.
ns1 A 94.103.168.161
ns2 A 81.15.150.159
app A 94.103.168.161
_443._tcp.app TLSA 3 1 1 __UNRESOLVED_DISPOSABLE_CERTIFICATE_SPKI_SHA256__
```

The serialized record set and digest remain:

```text
zone_bytes = __UNRESOLVED_EXACT_AUTHORITATIVE_ZONE_BYTES__
zone_bytes_digest = __UNRESOLVED_AUTHORITATIVE_ZONE_SHA256__
```

PowerDNS adds the generated DNSKEY, RRSIG, and NSEC records. The final plan
addendum retains canonical zone bytes, serial, `zone_bytes_digest`, keyset
reference and version, primary load result, secondary transfer result, and
both `check-zone` outputs. The zone is not activated in the database until
primary and secondary serve byte-consistent authenticated data.

Two independent validating views are mandatory:

1. `dns-view-primary-external` queries `94.103.168.161:53` from an execution
   vantage outside both VPS hosts, identified as
   `__UNRESOLVED_PRIMARY_EXTERNAL_DNS_VANTAGE__`.
2. `dns-view-secondary-independent` queries `81.15.150.159:53` from a separately
   identified deployment vantage
   `__UNRESOLVED_SECONDARY_INDEPENDENT_DNS_VANTAGE__`, not the first runner or
   its resolver cache.

Each captures raw DNSKEY, DS, SOA, A, AAAA denial, TLSA, RRSIG, and NSEC
responses and validates the chain from a fresh HSD mainnet anchor. Host-local
queries remain diagnostics only. The TLS acceptance probe computes SHA-256 of
the actually served certificate SPKI and requires byte equality with TLSA.

Handshake UPDATE construction occurs last. Immediately before signing, re-read
the selected owner outpoint, chain height/hash/median-time, mempool conflicts,
renewal/expiry state, and current resource bytes. Freeze these in the accepted
addendum:

```text
owner_input_outpoint = __UNRESOLVED_FRESH_OWNER_OUTPOINT__
resource_preimage = __UNRESOLVED_EXACT_HNS_RESOURCE_PREIMAGE__
unsigned_transaction_hex = __UNRESOLVED_UNSIGNED_TRANSACTION_BYTES__
signed_transaction_hex_sha256 = __UNRESOLVED_SIGNED_TRANSACTION_DIGEST__
fee_rate = __UNRESOLVED_FEE_RATE__
fee = __UNRESOLVED_EXACT_FEE__
expected_txid = __UNRESOLVED_EXPECTED_TXID__
```

Signed transaction bytes are handled as sensitive evidence; the retained
transcript may store their digest and an approved encrypted reference. Any
changed outpoint, fee estimate, chain tip, root state, or resource byte voids
the preimage and requires re-review. Broadcasting requires a separate,
explicit authorization naming the transaction digest and fee.

The delegation gate requires the transaction to be mined, the configured
confirmation threshold `__UNRESOLVED_CONFIRMATION_THRESHOLD__` to be met, and
two fresh HSD observations bracketing propagation with identical resource
bytes. DNSSEC and TLSA acceptance begins only after both independent views
validate. Already-mined NS, glue, and DS changes cannot be rolled back by Git,
Cloudflare rollback, or database revocation. A corrective UPDATE is a new
transaction with new fees and confirmation delay; this limitation must be
acknowledged at signing.

## Gateway build, deployment, and Caddy plan

The repository-only population checkpoint pins the exact api-next source:

```text
api_next_source_commit = 72619e2817cb268f170d9044e5d586643e54957e
```

Immediately before population, fetch without pruning, require clean and equal
local and remote protected-main refs, choose the exact reviewed deployment
commit, and re-audit its diff from the source-closure base. The same commit
must supply the HTTP Worker, migration ledger, gateway package dependencies,
and community bundle. An accepted clean-build ceremony from that commit runs:

```bash
bun run --cwd apps/hns-platform-gateway build:community-vps-bundle
sha256sum apps/hns-platform-gateway/dist/pirate-hns-community-app-gateway.mjs
```

The resulting value is currently:

```text
bundle_sha256 = __UNRESOLVED_COMMUNITY_GATEWAY_BUNDLE_SHA256__
```

The bundle digest is evidence only for the exact source commit that produced
it. Any later source pin, dependency graph, lockfile, Bun version, or build
input change invalidates the digest, manifest, and gateway deployment
reference and requires a new clean build plus plan amendment. The plan must
not reuse the digest from discovery base `4930e8a` or infer equivalence from a
source diff.

Populate `deployment-manifest.template.json` with the exact protected Solid
origin, Solid composition reference, Solid AUD, read-only database endpoint,
registry identity, certificate SPKI, source commit, and bundle digest. Encode
it as compact `JSON.stringify` bytes with no trailing newline. Record:

```text
manifest_sha256 = __UNRESOLVED_DEPLOYMENT_MANIFEST_SHA256__
gateway_deployment_reference = hns-community-app-gateway-sha256:__UNRESOLVED_DEPLOYMENT_MANIFEST_SHA256__
solid_ingress_composition_reference = __UNRESOLVED_SOLID_DEPLOYMENT_VERSION__
api_next_candidate_worker_version = __UNRESOLVED_API_NEXT_DEPLOYMENT_VERSION__
solid_candidate_worker_version = __UNRESOLVED_SOLID_DEPLOYMENT_VERSION__
```

The production and shadow releases live only under
`/srv/pirate-hns-community-app-gateway` and
`/srv/pirate-hns-community-app-gateway-shadow`. They never replace or write
under `/srv/pirate-hns-platform-gateway`. Exact upload, checksum, ownership,
credential-installation, unit-installation, daemon-reload, start, restart, and
rollback commands remain
`__UNRESOLVED_ACCEPTED_VPS_COMMAND_TRANSCRIPT__` until the bundle and release
ids exist. Commands must name absolute files, preserve prior bytes, and verify
every copied digest before service action.

Shadow promotion proves 4169/4171 ownership, `/livez`, `/readyz`, source commit,
profile digest, manifest digest, authority result, Access validation, signing,
limits, aborts, timeouts, and redacted logs without Caddy or public DNS. Only
then may the production unit claim 4069/4071. The rollback release uses the
same production ports and conflicts with the current community unit; rollback
stops only that unit, starts the retained community rollback unit, and never
touches the static platform service.

The Caddy candidate inserts one exact `app.<root>` SNI route ahead of the
existing HTTPS catchall. It deletes all client `X-Pirate-Gateway-*` and
`X-Pirate-Hns-Forwarder-*` fields before adding only trusted external-scheme
and TLS-SNI fields, then proxies to `127.0.0.1:4069`. It retains the exact
`app.pirate` route, DANE selection, WebPKI verifier, DoH route, rate limiting,
HTTP behavior, and `127.0.0.1:4049` upstream.

The candidate and rollback values are:

```text
caddy_candidate_path = __UNRESOLVED_NEW_CADDY_CANDIDATE_PATH__
caddy_candidate_sha256 = __UNRESOLVED_CADDY_CANDIDATE_SHA256__
caddy_active_path = /etc/caddy/caddy.json
caddy_rollback_copy_path = __UNRESOLVED_NEW_CADDY_ROLLBACK_COPY_PATH__
caddy_rollback_sha256 = 4e9f56608383a66771ac27510f1aca25bef8a908784ee8b601840b89fd5b294f
```

Immediately before reload, re-hash the live bytes; a digest other than the
recorded rollback digest stops the operation and requires a new candidate
diff. Copy those exact live bytes to the resolved rollback path without
editing them, verify the copied digest, and validate both candidate and
retained rollback bytes with:

```bash
/usr/local/bin/pirate-caddy validate --config <exact-path>
```

The exact atomic install, reload, health, and rollback commands remain part of
`__UNRESOLVED_ACCEPTED_VPS_COMMAND_TRANSCRIPT__`. They may not edit live JSON
in place. Every shadow, production, Caddy, DNS, and rollback promotion runs
these `app.pirate` preservation probes before and after the step:

```text
GET https://app.pirate/                         expected 200
GET https://pirate/example/path?probe=1         expected 301 preserving path/query
GET 127.0.0.1:4051/livez                        expected 204
GET 127.0.0.1:4051/readyz                       expected 204
static bundle SHA-256                           expected 619c035d...8120
production pirate DNS/DNSSEC/TLSA/SPKI          expected unchanged
```

Any failure rolls back the current reversible layer and suspends the disposable
host. It never changes production `pirate` DNS or certificate material.

## Worker, Privy, and database activation sequence

After all preflight stops are cleared and only under separately accepted
mutation authority, run the sequence below against one accepted environment
tuple. For stage one, every Worker, Access, Privy, database, route, replay, and
evidence reference is the populated staging value. The migration backup and
command cover only the staging database, and the Privy origin is added only to
the staging application. The mainnet root, public gateway, authoritative DNS,
DNSSEC, and DANE portions remain real public-HNS operations.

The production names and discovery values retained below describe only the
optional stage-two population. They are not stage-one defaults and may not be
substituted into a stage-one transcript. Stage two must repeat source closure,
population, backup, migration authorization, deployment, and acceptance as a
new ceremony.

Sequence the selected tuple as follows:

1. Create the two Access applications, their exact-host custom domains and
   policies, then generate the three distinct service tokens into custody.
   Leave all HNS switches false.
2. Install the forwarder registry and Access secret references in the selected
   Solid and api-next environment. Declare every value explicitly; do not rely
   on Wrangler inheritance.
3. Re-run the read-only full-ledger comparison, take and independently verify
   the accepted database backup, then execute the separately authorized
   environment-specific migration command from the exact deployment commit.
   Apply each migration once and in order, stop on the first precondition or
   digest failure, and prove the complete post-state ledger before continuing.
   Stage one must use the populated staging command and must prove that it
   cannot reach production. The dated 0049-through-0055 production gap is not
   a stage-one migration range. A stage-two population must derive the current
   production range and record that production schema/data mutations use
   forward repair rather than Git rollback.
4. Deploy api-next from the accepted commit with switch false. This explicitly
   provisions `HNS_COMMUNITY_APP_API_REPLAY` and applies Durable Object
   migration `v4`. Record the new Worker version and preserve
   `__UNRESOLVED_CURRENT_API_NEXT_ROLLBACK_VERSION__` as rollback. The discovery
   baseline was `1d959450-d0c6-4338-921e-1929069119e3`, but it must be re-read
   at population time.
5. Deploy Solid from the accepted commit with switch false. This explicitly
   provisions `HNS_COMMUNITY_APP_REPLAY` and applies Durable Object migration
   `v1`. Record the new Worker version and preserve
   `__UNRESOLVED_CURRENT_SOLID_ROLLBACK_VERSION__` as rollback. The discovery
   baseline was `d20fa9cc-2e3f-41c1-b76d-f73383e5ad26`, but it must be re-read
   at population time.
6. Add exact Privy allowed origin `https://app.<root>` to the selected stage's
   Privy application and add only the exact OAuth callback required by the
   selected provider flow. The callback is
   `__UNRESOLVED_EXACT_OAUTH_CALLBACK_OR_EXPLICIT_NONE__`. Wildcards are
   prohibited. Passkeys remain unavailable on the HNS origin.
7. Build and deploy the shadow VPS gateway, prove source closure, then deploy
   its production unit without changing Caddy.
8. Complete chain delegation, disposable authoritative zone, DNSSEC, DANE, and
   both independent-view gates.
9. Create the operator-managed route, DNS-zone activation, and app-host
   activation as pending generations using the exact ids in the accepted
   addendum. No strict third-party ownership observer is enabled.
10. Enable and deploy api-next, then Solid, for the selected protected origins.
   Ordinary origins must remain healthy and reject reserved fields.
11. Activate the exact database generations only after both Workers, authority,
    replay stores, gateway, DNSSEC, DANE, and health are current.
12. Install and reload the validated Caddy candidate, then run the complete
    acceptance suite.

Every step records the exact pre-state, command or API request digest,
provider/resource response, post-state, rollback target, and timestamp. A
failed step stops the sequence; there is no repeated deploy, redirect follow,
or retry-until-green policy.

The three HNS ownership flags in HTTP Worker and the three in jobs Worker stay
false during the operator-managed community-route phases. That route does not
require the third-party ownership observer, but it also cannot establish the
verified namespace authority required by a handle sale activation. Before the
handle phase, the populated addendum must name the exact source-defined owner
verifier and observer composition for the selected environment, its bindings,
and the separately authorized enablement sequence. If current verified
namespace authority cannot be proved without weakening that contract, the
handle phase stops. Direct operator-route authority must never be substituted
for sale-namespace authority.

## Acceptance transcript

The accepted transcript must prove all of the following without storing raw
test credentials:

- Stage one proves the populated staging community route and
  `https://app.<root>` before, during, and after every promotion, suspension,
  recovery, revocation, and rollback. It does not claim evidence for
  `https://pirate.sc/c/<root>`. Stage two, if separately authorized, must prove
  that canonical route with the same lifecycle coverage.
- Direct DNSKEY, DS, RRSIG, NSEC, A, explicit AAAA absence, and TLSA validation
  succeeds from both independent views. The served certificate SPKI SHA-256
  equals the TLSA 3 1 1 value exactly.
- `GET` and `HEAD /` map only to `/c/<root>`. Other valid reads preserve exact
  path and query. POST and PATCH forward only `/api` and `/api/*` within body,
  header, cookie, response, and deadline bounds.
- Unsafe requests require the exact HNS Origin and CSRF value. Authorization,
  caller Access fields, forwarded fields, and reserved gateway/forwarder fields
  cannot become authority.
- Gateway, Solid, and api-next validate the exact 622-byte profile, current
  deployment reference, current host authority, forwarder-v3 HMAC, time window,
  body digest, method, path, key id, and nonce. Solid and api-next consume the
  nonce once in their distinct scopes.
- Access validation proves exact issuer, exact generated AUD, signature,
  `kid`, `iat`, `exp`, optional `nbf`, clock skew, cache ceiling, one unknown-
  kid refetch, two-second deadline, manual redirects, and zero retries.
- Ordinary ICANN, preview, and `workers.dev` traffic rejects valid-looking
  `cf-access-*`, `x-pirate-gateway-*`, and
  `x-pirate-hns-forwarder-*` fields while serving ordinary traffic when HNS
  assembly is deliberately misconfigured.
- The same Privy subject resolves to the same Pirate account, memberships,
  personas, and existing wallet assignments on the selected stage's canonical
  application origin and `app.<root>`. Session and CSRF cookies remain
  origin-local. Stage one uses only the staging Privy application; any
  `pirate.sc` comparison belongs to stage two.
- Merely visiting or joining creates no persona or wallet. The HNS origin
  begins with no inherited acting persona or wallet from another origin.
  Selection is explicit and the server rechecks active account ownership,
  community presentation authority, and exact wallet assignment.
- Sibling-persona and sibling-wallet substitution fail. A persona does not
  appear or act on another community origin unless explicitly selected and
  eligible there.
- The gateway follows no upstream redirect, makes no hidden exchange, performs
  no replay, and retries zero times. Timeout, abort, oversized, malformed,
  unavailable, stale, mismatched, revoked, or unknown-authority cases fail
  closed with redacted evidence.
- A forced health or authority failure suspends only the disposable app host.
  Recovery requires a new activation generation and fresh current-authority
  proof. Revocation prevents all old generations and replayed envelopes.
- `app.pirate`, its static bundle, Caddy route, production DNS, DNSSEC, TLSA,
  certificate, HSD, PowerDNS data, backups, and rollback release remain byte-
  and behavior-consistent throughout.

The transcript retention target is
`__UNRESOLVED_REDACTED_TRANSCRIPT_REFERENCE__`, with retention period
`__UNRESOLVED_TRANSCRIPT_RETENTION_PERIOD__`. It includes hashes and provider
references, not service-token secrets, database passwords, wallet credentials,
private keys, raw authentication credentials, or unrestricted signed
transactions.

## Suspension, recovery, revocation, and rollback

Health, DNS authority, current database authority, registry, Access, or gateway
failure immediately suspends the app-host activation while preserving the
canonical community route. Recovery never edits an old active generation; it
creates the exact new generation named in the accepted lifecycle addendum and
repeats current authority, DNSSEC, DANE, Access, replay, and health gates.

Revocation disables the app-host generation and both protected Worker paths
before Caddy, zone, Access, secret, unit, certificate, or chain cleanup. Worker
versions roll back to the recorded baselines only if their Durable Object
bindings and retained evidence remain compatible; rollback does not pretend a
provisioned namespace never existed.

Provider resources, database rows, VPS files, and services have target-specific
reversal steps. DNSSEC and certificate key destruction is separately approved
and occurs after evidence retention. An already-mined Handshake UPDATE is not
reversible; restoration requires another accepted, signed, fee-bearing UPDATE
and confirmation period.

## Required owner ceremonies and separate authorization

For stage one, the workspace owner must supply or approve, in order:

1. read-only wallet/account proof and one unused root nomination;
2. a migration-reader ceremony proving the complete staging ledger expected
   by the exact deployment commit, followed by separate authorization for
   every missing staging migration before api-next deployment, with proof that
   production Postgres is unreachable;
3. resolution or explicit acceptance of the VPS verifier and backup
   `NOTCONFIGURED` conditions, plus separately authorized repair of the stale
   gateway installed-file manifest after confirming the active Caddy bytes;
4. the Cloudflare Access team domain and authority to enable Access;
5. one-time Access service-token and forwarder-key custody ceremonies;
6. staging Privy administration for the exact HNS origin and callback;
7. disposable DNSSEC, AXFR, and DANE key/certificate custody and backup;
8. independently identified DNS validation vantages;
9. exact activation ids, generations, zone bytes, manifest bytes, Caddy bytes,
   bundle digest, transaction preimage, signed-transaction digest, fees,
   confirmations, commands, retention target, and rollback transcript;
10. a final accepted addendum resolving every placeholder; and
11. a new authorization naming each external mutation to execute.

The requested stage-one mutation authorization must name Access organization,
applications, policies, service tokens, Worker custom domains, secrets,
bindings, Durable Object migrations and deployments; Privy origin/callback;
staging PostgreSQL migrations, database role and activation rows; VPS
credentials, verifier-baseline repair, releases, units and Caddy bytes;
PowerDNS zone, transfer and DNSSEC state; DANE certificate; backups; and the
exact Handshake transaction digest and fee. Acceptance of this draft alone
authorizes none of them.

If stage two is elected after stage-one acceptance, it requires a new version
of every applicable ceremony above naming the production tuple. That separate
authorization must explicitly accept production PostgreSQL migrations,
production Privy administration, irreversible production pilot-data writes,
and forward-repair cleanup. No stage-one approval carries forward.

Stop here. Do not execute this plan in the authorization step that accepts or
amends it.

## Execution checkpoint — 2026-08-28

The workspace owner accepted the production migration result through
`0068_general_audience_song_covers.sql` and authorized the bounded private
enablement checkpoint. Rotation of the exposed
`hns-community-gateway-authority-v1` password is deferred as dated technical
debt by explicit owner decision. The installed credential remains restricted
to the thirteen resolver grants, is delivered through systemd
`LoadCredential=`, and must be rotated before this rehearsal is converted into
a retained production service.

The active shadow manifest digest is
`f795fef30b7b24c9eb6081ded4d180f3f385d6d398b6e855c306a3a0831df1e5`.
Its embedded gateway certificate SPKI SHA-256 and the independently derived
SPKI of the installed certificate are both
`e5dd96b162d67af3016c1db8c19108dd93b5419c7c8eecc7e36c55f98f2d3f08`.
The disposable certificate expires on 2026-09-27. Continuing the host beyond
that date requires a separately reviewed certificate and TLSA rotation before
expiry; the rehearsal certificate is not a durable production certificate.

The protected enablement dispatches are pinned to api-next commit
`89dfb7b2034898fea0673493d3a4c71ec4b1787e` and Solid commit
`56771ed5b9bf6379ed67ab221ac59dd9ec7c3d4d`. Both remote `main` refs were
verified at those exact commits immediately before this checkpoint. The
api-next workflow requires the production ledger tip to remain exactly 0068.
Both workflows must therefore be dispatched in the same execution session;
any intervening api-next migration or movement of either remote `main`
invalidates the checkpoint and stops execution.

This checkpoint authorizes only a short-lived fixture refresh, both protected
Worker dispatches, recording the resulting Worker versions, and the private
positive-path probe through loopback listeners 4169/4171. It does not authorize
Privy, Caddy, PowerDNS, Handshake, or public-exposure changes.

### Execution result — 2026-08-28T06:22Z

Health generation 3 was recorded for activation generation 1 with the exact
manifest reference and certificate SPKI above. Its fixture lifetime ends at
2026-08-28T07:21:23Z and it must not be treated as a public DNS observation.

The protected api-next workflow run `33147666246` succeeded at the pinned
commit and deployed enabled Worker version
`e16794e6-7dd1-446d-8677-1ac8bc74a8f7`. The canonical API health probe
returned 200 afterward.

The protected Solid workflow run `33147666275` failed in its build-and-deploy
step. The build completed and uploaded 87 static assets, but no new Solid
Worker version was created. The generated `dist/ssr/wrangler.json` already
named `pirate-web-solid-production` and contained the enabled production
variables. The workflow nevertheless retained `CLOUDFLARE_ENV=production`
while invoking Wrangler against that flattened generated configuration.
Wrangler attempted to select a second, absent production environment and
reported that the target Worker did not exist and its five required secrets
were unset. The canonical Solid origin remained healthy with HTTP 200; both
Access-protected boundaries continued to return 401 without credentials.

Execution stopped on that first failure. No retry or private positive-path
probe was performed. A reviewed workflow correction must prevent Wrangler from
reapplying an environment to the flattened generated configuration, prove the
resulting target name before mutation, and receive a new authorization for one
corrected Solid deployment attempt. The health fixture must be refreshed again
if it expires before that attempt.

### Corrected Solid attempt and private-probe stop — 2026-08-28T06:35Z

The reviewed workflow correction was published Radicle-first and mirrored to
GitHub at `57b0a0487199abb5a6abb2e21b896184a41f0e9c`. Corrected protected run
`33148349973` succeeded and deployed Solid Worker version
`c33bca27-6909-4e7a-9e87-23c01e16cdc6`. The canonical Solid and api-next
origins both remained healthy.

The authorized private positive probes for `/` and `/api/health` both failed
closed with 421 before reaching an upstream. The current resolver row showed
active app-host and DNS generations, current operator-managed route authority,
matching DS, retained-zone digest, gateway reference, certificate SPKI, and
healthy gateway state. Its sole false gate was
`stable_chain_delegation_matches` because the activation-bound authority
inventory `2026-08-28.v1` expired at 2026-08-28T05:44:56Z. Health generation 3
could not revive an expired inventory.

Execution stopped without retry. Recovery requires an append-only successor
authority inventory, DNS-zone activation generation, app-host activation
generation, and health observation, all internally bound to one another. That
generation transition requires separate authorization. Privy, Caddy,
PowerDNS, Handshake, and public exposure remain unchanged.

### Successor authority and Solid assembly stop — 2026-08-28T10:11Z

The authorized successor transition committed atomically. Authority inventory
`2026-08-28.v2` expires at 2026-08-28T12:11:28Z. DNS-zone activation generation
2 and its health generation 1 are current. The app host moved through suspended
generation 2 to restored active generation 3 bound to DNS generation 2. A
post-transaction resolver read proved every route, delegation, DS, retained
zone, gateway-reference, SPKI, and health gate true.

The repeated private `/` and `/api/health` probes then reached the upstream
boundary but failed closed with 502. A credentialed direct request from the VPS
passed Cloudflare Access and received the Solid Worker's redacted 503 assembly
failure. The VPS Access client id and secret have value-only shapes with no
header prefix or colon. The remaining failure surface is therefore the enabled
Solid composition's five runtime secrets or their cross-secret consistency:
the shared forwarder registry and the distinct API and authority Access token
pairs. Execution stopped without reinstalling secrets or attempting another
deployment. Privy, Caddy, PowerDNS, Handshake, certificates, and public DNS
remain unchanged.

### Solid secret recovery and private-probe freshness stop — 2026-08-28T11:12Z

The reviewed Solid recovery workflow at exact main commit
`747d3136a80fb59fbaed9e2b5bde6b0affa550a6` completed successfully in run
`33163749516`. It validated the five production community secret names,
registry digest and shape, bare Access credential shapes, and distinct API and
authority credentials before reinstalling them. It retained Worker version
`642b5013-0492-47d1-83c9-95cc7b01dc2c` as rollback, deployed enabled Worker
version `53dade5b-5705-42b4-96b8-bec47de9a243`, and proved the canonical Solid
origin healthy afterward. No secret value entered the transcript.

A later operator session did not initially observe that completed run and
queued run `33164552259` at the same exact commit. Discovery found the earlier
success before the queued job executed. The redundant run was canceled; its
job completed as canceled with zero steps, so it performed no second secret
installation or deployment.

The required private positive-path probe was not accepted. An initial
batch-mode connection used the workstation's default account and was rejected
before executing a remote command. Read-only local evidence recovered the
established retained-host role account; the same agent identity then
authenticated successfully without weakening authentication or requesting a
password. The shadow unit was active, listeners `127.0.0.1:4169` and
`127.0.0.1:4171` were owned, and `/livez` and `/readyz` both returned 204. The
installed manifest retained the accepted profile digest, protected origins,
registry identity, certificate SPKI, and shadow listener pair.

The exact activation-bound fixture hostname was not available in the accepted
public transcript. A historical candidate inferred from unrelated local
evidence was mistakenly used for one status-only loopback attempt without the
required external-scheme and TLS-SNI framing headers; `/` and `/api/health`
both returned 400. That malformed attempt is not acceptance evidence.

A subsequent read-only query through the shadow gateway's restricted database
role and schema-qualified authority relations proved that the current fixture
host is `app.jazleeuw`. The current app-host generation 3, DNS-zone generation
2, and operator-managed route generation 1 remained active and mutually
current. At 2026-08-28T11:11:36Z, however, the accepted resolver returned
delegation, DS, retained-zone, and gateway-health gates false. A bounded
read-only freshness check then proved that health generation 1 expired at
2026-08-28T11:11:29Z, seven seconds before the resolver read. Authority
inventory `2026-08-28.v2` remained valid until 2026-08-28T12:11:28Z. The
process-level `/livez` and `/readyz` checks still returned 204.

No new application probe was sent after the failed freshness gate. Recovery
requires one accepted health-fixture refresh followed by a fresh resolver and
health check before the two correctly framed loopback probes run exactly once.
Until that succeeds, production secret assembly, canonical health, gateway
process health, and the current fixture identity are proven, but
gateway-to-Solid-to-api-next acceptance is not.

The wallet application, `11qx`, Privy, Caddy, PowerDNS, Handshake, certificates, public
DNS, production migrations, and application database state were not touched
by this recovery checkpoint.

### Gateway Access-cookie correction and promotion stop — 2026-08-28T11:13Z

The Solid production-secret recovery proved that Access and the enabled Solid
composition assembled. A credentialed request returned an Access
`CF_Authorization` infrastructure cookie. The gateway treated that cookie as
an unknown application response cookie and failed closed with 502. api-next PR
112 corrected the response boundary: merge commit
`838121e8e61ac6c2a81b88fc1b22f9194d64f531` strips exactly
`CF_Authorization` before validating and forwarding application `Set-Cookie`
fields. All 47 gateway tests and all required pull-request checks passed. The
request boundary still forwards a client `Cookie` field unchanged; a separate
reviewed correction must remove an exact `CF_Authorization` member there
before public exposure. This does not block the private service-token probe.

The authorized gateway bundle built from that merge commit has SHA-256
`4678c478dd98b9e99fd3545ad002e909166291129806ac0b90d258c015c6733c`.
The first candidate manifest retained the accepted SPKI and all other current
manifest members, but its generated file included one trailing newline. Its
2,016 bytes therefore violated the runtime's exact canonical-JSON comparison;
the prior accepted manifest is 2,015 bytes. The new unit entered its configured
restart loop and never opened 4169/4171. Execution stopped on that first
failure. The `current` symlink was atomically restored to retained release
`475f5bf-4215b3cc-spki-e5dd96b1`; the unit is active and both `/livez` and
`/readyz` returned 204 afterward.

No Solid variable, Worker version, authority row, health fixture, Privy
origin, Caddy configuration, PowerDNS state, Handshake state, certificate, or
public DNS changed. One corrected attempt requires a byte-canonical manifest
with no trailing newline, a newly recorded manifest digest and deployment
reference, and a new authorization. The failed candidate release remains
alongside the rollback release and is not selected by `current`.

### Corrected gateway promotion and Solid private-hop stop — 2026-08-28T12:30Z

The corrected 2,015-byte manifest has SHA-256
`7141e351d4da5993a9fd42cf03e517200140679b2ad871b333108f0e8399c67c`.
Release `838121e-4678c478-manifest-7141e351` is selected by `current`; the
shadow unit is active and both health endpoints returned 204. The prior
release remains intact as rollback.

Solid commit `e2564b87e0e9258ec62365d33ffca9181d4bb6c5` advanced the exact gateway
reference in production configuration and its source-closed assertion. It was
published Radicle-first and mirrored to GitHub. Protected workflow run
`33170718705` passed at that exact commit and deployed Worker version
`62596127-b425-408b-89cb-b09add01bb2c`.

The append-only authority transaction recorded fixture inventory
`2026-08-28.v3`, DNS-zone activation generation 3, health generation 1, and an
app-host suspend/restore transition through generations 4 and 5. The
post-transaction resolver returned one active row with the new deployment
reference and every route, delegation, DS, retained-zone, SPKI, and health
gate true.

The first private root request reached the shadow gateway but returned Solid's
35-byte redacted 503 response. A direct credentialed request to the protected
Solid origin returned its expected 400 admission response with the same
redacted body digest, proving Access admission and production composition
assembly. The valid forwarded envelope alone enters the failing path. Gateway
signing, database authority, upstream transport, and response-cookie
sanitization therefore completed; the remaining failure is inside Solid's
private authority or API hop. Execution stopped before the `/api/health`
probe and before Privy, Caddy, PowerDNS, Handshake, certificate, or public-DNS
changes.

A metadata-only registry diagnostic accidentally rendered the active key
material into the operator transcript. No repository or plan contains those
bytes, but the registry must be rotated across all three consumers before any
public exposure. The next diagnostic must validate the two Solid service-token
admissions without rendering values, then stop or repair the exact failing
boundary under a new authorization.

### Protected Access diagnostic — 2026-08-28T12:42Z

Solid commits `1b61c999a95b0f76e4f5f91b669e72d95cec86bd` and
`07222b64f9719ba7fe73937526b4b00c1f3f5d50` added and corrected a manual,
production-environment diagnostic that prints only status, boundary class,
elapsed time, body size and digest, and mitigation presence. Both commits were
published Radicle-first and mirrored to GitHub. Initial run `33172022087`
failed before either request because the runner's curl did not support an
unnecessary option. Corrected run `33172124534` passed without rendering any
credential.

The API service token reached the api-next Worker in 0.769250 seconds. The
Worker returned the expected 400 rejection for an unsigned `/api/health`
request, with 134 response bytes and body SHA-256
`7694d5f53bad9045e9394bed75988fd673af46db0338132e917f2fef2780f9bc`.
The authority service token did not reach the Worker: Cloudflare Access
returned an edge-classified 401 in 0.212776 seconds, with 308 response bytes
and body SHA-256
`044e5064321e1ae42150304be78e2192d362ac7b8f1d2f8bafae941eee8f5fa4`.

This excludes the private-authority deadline, response parser, current-row
equality, and deployment-reference equality as the first failure. The exact
fault is authority-token admission: the token is absent from the authority
application policy, disabled or revoked, or its installed GitHub pair does not
match the admitted token. Execution stopped without policy, token, secret,
Worker, registry, gateway, authority-generation, Privy, Caddy, PowerDNS,
Handshake, certificate, or public-DNS mutation.

### Protected Access policy repair — 2026-08-28T12:50Z

The workspace owner inspected the service-auth policy attached to the
protected api-next application. Its include set contained only one service
token. The owner added the existing
`hns-community-solid-authority-production` service token to that same policy;
no token was created, regenerated, disabled, or deleted, and no GitHub or
Worker secret changed.

Diagnostic run `33172619431` was cancelled before execution because the local
`origin/main` ref was stale and did not match GitHub's authoritative `main`.
The corrected exact-source run `33172639512` used Solid commit
`07222b64f9719ba7fe73937526b4b00c1f3f5d50` and completed successfully after
the production-environment review gate.

The API service token reached the api-next Worker in 1.139773 seconds. The
Worker returned the expected 400 rejection for an unsigned `/api/health`
request, with 134 response bytes and body SHA-256
`8c8382e0c6835b3905c37a63d93744b575a295b20c12c6cad2f455fb3ecbad3b`.
The authority service token also reached the Worker, in 0.787047 seconds. The
deliberately nonexistent authority request returned a Worker-classified 404,
with 143 response bytes and body SHA-256
`e2e0e081ba8ff8317b6ed014ae2736e6375b26e3e92bcb0c1b174ed2d5772a45`.
Neither response was Cloudflare-mitigated.

Both Solid service-token admissions are therefore proven. The prior 401 was
caused by the authority token being absent from the service-auth policy, not
by malformed GitHub credentials or a revoked token. Registry rotation remains
mandatory before public exposure because the active key material was rendered
in an earlier operator transcript.
