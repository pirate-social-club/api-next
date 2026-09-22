# Isolated staging authority fixture

Run from the API repository with Docker, Bun and dig installed:

```sh
bun apps/hns-authority-provisioner/ops/staging-fixture/authority.ts --execute-local
```

The digest-pinned PowerDNS image must already exist locally. The runner does
not pull images, accept remote endpoints, read credentials, or connect to a
wallet. It creates two uniquely named disposable containers, bound only to
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

This is the real-authority component of staging enablement, not complete HNS
onboarding. Its DS trust anchor is supplied directly by the provisioner, not
read back from a chain. The TLSA hash is a placeholder; no certificate or gateway
acceptance is claimed. Authenticated import, regtest publication/current/safe
observations, real TLSA/certificate matching, activation, gateway isolation and
Playwright recovery remain to be composed before staging flags are enabled.
There is no change to the hosted required regtest gate or production settings.

PowerDNS permits reading but not writing AXFR-MASTER-TSIG through its metadata
HTTP endpoint. Secondary setup therefore uses the maintained pdnsutil tsigkey
activate command inside the owned container, as described in the official
[TSIG documentation](https://doc.powerdns.com/authoritative/tsig.html).
