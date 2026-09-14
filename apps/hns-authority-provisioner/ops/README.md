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
`hns-lifecycle-job-envelope-v1`; the cutover records that pair in
`hns_lifecycle_schema_cutover`. The reviewed migration endpoint is
`0172_hns_cutover_evidence_consistency.sql`; the sequence refuses any
migration beyond it rather than applying an unreviewed change. Build the
bundle from the cutover commit and run the sequence with the migration
administrator URL and the service executor identity:

```bash
bun run --cwd apps/hns-authority-provisioner build:vps-bundle
CONTROL_PLANE_POSTGRES_ADMIN_URL=... bun scripts/hns-readiness-cutover.ts \
  --bundle apps/hns-authority-provisioner/dist/pirate-hns-authority-provisioner.mjs \
  --stage-directory /srv/pirate-hns-authority-provisioner/current \
  --executor-id pirate-hns-provisioner-1
```

Each run generates a fresh attempt identifier and writes a
`deployment-manifest.json` beside the staged bundle with `bundle_sha256`,
`service_version`, `job_envelope_version`, `executor_id` and `attempt_id`. The
installed unit points the service at that manifest
(`HNS_AUTHORITY_DEPLOYMENT_MANIFEST`). The service measures its own running
entry file, compares the measured digest with the manifest digest, and records
both plus the attempt, probe job, lease fence, process start and probe
completion timestamps through the controlled probe. The sequence verifies the
identity row for the exact attempt; a previous attempt's result never
satisfies a retry.

The sequence order is fixed: refuse an incompatible bundle, stage, quiesce,
account live legacy leases, apply the preflight batch through `0168` in its own
transaction, apply the remaining reviewed migrations in a second transaction,
seed the synthetic probe, start the unit, then record schema compatibility,
running identity and executor progress separately. The two migration
transactions are deliberate: the preflight's durable
`readiness_single_owner_cutover_unresolved` dispositions must survive a
refused removal. The runner commits each `runPostgresMigrations` call as one
transaction, so when a later migration fails every migration in that call
rolls back and the ledger keeps only the previously committed versions; read
`schema_migrations` before resuming and re-run the same sequence after fixing
the fault rather than editing the ledger.

Refusal recovery, by step:

- `launch_guard` — the staged bundle's version is outside the recorded pair;
  stage the compatible release.
- `account_leases` — a live legacy readiness lease remains; wait for it to
  complete or expire, then re-run.
- `migrations` — a migration beyond the reviewed endpoint exists; rebase the
  change onto the reviewed endpoint or review and extend it.
- `schema_compatibility` — the recorded pair no longer admits this service;
  verify the deployment manifest.
- `service_identity` / `service_never_started` — the unit did not start; inspect
  the unit logs and the environment file.
- `service_identity` / `stale_attempt_result` — the identity row belongs to an
  earlier attempt; re-run the sequence so a fresh attempt and probe job are
  seeded.
- `service_identity` / `wrong_running_artifact` — the measured digest, version
  or executor does not match the manifest; reinstall the staged bundle.
- `executor_progress` — the probe did not complete despite a compatible
  schema; inspect the probe outcome and the service log.

The installed unit runs the bundle once with `--verify-schema` before
`ExecStart`, so an older bundle that predates the flag is rejected after the
cutover even though the old binary cannot know about the compatibility
record. The compatible binary also performs the same check at startup and
refuses with a bounded, redacted `schema_incompatible` outcome before claiming
any work. The synthetic probe is retained as cutover evidence, excluded from
normal claims and operational phase counts, and creates no session readiness
or activation evidence. The runtime role has no direct write path to the
identity table; the SECURITY DEFINER probe owns it.

## Staging post-migration entry point

The staging ceremony's migration owner is the reset lane's executor. Once the
single sequence has left the ledger at the reviewed endpoint
`0172_hns_cutover_evidence_consistency.sql`, the HNS post-migration steps are a
delegated entry point, `scripts/staging-hns-post-migration-entry.ts`. It
applies no migrations and refuses unless the ledger ends exactly at the
endpoint with matching checksums, so a failed reset replay cannot reach it.

The reset orchestrator calls `runHnsStagingPostMigration` in process after the
removal batch; it binds the real ports with
`makeHnsStagingPostMigrationPorts`, passing the connection strings for the
migrator `CONTROL_PLANE_POSTGRES_ADMIN_URL`, the runtime
`CONTROL_PLANE_POSTGRES_RUNTIME_URL` and the separately authorized operator
`CONTROL_PLANE_POSTGRES_OPERATOR_URL`, plus the provider-verified target
binding from `collectStagingProviderBinding`. That one-line delegation is
agreed with the reset lane and lands on its branch or after its merge;
migration ownership stays there and `staging-persona-phased-reset.ts` is not
modified.

The results are named and separate: target and ledger, identities, grants,
privilege matrix, bundle, probe, service, schema compatibility, service
identity, executor progress. The grants are EXECUTE on the six-argument
`run_hns_lifecycle_readiness_cutover_probe_v1` for the runtime identity, and no
direct INSERT, UPDATE or DELETE on `hns_lifecycle_service_identity` for the
runtime identity, the operator identity or PUBLIC. The effective matrix is read
back with `has_function_privilege` and `has_table_privilege`, so PUBLIC and
inherited authority count, and any deviation refuses. The bundle and
`deployment-manifest.json` are staged under a fresh attempt identifier; the
explicitly named `pirate-hns-authority-provisioner-staging.service` is the only
unit the path starts, and schema compatibility, the measured running identity
and executor progress are verified against that exact attempt.

Refusal recovery for the staging path:

- `migration_endpoint_missing` — the reset sequence has not reached the
  reviewed endpoint; complete or restore the reset first, never edit the
  ledger.
- `checksum_mismatch`, `migration_missing`, `migration_not_pinned`,
  `migration_endpoint_exceeded` — the ledger no longer matches the reviewed
  chain; stop and reconcile the reset, do not resume past it.
- `runtime_migrator_conflict`, `runtime_operator_conflict` and the role
  mismatch refusals — the derived identities are wrong or conflated; fix the
  credential delivery rather than mapping around the guard.
- `probe_execute_missing` — the reviewed EXECUTE grant did not take effect;
  `identity_write_allowed` — an effective write remains, including one
  inherited through a role membership; resolve it before retrying.
- `artifact_mismatch`, `attempt_mismatch`, `probe_absent` and `lease_conflict`
  — the probe's own recorded outcomes; they are reported immediately and name
  what the service observed.
- A refusal after the service starts carries a `service_disposition` of
  `started_unverified` and a resumable recovery receipt: stop the unit, confirm
  the previous attempt is no longer running, then re-run so a fresh attempt and
  probe are seeded. Never reuse an attempt identifier.

The two migration modes are different and must not be described as one. A
fresh reset replays the chain one migration per transaction through the phased
reset, and a failed replay enters the reset workflow's full-restore recovery.
An in-place cutover applies `0168` in its own transaction and `0169` through
`0172` as one atomic batch because `runPostgresMigrations` wraps each call in
a single transaction. The entry point runs only against a terminal ledger and
keeps `probe_job_id` and the lease fence bound to the exact attempt.

The standalone CLI form, for an operator after the reset lane's binding lands:

```bash
CONTROL_PLANE_POSTGRES_ADMIN_URL=... \
CONTROL_PLANE_POSTGRES_RUNTIME_URL=... \
CONTROL_PLANE_POSTGRES_OPERATOR_URL=... \
bun scripts/staging-hns-post-migration-entry.ts \
  --bundle <staged bundle path> \
  --stage-directory /srv/pirate-hns-authority-provisioner-staging/current \
  --executor-id <executor id> \
  --runtime-role <runtime role> \
  --operator-role <operator role> \
  --migrator-role <migrator role>
```

Everything in this section is executable only under the staging
authorizations; it does not authorize a reset, a service start or a
deployment.

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
