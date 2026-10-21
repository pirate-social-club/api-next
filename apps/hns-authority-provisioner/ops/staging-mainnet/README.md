# Staging mainnet reader

The existing mainnet HSD node on the Spaces verifier host has a wallet-facing
RPC filter that permits broadcasts. The staging import must not use that filter.
This service binds a separate reader to `127.0.0.1:12039`. Its code accepts only
the five read methods used by HNS root observation and refuses every other RPC.
It forwards to the local HSD node through the existing HSD API key without
copying that key into the repository or a second file.

The reader requires a distinct staging client key delivered by systemd
`LoadCredential`. Only a pinned SSH local forward from the CI host may reach
the loopback listener. The SSH key on this host should allow forwarding only
to `127.0.0.1:12039`, with no shell, agent forwarding or remote forwarding.
The CI forward binds `127.0.0.1:24038`; both the staging provisioner and its
private observer driver use it. No public RPC port or HSD wallet capability is
opened for staging.

Run `node --test read-only-hsd-rpc-proxy.test.mjs` and `node --check
read-only-hsd-rpc-proxy.mjs` before installation. After starting the service,
send an authenticated `getblockchaininfo` through the local forward and verify
the mainnet genesis and fresh tip. Send a harmless `sendrawtransaction` method
name with a dummy value and require HTTP 403 without an upstream call. Compare
the existing Spaces RPC filter and HSD services as active before and after.
No Bob update is permitted until the staging verifier and provisioner agree on
the same safe block anchor.

## Public staging release on the CI host

The maintained public release uses94.103.168.209. The existing private Docker
daemon stays in place. Compose is supplied by Ubuntu Jammy
`docker-compose-v2=2.40.3+ds1-0ubuntu1~22.04.1`; its simulation adds only that
CLI package, without daemon changes or unrelated upgrades. `compose.yaml` reuses
`pirate-hns-public-ns2` as the signer and the existing private
`pirate-hns-staging-ns2` as its separate secondary API. Their external named
volumes survive release replacement. The private secondary also retains its
existing fixture zones, key and autoprimary. Add the staging-mainnet TSIG key
and `94.103.168.209 / ns2.8s28 / staging-mainnet` autoprimary without replacing
those rows. Signed transfers use the existing mainnet key. Both images are
PowerDNS5.1.5; keys and API settings are private files, never process arguments.
The private fixture API retains its existing loopback credential.

The public signer uses the tested old-primary SQLite recovery state, with its
four unchanged signing keys. Preserve the current public-secondary SQLite
snapshot and both original containers as rollback before changing either
container. Stop all writers, replace only the public authority's stable data
from the verified recovery copy, and retain ownership and permissions. Do not
reset PostgreSQL or replace the private secondary's seven fixture zones. Read
back every DS against the retained chain records before changing addresses.

The public API remains127.0.0.23:8081; the private secondary is127.0.0.22:8081.
Point the provisioner at those distinct endpoints and set its secondary master
to94.103.168.209. Set both delegated nameserver addresses and the gateway address
to94.103.168.209, keeping the names, TLSA/SPKI and chain reader unchanged.
Keep the provisioner stopped through the move. The separate regtest observer
and regtest HSD are retained fixtures, not dependencies of mainnet renewal.

The app artifacts come from protected api-next76cd679e. In a clean checkout
at that commit, run the existing combined gateway builder from
`apps/hns-platform-gateway` and `bun run build:vps-bundle` from
`apps/hns-authority-provisioner`. The asset stager binds the resulting entry
files by SHA-256, checks source ancestry, emits the canonical gateway manifest
and gives the provisioner a fresh probe attempt. Set the two bundle paths when
building this role from its protected deployment-source commit:

```sh
HNS_STAGING_GATEWAY_BUNDLE=/absolute/pirate-hns-community-app-handle-gateway.mjs \
HNS_STAGING_PROVISIONER_BUNDLE=/absolute/pirate-hns-authority-provisioner.mjs \
  scripts/hns-deployment/make-release.sh \
  apps/hns-authority-provisioner/ops/staging-mainnet /absolute/release-output \
  --monitored-container pirate-hns-public-ns2
```

Copy only the standard release package to the host. Point the gateway and
provisioner current links at its respective `gateway` and `provisioner`
subdirectories. The asset stager supplies each entry under `bin/`, covered by the sealed
release checksums. Install the
public gateway unit and disable the old private gateway unit, preserving its
prior state for rollback. Deliver the existing gateway credentials with
LoadCredential; do not substitute the expired private-fixture TLS identity.
Use the maintained probe-reseed command and a fresh attempt before resuming
the provisioner; its schema check alone is not launch acceptance.

`caddy-209.json` preserves the effective verifier route captured onOctober21
and adds the staging names on the existing listener. It loads the preserved
certificate/key from `/etc/pirate-hns-staging/public-gateway`, and disables
public certificate issuance only for those HNS names. The existing verifier's
HTTPS automation and route remain. Install `caddy-json.conf` as a Caddy unit
drop-in only after validation with the actual .209 binary:2.11.4,
SHA256b7105518e3ed1c0761f232e44fc09345535533c9cb0abf0e12809416c7ac64d9.
The production primary has a different custom binary and must not use this
staging configuration. Preserve the old Caddyfile and unit state for rollback.

Qualify gateway health and the retained certificate before changing8s28 glue.
Change only ns1's old glue address; preserve NS, DS and all unrelated chain
records. Reconcile pending transactions before broadcasting once, retain the
transaction ID before dispatch, and wait for current and safe chain evidence.
Use the reviewed adoption operation for8s28 and a18n, with actual observations
and fresh predecessor fences. Update API's deploy pin and the paired Solid
staging reference to gatewayb1457435 as the same release. Claimed200,
unclaimed421, DNSSEC/DANE, natural renewal and scheduled health acceptance
must pass before declaring staging recovered. The original public wallet-host
services stay retired. New signing/TLS state must enter scheduled encrypted
recovery on .209 before the old recovery state can be retired.
