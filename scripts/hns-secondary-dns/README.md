# Secondary DNS release verification

This is api-next-owned operational tooling for the independent PowerDNS
secondary. It is not the primary authority provisioner, a queue consumer or a
replacement for end-to-end DNSSEC/DANE observation. Python 3.10 or newer and
the Docker CLI are sufficient; there are no Python package dependencies.

The initial profile preserves the reviewed PowerDNS 5.1 image digest, Compose
bytes and September 1 readiness configuration. The SQLite database and its
trigger remain retained host state, not release contents. The trigger file is
an expected-policy fixture, never an automatically executed migration.

PowerDNS permits unsigned outbound transfers from allow-axfr-ips and separately
admits transfers signed by an authorized TSIG key, regardless of that IP list.
Thus the retained primary IP allowance and TSIG metadata are independent paths,
not an AND requirement. Signed autoprimary NOTIFY remains required. See the
[PowerDNS TSIG documentation](https://doc.powerdns.com/authoritative/tsig.html).
This repair preserves those semantics. Changing them is a separately reviewed
policy change. Configuration comments describing a primary-only signed transfer
must not be mistaken for a stronger enforcement guarantee.

## Build and review

Use a clean, reviewed source commit. Copy this directory to an immutable
release directory without test artifacts or Python caches. The manifest is a
proposal, not automatic approval of observed host state:

```sh
python3 verify-release.py --release /absolute/staged-release --emit-manifest EXACT_40_CHARACTER_SOURCE_COMMIT > /absolute/staged-release/manifest.json
sha256sum /absolute/staged-release/manifest.json
```

Review the source SHA, manifest and each file digest against the accepted
source tree. Record the exact manifest digest outside the release. Never
regenerate a trust anchor merely to clear a verification failure. The manifest
is data: no shell command or executable environment fragment is sourced from it.
The verifier itself is supplied from the reviewed release; this is drift
verification, not protection against a root operator replacing both verifier
and trust anchor.

Place the reviewed digest alone in a root-owned mode 0644 or tighter file,
then verify staged bytes without touching Docker or the database:

```sh
python3 verify-release.py --release /absolute/staged-release --manifest-sha256-file /absolute/reviewed-digest --files-only
```

This reports files-only and no zone count; it is not runtime acceptance. The
normal invocation adds bounded Docker inspection, mounted configuration hashing
inside the container, and a read-only SQLite transaction. It checks the exact
image, commands, environment against image defaults, network mode, restart
policy and mounts, signed zone metadata, autoprimary tuple and trigger. The
checks fail closed on drift, missing Docker/database access or timeout. Outputs
contain source and manifest digests, a zone count and refusal codes, never
zone labels, TSIG secret bytes, subprocess output or raw exceptions. No mode
sends an alert or contacts a heartbeat endpoint.

## Install and rollback

Keep the existing database at /srv/pirate-hns-secondary/shared/data. Do not
copy, replace or rewrite it during this release. Stage the approved files under
/srv/pirate-hns-secondary/releases/COMMIT and retain the prior current selector.
Retain the existing verification units and timer configuration as rollback
evidence. Install the independent manifest digest at
/etc/pirate-hns-secondary/manifest.sha256 and the supplied service/timer units.
The service needs root-equivalent Docker access and read access to the SQLite
store. Its systemd sandbox is defense in depth, not a boundary against the
Docker daemon. No operator database credential or webhook is installed here.

Verify runtime against the staged release before changing current. The initial
repair preserves the exact Compose and DNS configuration bytes and the running
image, so it does not require restarting the DNS container. The bind source
remains /srv/pirate-hns-secondary/current/config/pdns.conf; the verifier also
hashes the actual file inside the container to detect a stale bind after any
future change. A future change of those bytes needs its own reviewed container
recreation and serving cutover, not just a symlink switch.

Switch current atomically, verify again, then enable the new timer. Retain one
manual and one natural timer invocation with actual start/end times and exit
status. Only after those pass, disable the obsolete secondary verification
timer and retain its failed notification state honestly. The new unit has no
OnFailure hook to the retired receiver. Local-only verification does not repair
operator delivery or external dead-man coverage; hns-monitoring-repair owns
those outstanding integrations. Do not report this release as complete alerting.

Prove authoritative DNS responses and signed AXFR from both authorities through
the maintained continuity observer before and after the switch. Separately
retain unsigned transfer behavior without logging zone contents. Do not promote
an inventory or change a gateway reference in this DNS verification release.

Rollback stops/disables the new timer, restores the previous current selector
and retained unit state, and verifies DNS serving against the retained bytes.
No database rollback or TSIG rotation is involved. If runtime bytes diverge,
stop and diagnose before any selector change; do not reset the manifest baseline.

## Verification

Run python3 scripts/hns-secondary-dns/verify-release.test.py from the repository.
CI runs the same real filesystem and SQLite tests. They exercise manifest and
artifact drift, runtime image/mount/command mismatch, trigger and zone metadata
drift, and prove that the database file is unchanged by a healthy observation.
These tests do not stand in for the installed timer and live transfer receipts.
