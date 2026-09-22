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
bridge creation, firewall management, forwarding and masquerading; use only
host networking with explicit loopback listeners. No public Docker API exists.
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
