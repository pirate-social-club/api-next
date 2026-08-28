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
