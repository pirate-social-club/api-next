# HNS authority provisioner VPS profile

This app is the external executor for HNS root imports. The HTTP API writes
durable provisioning and observation jobs. This process is the only component
that reads those jobs and talks to HSD and PowerDNS. Without it, root-import
sessions remain queued.

Build one Bun artifact from a clean accepted commit:

```bash
bun run --cwd apps/hns-authority-provisioner build:vps-bundle
sha256sum apps/hns-authority-provisioner/dist/pirate-hns-authority-provisioner.mjs
```

Install the artifact as
`/srv/pirate-hns-authority-provisioner/current/bin/pirate-hns-authority-provisioner.mjs`.
Copy `env/hns-authority-provisioner.env.example` to
`/etc/pirate/hns-authority-provisioner.env`, replace every placeholder, make it
root-readable only, and install the tracked systemd unit. Store the canonical
base64 AXFR TSIG secret in `/etc/pirate/hns-authority-axfr-tsig-secret`; systemd
exposes it to the dynamic service user as a read-only credential and it never
enters the environment.

The service runs one bounded process. It drains available work serially and
waits two seconds when both queues are empty. Provisioning takes priority over
observation. Database leases and finalization fences make a service restart
safe; PowerDNS reconciliation is idempotent. HSD and PowerDNS calls have
five-second request deadlines.

## Single-owner readiness cutover

The cutover is one reviewed deployment sequence, not a bare migration run. The
compatible release is `pirate-hns-authority-provisioner-v2` with job envelope
`hns-lifecycle-job-envelope-v1`; the removal migration records that pair in
`hns_lifecycle_schema_cutover`. Build the bundle from the cutover commit and
run the sequence with the migration administrator URL:

```bash
bun run --cwd apps/hns-authority-provisioner build:vps-bundle
CONTROL_PLANE_POSTGRES_ADMIN_URL=... bun scripts/hns-readiness-cutover.ts \
  --bundle apps/hns-authority-provisioner/dist/pirate-hns-authority-provisioner.mjs \
  --stage-directory /srv/pirate-hns-authority-provisioner/current
```

The sequence refuses an unsupported bundle against the recorded schema pair,
stages the bundle and its `deployment-manifest.json`, quiesces the unit,
refuses while a live legacy readiness lease remains, applies the 0168
preflight in its own transaction, applies the 0169 removal in a second
transaction, starts the unit and verifies the compatible claim path. The two
migration transactions are deliberate: the preflight's durable
`readiness_single_owner_cutover_unresolved` dispositions must survive a
refused removal. Do not apply the preflight and removal as one ordinary
all-pending migration run.

The installed unit runs the bundle once with `--verify-schema` before
`ExecStart`, so an older bundle that predates the flag is rejected after the
cutover even though the old binary cannot know about the compatibility
record. The compatible binary also performs the same check at startup and
refuses with a bounded, redacted `schema_incompatible` outcome before claiming
any work.

Use the maximum seven-day readiness lifetime in production. Activation records
the initial DNS health lease from this observation; it does not replace the
existing append-only successor ceremony that renews health after activation.

Use the authority host because HSD and the PowerDNS API are private authority
dependencies. Do not move either API onto the public network. The configured
Postgres role needs only execute access to the four root-import claim and
finalize functions and the table access those security-invoker functions
require. It must not own migrations or tables.

Before enabling the service, verify the shared TLSA association against the
certificate currently served by the gateway and verify that the gateway IP,
deployment reference, fixed `ns1.pirate.` and `ns2.pirate.` delegation, AXFR
TSIG key, the two explicit authority addresses, and PowerDNS SOA all describe
the same production authority tuple. Readiness queries DNSSEC and acquires a
TSIG-authenticated AXFR independently from both authorities, requires the
canonical zone bytes to match, and checks the live gateway certificate SPKI
before it records evidence.

The generic production profile is pinned to the general HNS DANE gateway
certificate SPKI
`5c8ddd3dbf63dbab698c726708b06177adda4a21416c675197f97e3b27ab20d8`,
which is the certificate Caddy serves for new root and handle SNI. Do not use
the root-specific `app.jazleeuw` certificate in the provisioner. A future
certificate rotation must update Caddy and this TLSA value in one reviewed
edge ceremony before another root is provisioned.

After installation, start one non-production root import. Confirm that the
session progresses from `provisioning` to `awaiting_owner_update`, that the
returned wallet plan is a complete replacement, and that no activation occurs
until the explicit authorized activation request. The production milestone is
a second root completing that entire flow and then using the existing handle
offering and claim endpoints.

These files are deployment templates. They do not authorize a VPS connection,
credential change, service action, DNS mutation, deployment, or Handshake
transaction.
