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
