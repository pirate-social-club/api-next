# HNS observer-driver authority-host profile

This profile exposes only the target-owned private HSD exchange needed by the
production parent-chain ownership source. It listens on `127.0.0.1:4081` and
is reachable from the owner-verifier Worker only through the reviewed
Cloudflare Tunnel and VPC Service. It has no public hostname, route, bearer, or
authoritative-DNS capability.

Build one artifact from an accepted commit:

```bash
bun run --cwd apps/hns-observer-driver build:vps-bundle
sha256sum apps/hns-observer-driver/dist/pirate-hns-observer-driver.mjs
```

Install the artifact as
`/srv/pirate-hns-observer-driver/current/bin/pirate-hns-observer-driver.mjs`,
the environment file as `/etc/pirate/hns-observer-driver.env`, and the tracked
systemd unit. Store only the HSD API key in
`/etc/pirate/hns-observer-driver-hsd-api-key`; systemd exposes it as a
read-only credential. The process constructs the HSD Basic authorization
header in memory and never logs it.

The HSD endpoint must be the existing loopback RPC listener. The VPC Service
must target loopback port 4081 through a Tunnel connector on the retained
primary authority host. Bind the resulting service id to the owner-verifier as
`HNS_OBSERVER_DRIVER`. Do not add a public ingress rule to the Tunnel.

Install `cloudflared-hns-authority.service` with the observer-driver unit. Its
tracked token-file path identifies the dedicated private production tunnel,
while the tunnel token remains a root-owned file outside the repository and is
passed to the dynamic service user through a systemd credential.

Before enabling HNS ownership in the HTTP Worker, prove one exact private HSD
request through the owner-verifier binding, verify that a DNS operation is
rejected, and confirm the driver port is not listening on a public address.
