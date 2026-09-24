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

The proxy does not send a systemd readiness notification, so its service uses
`Type=simple`. A `Type=notify` service can forward briefly but then fail on
systemd's startup timeout. If the host's input firewall blocks the private
bridge, an operator must separately approve an exact rule restricted to
`phnsstage0`, source `172.31.254.2`, destination `172.31.254.1`, TCP port 4269.
Record normalized IPv4 and IPv6 rules before and after, read back that single
rule, and remove it if the bridge cannot remain healthy. Do not open a public
port or change forwarding.

These are source templates, not an installed service. Before enabling, verify
the private network address, binary path and directives on the target host,
qualify the approved gateway upstream on loopback, and confirm port ownership.
Stopping the socket and service removes only this transport. Do not alter the
existing Caddy or open a public port. A socket connection alone does not prove
database authority, authenticated forwarding or community rendering.

The gateway and provisioner unit templates are also staged here. They use
separate staging paths and the existing bounded slice. The gateway selects the
maintained `staging-private-tls` mode and receives database, forwarder and
Solid Access credentials through systemd `LoadCredential`. The provisioner
retains the maintained schema/bundle launch guard and reads its own root-owned
environment file plus a separate TSIG credential. Neither unit is installed
by the fixture or tunnel setup. Before installing either, verify the exact
bundle and manifest, credential identities and file modes, read-only gateway
database grants, local listener ownership, service dependencies and combined
slice headroom on the target host. A passing unit-template test is not a
running-service or E2E result.

## Private staging connector

The tunnel service uses cloudflared 2026.9.1 for Linux amd64, verified against
SHA-256 03f1f25d1cc93b9ad6c60569d44060bc4f17ed97075760ed8cfca4b12dcd68cc.
Install it at /srv/pirate-hns-staging/tunnel/cloudflared after digest validation.
Automatic updates are disabled. The dedicated connector token is installed
root-owned mode 0600 at /etc/pirate-hns-staging/tunnel-token and delivered by
systemd LoadCredential, never an argument or environment variable. Verify its
account and tunnel binding in memory before installation. Do not reuse a
production connector credential.

Metrics bind only 127.0.0.1:4083. The dynamic-user service shares the bounded
staging slice and adds a 96 MiB memory ceiling, 15 percent CPU quota and 64-task
limit. Check host port ownership and systemd validation before enabling.
Disabling only pirate-hns-staging-tunnel.service stops this connector without
removing Cloudflare resources or affecting another tunnel.

The approved observer service targets HTTP 127.0.0.1:4082 through this tunnel.
There is no public hostname. Healthy connector connections and exact directory
readback are transport prerequisites, not proof of a Worker fetch or an
authenticated import. Worker binding and deployment remain separate operations.

## Regtest journey runner bundle

Build only from a clean, reviewed commit in the admitted api-next worktree.
The builder compiles in the staging host's regtest endpoints (loopback
24037/24039 and the fixture key); the bundle ignores HSD_REGTEST_* environment
and never falls back to the test fixture ports 14037/14039.
Create a new empty package directory outside the checkout and run
`bun apps/hns-authority-provisioner/ops/staging-host/build-journey-chain.ts
--output /absolute/package/journey-chain.js` from the repository root. The
builder refuses an existing output, bundles the relative regtest fixture
imports, executes a no-network invalid-command probe from the package
directory, and prints the exact source and bundle SHA-256. Preserve that
JSON receipt beside the bundle and independently recompute the digest before
any transfer.

Installation is a separately approved CI-host operation, not part of the
build. `bun apps/hns-authority-provisioner/ops/staging-host/install-journey-chain.ts
--bundle /absolute/package/journey-chain.js --expected-sha256 <reviewed-sha>`
is a local-only dry run. After reviewing that result, add `--execute-host` for
the single approved installation. The installer checks the host's exact target
first, refuses an existing different file or symlink, transfers only the
bundle into a new private temporary file, verifies its SHA-256 there, then
installs it atomically at `/opt/pirate-hns-staging/journey-chain.js` with root
ownership and read-only executable mode. A final host readback must match.
An uncertain response is stop-only; inspect the target before any retry. The
Solid handoff pins that final digest before login and checks it again before
every command. Do not copy source files, node_modules, credentials or a
package directory to the host.

The runner keeps its lease and per-root `publish-<root>.json` dispatch fence
in one fixed state directory, `~/.local/state/pirate-hns-staging-journey` of
the account running it. The home directory comes from the account database, not
`HOME`; there is no environment override, and the location is outside aged
temporary storage. Before any lease or claim the runner refuses unless that
directory is a real directory owned by the running user with mode 0700 (not a
symlink). The fence is created atomically and fsynced before `sendupdate`,
records the session, response, plan and resource digests, then records the
returned TXID before mining and the confirmed inclusion height read from the
node afterwards.

The claim proves only that an attempt was fenced, not that a transaction was
broadcast. Every failure after the claim prints
`{"outcome":"journey_chain_dispatch_ambiguous","code",...,"txid","receipt"}`
on stderr and exits 3; `txid` is present only when the wallet returned one and
is never inferred. Only failures before the claim print
`{"outcome":"journey_chain_refused","code"}` and exit 1. An unconfirmed
broadcast returns `broadcast_unconfirmed` with its TXID; `advance-safe` then
mines, never re-sends, but only for that root's own fenced broadcast of the same
response. A lost response or failed mine never authorizes redispatch; read
`status --root`, which reports the receipt, and reconcile with the chain by
hand. The file and lease are not automatically cleaned up after a failed
journey.

If writing the claim itself fails after the file was created, the runner
reports a pre-claim refusal (nothing was dispatched) but the root stays fenced
by the partial file; choose a new journey root rather than deleting the fence.
Earlier runner versions kept the lease and receipts in
`/var/tmp/pirate-hns-staging-journey`. Before the first run of this version,
read that directory on the host once: any lease or receipt there belongs to an
older journey and must be reconciled by hand, never moved into the new state
directory to satisfy a check.
