# Production activation mainnet reader

This service gives the production HTTP Worker's HNS Activate step a private,
read-only current view of the existing mainnet HSD node. It reuses the tested
RPC method filter from `../staging-mainnet/read-only-hsd-rpc-proxy.mjs` and
binds only `127.0.0.1:12039` on the existing production HNS host. A separate
Cloudflare VPC service on the host's existing private tunnel reaches that port.
No public HSD or wallet RPC listener is added.

Install the two source files together under
`/opt/pirate-hns-production/mainnet-reader/`, preserving the
`production-mainnet/` and `staging-mainnet/` relative directories. Load the
upstream HSD API key from its existing host file through systemd credentials.
The listener defaults to port 12039; the bounded port override exists for the
isolated bootstrap test and is not set by the production unit.
Generate a separate random client key for this service, keep it in the
restricted host path named by the unit, and deliver only its Basic
authorization value to the production Worker secret. Neither key belongs in
arguments, environment variables, repository files or logs.

Before enabling production activation, check that the proxy permits
`getblockchaininfo`, returns the mainnet genesis and a fresh tip, and rejects
`sendrawtransaction` with HTTP 403 without an upstream call. Read back the
production VPC service ID, Worker binding and secret names, then run a
production activation check through the Worker. Keep the staging reader and
production verifier unchanged. The production host, VPC service, secret and
Worker are release mutations and need the amended release approval.

## Secondary readiness API forward

The production provisioner needs a private view of the secondary PowerDNS API
before it can admit a fresh imported root. The API binds only to
`127.0.0.1:8081` on the existing secondary host. Install
`pirate-hns-secondary-api-tunnel.service` on the existing primary and
provisioner host. It forwards only `127.0.0.1:18081` there to secondary
loopback port 8081. The unit uses systemd credentials for a dedicated SSH key
and a pinned host key; its command line contains neither private key nor API
key. It refuses a failed forward and restarts when the connection drops.

Generate a dedicated tunnel key after approval. The secondary's authorized
key must admit only the primary source address and forwarding to
`127.0.0.1:8081`, with no shell, PTY or other forwarding. Pin the already
trusted secondary host key in
`/etc/pirate/hns-secondary-api-tunnel/known_hosts`; do not bootstrap trust
from an unverified network scan. Keep the private key at the unit's protected
`id_ed25519` path. Read back that ports 8081 and 18081 listen only on
loopback before starting the new provisioner.

The provisioner environment then needs the five
`HNS_AUTHORITY_SECONDARY_*` settings: URL
`http://127.0.0.1:18081`, API key from the protected operator secret, server
ID `localhost`, expected master `94.103.168.161` and account
`pirate-primary`. The source also requires mainnet tree interval 36, safe
confirmations 12, maximum tip age 10800 seconds and maximum future tip
3600 seconds, matching the staging-proven mainnet profile. Keep its current DNS,
certificate and gateway settings until the coordinated gateway selector
switch; then pin the matching new gateway reference in the same release.

The previous provisioner bundle and environment, secondary DNS selector and
container remain the rollback target. If the private API read or retained-zone
comparison fails, restore those exact prior versions and verify the existing
production root from both public authorities before proceeding.
