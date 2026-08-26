# Disposable-root interactive community rehearsal plan

Status: draft, non-executable

Plan date: 2026-08-26

Evidence cutoff: 2026-08-26T17:45:37+04:00

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

The production `pirate` root, `app.pirate`, its certificate, its DNSSEC keys,
and its gateway release are preservation targets, not rehearsal inputs.

## Decision summary and stop conditions

The three activation-wiring blockers are complete in source. No fourth
activation-code task is presently required. api-next production assembly,
Solid production ingress assembly, and the separate VPS community executable
all exist at the accepted repository heads described below. Every declared
HNS enable switch remains `"false"`, so nothing is live.

This plan proposes the production Pirate environment tuple because only that
tuple can satisfy the required canonical route at `pirate.sc`. A staging
preflight may be planned separately, but successful staging evidence cannot
be substituted for this rehearsal's production-tuple acceptance.

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
2. Live application of PostgreSQL migrations 0047, 0048, and 0049 has not
   been proved with a migration-reader credential.
3. Cloudflare Access is not enabled for the account, so there is no team
   domain, application, AUD tag, or service token to bind.
4. The primary gateway verifier reports a host-file checksum mismatch. The
   primary and secondary DNS verifiers exit `NOTCONFIGURED`. The encrypted
   backup job uploads and verifies retention, then exits `NOTCONFIGURED`.
   These pre-existing conditions require a separately reviewed resolution or
   explicit risk disposition before mutation.
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

The accepted api-next source commit is
`4930e8aaf75c9a19cd90fe67f9c6586602c32ccb`. It contains the merged HTTP Worker
production composition and the separately named community VPS bundle. The
accepted Solid source commit is
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
control-plane database. Both branches share the one exact protected api-next
origin, Access validator, and pinned api-next audience; their downstream wire
validation is different. The Durable Object migration tag is `v4`, the class
is `HnsForwarderReplayStoreDO`, and the consumer scope is
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

The two Solid service-token pairs must be different. The Solid replay Durable
Object migration tag is `v1`, its class is
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
| `/etc/caddy/caddy.json.pre-target-static-gateway-20260825` | `2e450f1ebee39a0f33bf2a0fcf17de093088c47fdd6b1bc9fe5df7177608c8dbd9b` | valid with `/usr/local/bin/pirate-caddy` |

The stock `caddy validate` rejects the installed custom `rate_limit` handler;
that is a binary mismatch, not evidence of invalid active bytes. Every planned
validation command must use `/usr/local/bin/pirate-caddy`.

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

PowerDNS runs in `pirate-hns-authdns`. Its zone inventory is `tame_impala`,
`ellaalexandra`, `xn--pokmon-dva`, `baddie`, `dankmeme`, `pirate`, `king`,
`king.bitcoin`, `scarlett`, and `jazleeuw`. The production `pirate` zone is
master, serial `2026072002`, and allows AXFR through logical TSIG reference
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
proof that an available wallet account controls them.

```text
tame_impala
  owner 1a96226223c2b653147996f84ac23a2bdd0963b50c72e39c66f8745c0ae54ea6:0
  renewal 327265; expiry 432385; remaining 88057 blocks
  NS ns1.pirate.
  TXT pirate-verification=nvs_066a3309c6604cc4bcce06a2cc531275

ellaalexandra
  owner ce240df33c375ab6994e75d402501f43aa4bc8fc5eb53d239318152e98c77e9d:0
  renewal 340917; expiry 446037; remaining 101709 blocks
  NS ns1.pirate.; NS ns2.pirate.
  TXT pirate-verification=nvs_77cce470d4c44448b07cc10324778e17
  DS 56075 13 2 0ab3ce5c1e2964f49c879e1608cf609686eaf21e5f998dfe26a2ca9ecd15ed2e
  DS 56075 13 4 32aa9524ab977fca45947dd81504acd177498cc6bd9ea580483ba0cdbee7d3a5d614a204465fdc821b914f3d0d35a446

xn--pokmon-dva
  owner 8ae8663fefc0cff064901e5e142e11e91110931507e07cecaa4ecbccc505b497:0
  renewal 326567; expiry 431687; remaining 87359 blocks
  NS ns1.pirate.; NS ns2.pirate.
  TXT pirate-verification=nvs_c041dd8faeb44572a2cfd55a185cb18d
  DS 49194 13 2 053c8350a8e967bc4c3a9e4705e8a133f136fc9ba1f7cd0ae1e33d97609531f1
  DS 49194 13 4 1559ca37322d04104d50d4ed8aa4eede8c2cc3252efbfd6d363b398b936793f00df0b5bc9cce08ba8366053d19b30190

baddie
  owner 385bc9bd22ceb39cd7d010b1e4e052a0ea6405e7eb3baa35e65b5a22687de898:0
  renewal 327935; expiry 433055; remaining 88727 blocks
  GLUE4 ns.baddie. 45.79.214.114
  NS ns1.pirate.; NS ns2.pirate.
  TXT pirate-verification=nvs_cb84a8d43d594c02a208a68d1f2c30fd
  DS 48854 13 2 53524406e5eb3509a67e897d1301109148739d04b9e41f123e6f9261805aea46
  DS 48854 13 4 6bc07f5ae04b5c4f27f15440b10e1400fe6da8ea8ea97e70c23357b4554319ba2346976f6630851bd9f5cf0ec0bfd039

dankmeme
  owner 2fc060eeb66f0d99f5daa5cdecc66ba924da2c56325ba2446eef72fa314e8026:0
  renewal 326576; expiry 431696; remaining 87368 blocks
  NS ns1.pirate.; NS ns2.pirate.
  TXT pirate-verification=nvs_95f773c476c84acb8a237af7ea64b96e
  DS 39280 13 2 7763394f08c984b2fb71c10a8284bb7d5204a76c3a90867be3768417e27ac8e6
  DS 39280 13 4 cfc21a4cfab1a96646b472e3769aea41b28c7c4956b6f17741eb5b82b478c3781e8465a9f3c7ffebdd10443b67df46b8

king
  owner 219a573488da79ac6325b94c240e2992469a037d0795a829c4762a67edf2ae64:0
  renewal 313242; expiry 418362; remaining 74034 blocks
  GLUE4 ns1.king. 44.231.6.183; NS ns1.king.
  GLUE4 ns2.king. 54.214.136.246; NS ns2.king.

scarlett
  owner 1d0e6b54354562d4fa2cb901cf7bdcd22bc6b1718b91a3e902bbc4e832277707:0
  renewal 326567; expiry 431687; remaining 87359 blocks
  GLUE4 ns1.scarlett. 44.231.6.183
  NS ns1.pirate.
  TXT pirate-verification=nvs_b90d88b73b63409eaf445969d39176e6

jazleeuw
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

Repository migrations 0047, 0048, and 0049 exist. The secrets contract records
production migration application only through 0048. No authorized
migration-reader credential was available, so live application of 0049 and
the exact live ledger were not established. No connection was made and no
route, DNS-zone, or app-host row was created.

## Frozen environment tuple proposal

Subject to separate acceptance, the proposed tuple is:

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
| canonical route | `https://pirate.sc/c/__UNRESOLVED_OWNER_VERIFIED_DISPOSABLE_ROOT__` |
| HNS origin | `https://app.__UNRESOLVED_OWNER_VERIFIED_DISPOSABLE_ROOT__` |
| Solid protected origin candidate | `https://hns-community-ingress.pirate.sc` |
| api-next protected origin candidate | `https://hns-community-api.pirate.sc` |
| private authority origin candidate | `https://hns-community-api.pirate.sc` (same protected api-next origin) |

The alternative staging tuple is
`https://web-next-staging.pirate.sc`,
`https://api-next-staging.pirate.sc`, and Privy application
`cmsw5pis300b80cladbxx7bsr`. It is internally coherent for an engineering
preflight, but it cannot produce the required canonical
`https://pirate.sc/c/<root>` result and is not selected here.

The two candidate protected hosts returned NXDOMAIN and were not present in
the Worker custom-domain inventory at discovery. They are reservations in
this draft only. Creating DNS, Worker domains, Access resources, or secrets
for them is prohibited until the populated plan is accepted.

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
observation window. If no inventoried name passes, the operation stops; it
does not weaken the criteria.

A separately supplied read-only migration credential must then query the
selected production database's authoritative migration ledger and prove that
0047, 0048, and 0049 are applied once, in order, with the repository-expected
digests. The transcript also verifies that the target community and all three
proposed activation ids are absent before creation. The migration-reader
credential is not reused by the gateway and cannot mutate schema or data.

## Cloudflare Access and secret plan

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

The candidate source commit is fixed at
`4930e8aaf75c9a19cd90fe67f9c6586602c32ccb`. Any source change requires a plan
amendment. An accepted clean-build ceremony runs:

```bash
bun run --cwd apps/hns-platform-gateway build:community-vps-bundle
sha256sum apps/hns-platform-gateway/dist/pirate-hns-community-app-gateway.mjs
```

The resulting value is currently:

```text
bundle_sha256 = __UNRESOLVED_COMMUNITY_GATEWAY_BUNDLE_SHA256__
```

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
mutation authority, sequence reversible layers as follows:

1. Create the two Access applications, their exact-host custom domains and
   policies, then generate the three distinct service tokens into custody.
   Leave all HNS switches false.
2. Install the forwarder registry and Access secret references in the selected
   Solid and api-next production environments. Declare every value explicitly;
   do not rely on Wrangler inheritance.
3. Deploy api-next from the accepted commit with switch false. This explicitly
   provisions `HNS_COMMUNITY_APP_API_REPLAY` and applies Durable Object
   migration `v4`. Record the new Worker version and preserve
   `1d959450-d0c6-4338-921e-1929069119e3` as rollback.
4. Deploy Solid from the accepted commit with switch false. This explicitly
   provisions `HNS_COMMUNITY_APP_REPLAY` and applies Durable Object migration
   `v1`. Record the new Worker version and preserve
   `d20fa9cc-2e3f-41c1-b76d-f73383e5ad26` as rollback.
5. Add exact Privy allowed origin `https://app.<root>` to production app
   `cmnbdx9xk00ty0clapn2q8pdj` and add only the exact OAuth callback required
   by the selected provider flow. The callback is
   `__UNRESOLVED_EXACT_OAUTH_CALLBACK_OR_EXPLICIT_NONE__`. Wildcards are
   prohibited. Passkeys remain unavailable on the HNS origin.
6. Build and deploy the shadow VPS gateway, prove source closure, then deploy
   its production unit without changing Caddy.
7. Complete chain delegation, disposable authoritative zone, DNSSEC, DANE, and
   both independent-view gates.
8. Create the operator-managed route, DNS-zone activation, and app-host
   activation as pending generations using the exact ids in the accepted
   addendum. No strict third-party ownership observer is enabled.
9. Enable and deploy api-next, then Solid, for the selected protected origins.
   Ordinary origins must remain healthy and reject reserved fields.
10. Activate the exact database generations only after both Workers, authority,
    replay stores, gateway, DNSSEC, DANE, and health are current.
11. Install and reload the validated Caddy candidate, then run the complete
    acceptance suite.

Every step records the exact pre-state, command or API request digest,
provider/resource response, post-state, rollback target, and timestamp. A
failed step stops the sequence; there is no repeated deploy, redirect follow,
or retry-until-green policy.

The three HNS ownership flags in HTTP Worker and the three in jobs Worker stay
false. No `HNS_OWNER_VERIFIER` or `HNS_OBSERVER_DRIVER` binding is added. The
operator-managed disposable route does not require the third-party ownership
observer.

## Acceptance transcript

The accepted transcript must prove all of the following without storing raw
test credentials:

- `https://pirate.sc/c/<root>` remains available before, during, and after
  every promotion, suspension, recovery, revocation, and rollback.
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
  personas, and existing wallet assignments on `pirate.sc` and `app.<root>`.
  Session and CSRF cookies remain origin-local.
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

The workspace owner must supply or approve, in order:

1. read-only wallet/account proof and one unused root nomination;
2. a migration-reader ceremony proving 0047, 0048, and 0049;
3. resolution or explicit acceptance of the VPS verifier and backup
   `NOTCONFIGURED` conditions and the gateway checksum mismatch;
4. the Cloudflare Access team domain and authority to enable Access;
5. one-time Access service-token and forwarder-key custody ceremonies;
6. production Privy administration for the exact HNS origin and callback;
7. disposable DNSSEC, AXFR, and DANE key/certificate custody and backup;
8. independently identified DNS validation vantages;
9. exact activation ids, generations, zone bytes, manifest bytes, Caddy bytes,
   bundle digest, transaction preimage, signed-transaction digest, fees,
   confirmations, commands, retention target, and rollback transcript;
10. a final accepted addendum resolving every placeholder; and
11. a new authorization naming each external mutation to execute.

The requested mutation authorization must name Access organization,
applications, policies, service tokens, Worker custom domains, secrets,
bindings, Durable Object migrations and deployments; Privy origin/callback;
database role and activation rows; VPS credentials, releases, units and Caddy
bytes; PowerDNS zone, transfer and DNSSEC state; DANE certificate; backups;
and the exact Handshake transaction digest and fee. Acceptance of this draft
alone authorizes none of them.

Stop here. Do not execute this plan in the authorization step that accepts or
amends it.
