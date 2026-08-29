# Disposable root `11qx` read-only population addendum

Status: owner-nominated, publicly observed, non-executable, 2026-08-28.

This addendum records the first read-only population of the combined community
and `hosted_persona_v1` handle rehearsal plan. It authorizes no wallet access,
credential access, signing prompt, Handshake transaction, DNS or HNS update,
provider operation, deployment, migration, database write, key or certificate
operation, or other live-state mutation. Every mutation gate and unresolved
identifier in `disposable-root-rehearsal-plan-2026-08-26.md` remains in force.

## Owner nomination

The workspace owner nominates exact root `11qx` on Handshake mainnet and states
that it is held in the owner's Bob Wallet, has never been intentionally used,
and has no production or third-party dependency. The owner did not author the
current NS or glue values and understands them as registration-default parking
records that may be replaced only in a later separately authorized ceremony.

This statement is not retained wallet custody proof. Before any mutation, a
read-only Bob Wallet view must prove that the wallet currently presents
`11qx` as owned, and an independent current mainnet observation must bind the
same name to its exact owner outpoint. No seed, private key, wallet password,
raw wallet credential, or signing interaction enters the evidence.

## Public observation

The workspace owner authorized read-only inspection of
`https://shakeshift.com/name/11qx`. At the page's 2026-08-28 10:19:47 UTC+4
snapshot, Shakeshift reported mainnet block 344,558 and the following public
state:

```text
name = 11qx
name_hash = 6705b8d6ad245d1ba6f77154483f8c0b3da21d1de4274571d4d96c6ddd7bb82a
state = REGISTERED
owner_address = hs1q8ewlwa07hlfkjgvrpzjlsve8vend5fnh8g66rv
registration_block = 104562
renewal_window_end = 443415
expiration_block = 443416
displayed_expiration = approximately 2028-07-14 22:39
latest_finalize_block = 338296
latest_finalize_txid = 2eb4bc188915f3945b5b387f5d8c39dd5a44d85930d030249c16d5ff3ea4adc6
```

The page showed one resource document, created at registration and effective
from block 104,580 through the observation:

```text
GLUE4 ns1.11qx. 44.231.6.183
NS    ns1.11qx.
GLUE4 ns2.11qx. 54.214.136.246
NS    ns2.11qx.
```

The public history includes transfers, finalizations, and one renewal. The
page showed no later resource UPDATE. That supports the owner's description of
the resource set as registration-default parking, but it does not prove that
the listed hosts or addresses have no current dependent traffic. The accepted
population transcript must re-read exact resource bytes through an independent
fully validating mainnet HSD observer and prove the no-dependency assertion
before proposing replacement.

Shakeshift is discovery evidence, not custody or activation authority. All
heights, hashes, outpoints, resource bytes, renewal horizon, and tip identity
must be refreshed immediately before any accepted mutation.

## Browser-host criterion

The root contains ASCII letters and therefore avoids the all-numeric final-label
failure. A Chromium WHATWG URL parser returned the canonical value
`https://longname.11qx/` for that exact input. The populated rehearsal must
repeat the parser check for its selected 8–15-character handle label and then
prove real browser HTTPS behavior after the separately authorized public DNS
and gateway ceremony.

## Gateway host provenance

No gateway host has been selected or provisioned for the `11qx` pilot. Host
addresses and retained-host observations in the base rehearsal plan are
read-only discovery evidence from earlier infrastructure work; they do not
nominate a pilot host and must not be contacted, adopted, repaired, or mutated
for this rehearsal.

Before any gateway-host access or provisioning, an accepted population
addendum must name the exact provider resource, instance identity, public
addresses, environment, intended role, custody boundary, provisioning source,
and rollback target. The workspace owner must then separately authorize the
exact provider and host operations. An address inferred from local state,
network ownership, browser history, another task, or an operator handoff is not
gateway provenance and remains out of scope.

## Decisions still required

The workspace owner selected a two-stage acceptance sequence on 2026-08-28.
Stage one uses mainnet `11qx` and a freshly provisioned public gateway with the
staging application, database, and Privy tuple. It is the true public-HNS and
free-handle acceptance gate, but it excludes the canonical
`https://pirate.sc/c/11qx` route and every production migration or data-plane
write. A separately populated and authorized stage two may later prove the
canonical route and production composition.

The root nomination and sequence decision do not settle the remaining owner
decisions:

1. the exact staging gateway, database, protected-origin, credential, replay,
   deployment, and evidence tuple, isolated from production;
2. source-pin verification that Solid and api-next retain the completed shared
   protected-origin contract before any protected resource is created;
3. every missing staging migration through the exact stage-one deployment
   commit and its separate authorization, without production database access;
4. whether to populate and authorize the distinct production second stage,
   including its irreversible production migration and pilot-data writes; and
5. the exact scope and rollback limits for each stage's DNS, HNS, provider,
   deployment, credential, key, certificate, database, and transaction
   mutation.

Until those decisions and fresh read-only ceremonies are accepted, `11qx`
remains a nominated candidate and nothing may sign, broadcast, deploy, migrate,
or change its records.

## Repository-only stage-one population checkpoint

The 2026-08-28 documentation lane fetched both public repositories and froze
only values present in reviewed source. It did not query Cloudflare, Privy,
PostgreSQL, a gateway host, Bob Wallet, HSD, authoritative DNS, or any other
external system.

The selected source and static staging composition are:

```text
api_next_source_commit = 24fd9a90f44ba97ffcd93015c8de47f6361688e5
solid_source_commit = 4f511992b3473c620ff48a459672464328cb0561
shared_origin_contract_commit = c7aee1c1c6f938861558a4c39e308141ddc8a28e
api_next_worker = pirate-http-worker-staging
api_next_public_origin = https://api-next-staging.pirate.sc
solid_worker = pirate-web-solid-staging
solid_canonical_origin = https://web-next-staging.pirate.sc
staging_privy_application = cmsw5pis300b80cladbxx7bsr
staging_hyperdrive_id = 8cb7658a0f7143359c1becfec6a15c23
api_next_replay_binding = HNS_COMMUNITY_APP_API_REPLAY
solid_replay_binding = HNS_COMMUNITY_APP_REPLAY
owner_verifier_worker = pirate-hns-owner-verifier-staging
owner_verifier_source = hns_parent_chain_txt
owner_verifier_configuration_reference = hns-owner-staging
owner_verifier_configuration_version = hns-owner-config-v1
repository_migration_tip = 0069_media_analysis_snapshot_recovery.sql
repository_migration_tip_sha256 = 7e26e0cff1f2c8a1b2e1d119a73971a2ae793caebaba89b4b5bf50fda0dd14ca
```

The Solid source contains the completed shared-protected-origin contract at
`c7aee1c1c6f938861558a4c39e308141ddc8a28e`. The api-next and Solid staging
configurations keep their HNS enable switches false and their protected-origin,
Access, forwarder-registry, and gateway-deployment values empty. Those empty
values are containment evidence, not populated infrastructure.

Repository state cannot prove the backing staging PostgreSQL origin, current
migration ledger, protected hostnames, Access issuer or audiences, gateway
authority endpoint, gateway host, Worker deployment versions, registry
identity, certificate, DNSSEC material, or evidence destination. Those values
remain explicit hard stops and require a later authorized read-only inventory.
No candidate protected hostname is accepted merely from a naming convention.

The namespace activation, route, DNS-zone, app-host, offering, quote,
reservation, claim, grant, persona, and generation identifiers also remain
unresolved. Some are selected before a mutation ceremony and others are
server-generated results; the accepted transcript must distinguish the two
instead of inventing live identifiers from repository state. No deployment or
mutation ceremony is executable from this checkpoint.

## Credential-safe external inventory checkpoint

The workspace owner authorized a bounded read-only inventory on 2026-08-28.
The inventory used existing authenticated sessions without rendering a secret
value. It queried only Cloudflare resource metadata, secret names, the staging
`schema_migrations` ledger, public DNS, and the public Handshake explorer. It
did not read product tables, account data, Bob Wallet, private keys, or signing
interfaces and made no external mutation.

The exact candidate sources after the inventory are api-next
`72619e2817cb268f170d9044e5d586643e54957e` and Solid
`4f511992b3473c620ff48a459672464328cb0561`. The api-next advance from the
earlier `24fd9a9` pin adds this population record and an unrelated Megapot
operator-script repair; it adds no migration and does not change the HNS
runtime. The latest deployed staging compositions are older than those
candidate sources:

```text
api_next_deployment_id = ed442fc6-3df7-4f04-856f-28a2785c4825
api_next_worker_version = 35e4f25a-8259-49ff-8a2d-324c30582943
api_next_deployed_source = 24fd9a90f44ba97ffcd93015c8de47f6361688e5
solid_deployment_id = 58c856c9-65ff-438e-9bc7-0dbce01904ca
solid_worker_version = 2af726d7-e629-4fe7-9447-53136d932943
solid_deployed_source = a72b9213da15b659cd974b25946cfa8c055f8851
```

Both deployed Workers retain their replay Durable Object bindings. Their HNS
enable switches are false, and every community-app protected origin, Access
issuer, JWKS URL, audience, forwarder-registry reference/version, and gateway
deployment reference is empty. The api-next Worker has the forwarder-registry
secret name installed. The Solid Worker has the forwarder-registry name and
the six community API, authority, and handle-authority Access client names
installed. Secret presence does not prove correct, distinct, or current secret
bytes.

Hyperdrive `8cb7658a0f7143359c1becfec6a15c23` is named `api-next-staging` and targets
`us-east-3.pg.psdb.cloud:5432/postgres`, with caching disabled. The credential-
free gateway authority endpoint is therefore
`postgresql://us-east-3.pg.psdb.cloud:5432/postgres?sslmode=verify-full`; a later
ceremony must create a least-privilege staging credential without recording its
value. The injected migration-reader connected to database `postgres`, schema
`api_next`, and read exactly 69 ordered ledger rows. The last row is
`0069_media_analysis_snapshot_recovery.sql` with checksum
`7e26e0cff1f2c8a1b2e1d119a73971a2ae793caebaba89b4b5bf50fda0dd14ca`.
The canonical JSON array of returned version/checksum rows has SHA-256
`f7ba1a2af6fa8985344658275c7de6aa1e00cc466e135eef60030078f704c214`
and matches the exact repository manifest at the candidate source.

The stage-one migration ceremony is therefore a no-op at this source. Its
accepted preflight must repeat the same ledger-only query immediately before
deployment and require database `postgres`, schema `api_next`, 69 rows, the
same ordered-ledger digest, and the same `0069` tip/checksum. When all values
match, no migration command is run. Any missing, additional, reordered, or
checksum-mismatched row stops the pilot and requires a new reviewed migration
plan; it does not authorize `db:migrate` as a repair.

The proposed new protected hosts are
`hns-community-ingress-staging.pirate.sc` for Solid and
`hns-community-api-staging.pirate.sc` for the shared api-next API/authority
origin. Public A, AAAA, and CNAME queries returned NXDOMAIN for both names at
this checkpoint, and neither deployed Worker references them. Wrangler exposes
no Access-application listing command, and the existing browser session did
not provide a compatible read-only control channel. Their Access-application
absence is therefore unproved. The names remain proposed reservations, not
accepted resources, until a later credential-safe provider listing proves no
collision and returns the exact Access team domain and application audiences.
No OAuth bearer token was retrieved to bypass that stop.

No gateway host or evidence destination has been selected. Consequently no
authoritative nameserver address, DNSSEC keyset, DANE certificate, registry
identity, gateway manifest, deployment reference, or rollback target can be
populated honestly. Existing machines and addresses from other lanes remain
out of scope.

At public Handshake explorer block 344,626, `11qx` remained registered to the
same public owner address recorded above, with renewal-window end 443,415 and
the same live 33-byte version-zero resource effective since block 104,580:

```text
GLUE4 ns1.11qx. 44.231.6.183
NS    ns1.11qx.
GLUE4 ns2.11qx. 54.214.136.246
NS    ns2.11qx.
```

There was still no later resource UPDATE. This public observation is neither
wallet custody proof nor authorization to replace the resource. The exact
`11qx` mutation ceremony remains a draft with this pre-state and the following
unresolved replacement inputs: fresh owner outpoint and chain tip, two new
authoritative nameserver addresses, complete NS/glue resource bytes, DNSSEC DS
records, signed-zone digest, transaction preimage, unsigned transaction bytes,
fee and confirmation threshold, signed-transaction digest, and rollback UPDATE
bytes. Those values depend on an accepted fresh gateway/DNS host and custody
ceremony. No transaction can be assembled, signed, or broadcast before they
exist and receive separate authorization.

## Owner-supplied Access application inventory

On 2026-08-28 the workspace owner supplied the rendered Cloudflare Zero Trust
Applications list. It contains exactly two self-hosted applications:

```text
hns-community-api     hns-community-api.pirate.sc     policy solid-only
hns-community-ingress hns-community-ingress.pirate.sc policy gateway-only
```

These are the production protected origins and are not stage-one targets. The
inventory showed no application for either proposed staging hostname,
`hns-community-api-staging.pirate.sc` or
`hns-community-ingress-staging.pirate.sc`. This closes the application-name
collision question only for the rendered list; it does not establish the team
domain, application AUDs, policy rule bytes, service-token inventory, or
custom-domain availability.

Stage one therefore requires two new staging-only self-hosted Access
applications and must leave both existing production applications and policies
unchanged. No application, policy, token, DNS record, custom domain, or secret
was created or changed by this inventory.

On 2026-08-29 the workspace owner supplied the team domain
`piratesocialclub.cloudflareaccess.com` and the rendered Service Tokens list.
It contains exactly three enabled production tokens:

```text
hns-community-gateway-production          displayed expiry 2027-08-27 09:02 AM
hns-community-solid-api-production        displayed expiry 2027-08-27 09:20 AM
hns-community-solid-authority-production  displayed expiry 2027-08-27 09:21 AM
```

No staging token appears in the rendered list. The production tokens remain
out of scope and may not be reused, edited, rotated, disabled, or disclosed by
stage one. The list did not expose a client id or client secret.

Credential generation remains stopped pending a consumer-scoped Infisical
contract amendment. The gateway token belongs under a gateway-owned staging
path, and the two Solid tokens belong under a Solid-owned staging path.
api-next receives neither client secret; it validates the generated Access
audience as public configuration. Infisical environment selection carries the
`staging` distinction, so environment suffixes belong on Cloudflare resource
names but not on Infisical secret keys. No password manager is the canonical
runtime-secret store.
