# Isolated persistent staging host

This profile is for the explicitly approved non-production CI host only.
It must never be installed on a production authority. It supplies a private
container runtime, not a completed HNS deployment or public staging DNS.

The dedicated slice limits the daemon and its container scopes together to one
CPU, 768 MiB RAM, no swap and 1,024 tasks. The host's existing CI and verifier
services are unchanged. Resource exhaustion may stop staging work; it must not
be handled by raising limits or stopping another workload without review.

Before installing packages, verify that no Docker/containerd installation or
service exists. Mask only the absent default docker.service, docker.socket and
containerd.service so package installation cannot start a general-purpose
daemon. Simulate the exact package transaction first; reject removals or
upgrades of existing packages. Disable automatic unrelated service restarts
during the installation. Do not change the existing CI broker or Caddy.

Install these two unit files without overwriting existing targets, verify them
with systemd-analyze, then start only pirate-hns-staging-docker.service.
The private socket is /run/pirate-hns-staging/docker.sock and is root-only.
All container operations must explicitly use that socket. The daemon disables
the default bridge, firewall management, forwarding and masquerading. HSD and
DNS use host networking with explicit loopback listeners. The isolated TLS
network described below is the only approved named bridge. No public Docker API exists.
Container scopes belong to pirate-hns-staging.slice, rather than escaping the
resource budget. Before and after startup compare listeners, forwarding state
and firewall rules and check the pre-existing services remain active.

Use pinned images, bounded per-container resources, named staging volumes and
explicit labels. Never mount production paths or retrieve production secrets.
Local public fixture keys are not credentials for a public endpoint. Persistent
data stays below /var/lib/pirate-hns-staging; check disk headroom before loads
and runs. Cleanup targets only inventoried HNS resources, never Docker prune.

Host installation does not authorize Cloudflare resource creation, a Worker
deployment, an import or mainnet operations. Those steps retain their own
configuration, authority and acceptance checks.

`authority-smoke.ts --execute-host` exercises the maintained provisioner against
these exact loopback authorities. Build its Bun bundle in the admitted checkout
and compare its digest after transfer before running it on the approved host.
It creates one random fixture zone, waits for automatic signed secondary
admission, validates real DNSSEC on both authorities, rejects tampered DNS, and
removes the primary through the maintained reservation-aware teardown. Secondary
removal requires a fresh match of its fixture account, primary address, exact
root and challenge TXT. Both removals are read back independently.

A failure retains the zone for diagnosis and prints only its generated root.
Do not blindly retry: inspect that exact root on both authorities and reconcile
its disposition first. The command does not clean other runs or zones. Its DS
anchor comes directly from provisioning, and its TLSA is a placeholder; this is
authority installation acceptance, not chain, gateway or browser acceptance.
The explicit secondary cleanup here does not implement cleanup for persistent
product imports; that lifecycle integration remains separate work.

## Private TLS placement

The existing CI Caddy owns wildcard port 443 and must not be reconfigured.
The named `pirate-hns-staging-tls` internal bridge gives the new TLS container
its own port 443 at `172.31.254.2`, reachable from host-side readiness checks
without publishing a host port. Reserve `172.31.254.0/28`, gateway
`172.31.254.1`, only after comparing every existing host route for overlap.
Creation uses the private daemon, label `pirate.hns.environment=staging`,
`--internal`, bridge name `phnsstage0`, and
`com.docker.network.bridge.enable_ip_masquerade=false`. Do not turn on
forwarding, modify firewall policy, publish ports, or attach unrelated
containers. Compare normalized IPv4 and IPv6 firewall rules before and after.

A port-only probe on this topology reached container port 443 while existing
services stayed active; its container was removed. This is not TLS acceptance.
The TLS terminator, certificate and maintained gateway upstream still need
composition. The TLS container has no Internet egress; the host-side gateway
must retain its separately approved staging origin access. This network is not
a public staging authority or authorization for a mainnet ceremony.

The gateway-bridge socket/service templates reuse systemd-socket-proxyd to
connect Caddy's private bridge destination to the maintained gateway's loopback
listener. They bind only phnsstage0 at 172.31.254.1:4269, not a public interface.
The proxy has a bounded connection count and staging slice budget; its IP
allowlist admits only the TLS container and loopback. Verify the host supports
the IP accounting/filtering directives before installation rather than treating
unsupported filtering as enforced. No HTTP headers are added here: Caddy owns
the scrubbed scheme/SNI boundary and the gateway owns request admission.

These are source templates, not an installed service. Before enabling, verify
the private network address, binary path and directives on the target host,
qualify the approved gateway upstream on loopback, and confirm port ownership.
Stopping the socket and service removes only this transport. Do not alter the
existing Caddy or open a public port. A socket connection alone does not prove
database authority, authenticated forwarding or community rendering.
