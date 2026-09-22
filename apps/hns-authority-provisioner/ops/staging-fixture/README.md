# Isolated staging authority fixture

Run from the API repository with Docker, Bun and dig installed:

```sh
bun apps/hns-authority-provisioner/ops/staging-fixture/authority.ts --execute-local
```

The digest-pinned PowerDNS image must already exist locally. The runner does
not pull images or accept remote authority endpoints. The command above does
not connect to a wallet. It creates two uniquely named disposable containers, bound only to
127.0.0.21 and 127.0.0.22 on DNS port 53 and API port 8081. Conflicting listeners
cause failure; the runner never stops another container. Only its own containers
and their anonymous volumes are removed, on success or failure. A forced process
kill can leave labeled containers; inspect the exact run label before cleanup.
An exclusive directory lease in the system temporary directory prevents two
runners from sharing these listeners. A crash or failed container cleanup leaves
the lease in place; it is never automatically evicted. Reconcile its owner PID
and labeled containers before manually retiring that exact stale lease.

The maintained PowerDNS provisioner creates the primary zone and real DNSSEC
keys. The second authority obtains the signed zone by authenticated AXFR. The
maintained DNSSEC validator verifies both authorities using the fixture's DS
records and rejects tampered control TXT data. DNSKEY, NS, app address and TLSA
answers must agree. The maintained inspector verifies managed records and the
reservation-aware teardown verifies primary removal. Final success is emitted
only after container and volume cleanup completes.

The fixed fixture API and transfer keys are deliberately public test values.
No production credential belongs here. DNS resolution and notifications stay
on loopback; the production-shaped nameserver labels are not permission to
query production authorities. The fixture uses host networking for the existing
controlled test environment, with only bind-service and file-access capabilities,
no host filesystem mounts, and no public listeners.

To exercise the chain-to-DNS binding, start the maintained disposable HSD 8.0.0
regtest container from the sibling hsd-regtest profile, then run:

```sh
HSD_REGTEST_NODE_URL=http://127.0.0.1:24037/ \
HSD_REGTEST_WALLET_URL=http://127.0.0.1:24039/ \
bun apps/hns-authority-provisioner/ops/staging-fixture/authority.ts --execute-local --with-chain
```

The additional mode checks the node network and genesis and the existing
wallet's regtest receive-address prefix before any wallet mutation. It funds
only a regtest wallet, auctions a generated name, registers an empty R0, then
publishes an actual UPDATE from the maintained provision-root operation's
returned plan. That operation reads and rechecks the live current resource and
uses the real PowerDNS provisioner. Before publication, the returned resource
is checked against an independently built expected plan and its wire digest.
The receipt includes the provisioner's plan-document digest. This does not yet
exercise authenticated admission or the database-backed provision-job queue.
The maintained observer must see matching current records before matching safe
records. DNSSEC anchors are extracted from that safe-chain resource; whole-wire
resource equality and the maintained commitment selection are required. The
receipt retains the UPDATE txid, heights, selected commitment and resource digest.
The caller owns HSD cleanup; the fixture owns its two DNS containers. Repeated
runs create distinct names. There is no mainnet mode or Bob/6.1.1 ceremony proof.

The required hosted hns-regtest job now runs this chain-bound fixture before its
two existing lifecycle suites, on the job's isolated VM, with failure logs
retained. The local test:hns-regtest command itself still runs only those two
suites. Plain --execute-local remains a DNS-only diagnostic whose DS anchor is
supplied directly by the provisioner; it is not the hosted acceptance command.

The required hosted job uses scripts/hns-staging-gateway-fixture.ts with the
same --execute-local --with-chain arguments. It generates an in-memory,
one-day certificate and publishes its actual SPKI digest as TLSA. Both
authorities must serve that pin. TLS probes check the certificate and exercise
the maintained community gateway composition: the admitted app host reaches a
real loopback HTTPS fixture origin; an unclaimed host returns an empty 421 and
does not contact the origin. A wrong SPKI is rejected. Keys never enter files,
arguments or receipts. The standalone authority command retains its placeholder
TLSA diagnostic and does not claim certificate acceptance.

This remains component acceptance, not complete onboarding. Gateway authority
is seeded for this layer, not produced by authenticated activation. The origin
is a marker server, not Solid. TLS listeners use OS-assigned loopback ports as
an explicit fixture transport mapping for logical port 443, not public DNS
routing or production Caddy acceptance. Authenticated import, activation, real
community rendering and Playwright recovery remain unfinished. Public staging
flags and production are unchanged.

PowerDNS permits reading but not writing AXFR-MASTER-TSIG through its metadata
HTTP endpoint. Secondary setup therefore uses the maintained pdnsutil tsigkey
activate command inside the owned container, as described in the official
[TSIG documentation](https://doc.powerdns.com/authoritative/tsig.html).
