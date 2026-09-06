# HNS operator monitor

This read-only monitor discovers every active DNS activation, including retained
operator roots. It checks the exact pinned inventory and latest health for the
current generation, current-generation renewal jobs, the scheduler heartbeat,
and the certificate served for each app host. No root list is compiled into the
command. It never schedules renewal or writes serving state.

The certificate probe connects to the configured gateway IP using each app
hostname as SNI. It checks the served SPKI against the DNS activation pin and
checks certificate validity. Spec 009 uses DANE-EE identity: one controlled
certificate may serve many activated HNS names, so WebPKI SAN hostname matching
is not required.
This is a retained-pin check, not a fresh DNSSEC or DANE validation. The existing
authority and DANE probes still need their separate repair. The configured IP
must serve all monitored roots in the reviewed deployment topology.

## Configuration and dry-run

Use a private JSON file with `gateway_address` set to the reviewed gateway IP
and `checkpoints` set to an array. A checkpoint contains `root`,
`activation_generation` as a decimal string, and `due_at` as Unix seconds.
An explicit deadline applies only to that generation, so a completed successor
does not keep alerting on its predecessor's checkpoint. Operator roots also
alert when their pinned inventory reaches five days old. Imported roots do not
receive a manual-checkpoint alert.

Load the database URL through the existing Infisical operator path. A dedicated
read-only database role is preferred; the command itself always starts a
repeatable-read, read-only transaction with a ten-second statement timeout.

```sh
rtk proxy infisical run --env=prod --path=/services/api-next/operator --silent -- bun scripts/hns-monitor.ts --config /absolute/monitor.json --dry-run
```

Dry-run creates no receipt database and makes no outbound alert request. It
does perform database reads and bounded TLS probes. Output contains hashed root
identities and condition codes, never connection strings, webhook URLs, raw
database errors, certificate bodies or authenticated sessions. Exit status zero
means no detected condition; one means conditions exist; two means the command
could not complete. Zero does not prove user-facing functionality or restoration.

Conditions include a stale or absent scheduler heartbeat, unhealthy or missing
serving evidence, serving validity below two days, any terminal renewal job,
a delayed job at least three hours old, a missed manual checkpoint, certificate
validity below fourteen days, a pin mismatch, and unavailable observation.
Delayed age uses job creation time while the job is delayed, so retry updates
cannot reset its age. Superseded generation jobs do not alert.

## Delivery and acknowledgment

The destination is supplied only through `HNS_OPERATOR_ALERT_WEBHOOK_URL` in
the operator environment. It must accept an HTTPS POST with a JSON `text`
field and acknowledge with a 2xx response. Redirects are refused. URL credentials
and fragments are refused; any token in the operator-owned URL remains secret.
The request has a ten-second abort deadline and does not retry internally.
The dedicated existing HNS alert service and sink interface enforce the message
boundary. The public-song Workers Logs sink is unchanged.

```sh
rtk proxy infisical run --env=prod --path=/services/api-next/operator --silent -- bun scripts/hns-monitor.ts --config /absolute/monitor.json --state /private/state/receipt.sqlite --deliver
rtk proxy infisical run --env=prod --path=/services/api-next/operator --silent -- bun scripts/hns-monitor.ts --delivery-test
```

The delivery test sends a clearly marked synthetic terminal-renewal condition
through the real adapter. It does not mutate production health or job rows.
Run it only against the operator's selected destination. Retain the operator-side
message receipt as well as the command's acknowledgment; a provider 2xx alone
does not prove someone received a notification. Mailbox delivery requires the
operator's mail adapter or an independently reviewed email integration.

The local SQLite receipt is private operator-tool state, separate from the
Workers alert delivery ledger. It records a condition fingerprint after
acknowledged delivery, suppresses unchanged alerts for six hours, sends changed
conditions immediately, and reports recovery once. An immediate transaction
serializes concurrent senders. Failed sends do not advance the receipt. A process
death or lost acknowledgment can produce a duplicate notification; this is
at-least-once delivery, not an exactly-once promise. Back up neither destination
secrets nor session material into the receipt.

## Runtime installation

Build the standalone bundle from the reviewed source with frozen dependencies:

```sh
rtk bun build scripts/hns-monitor.ts --target=bun --outfile=/absolute/release/hns-monitor.mjs
```

The adjacent systemd units are installation templates, not evidence of deployment.
Stage the bundle, record its digest and source commit, supply the environment
and configuration, run a dry-run and delivery test, then install the timer.
The service uses a dynamic identity and its own private state directory.
Systemd passes the private configuration through LoadCredential, so the
dynamic identity does not need direct access to the operator-owned source file.
Its fifteen-minute period is independent of the production renewal cron.
Monitor timer execution from another host or an external dead-man destination;
a stopped monitor cannot report its own absence.

The old backup heartbeat, authority deployment drift checks, missing secondary
scripts and static DNSSEC/DANE probes remain distinct installation repairs.
This command does not make those old scripts valid or reactivate the disabled
HTTP status page. Do not retire them as repaired solely because this command's
dry-run is healthy.

## Database execution boundary

Apply migration 0126 before installing a reader credential. It removes PUBLIC
execution from the four SECURITY DEFINER renewal functions. Existing explicit
grants and owner execution remain. A SELECT-only table grant is insufficient
while PUBLIC can invoke these writers.

Before applying the migration, resolve the actual connection roles from the
jobs Worker and provisioner protected configuration. Admit the jobs role only
to schedule_hns_root_health_renewals_v1(integer,integer,integer), and the
provisioner role to claim_hns_root_health_renewal_job_v1(text,integer),
prepare_hns_root_inventory_renewal_v1(text,text,bigint,text,text,bytea,text,text)
and finalize_hns_root_health_renewal_job_v1 with the same eight argument types.
Use explicit schema-qualified GRANT EXECUTE statements for those verified roles
in the controlled migration window; do not infer role names or grant execution
to a monitor or gateway authority reader. Retain grants before revocation to
avoid interrupting an existing executor that relied on PUBLIC. Verify effective
privileges after migration, then read back a natural scheduler heartbeat.

The monitor credential requires schema USAGE and SELECT only on the eight
tables used by snapshot.ts. It must not inherit an administrator or writer role.
Verify actual denied execution as well as table grants before enabling its unit.
The privilege test applies the forward migration ledger on PostgreSQL; the
structural test baseline strips environment-specific ACLs and is not permission
acceptance evidence.

If the environment ledger is behind unrelated product migrations, do not apply
those migrations merely to install a reader. The operator may execute the exact
reviewed 0126 SQL bytes in the same transaction as the explicit executor grants,
retaining the source commit, file digest, effective ACL read-back and unchanged
ledger. This is an ACL installation receipt, not an assertion that migration
0126 was recorded. Never insert a migration ledger row out of order. A later
ordinary full-prefix migration run re-executes these idempotent revocations and
preserves the explicit grants; the PostgreSQL test covers repeat application.

Store the dedicated reader URL as HNS_OPERATOR_MONITOR_POSTGRES_URL in the
production operator path. Map only that value to the command's existing
CONTROL_PLANE_POSTGRES_ADMIN_URL environment name in the private service file;
the variable name does not confer administrative privilege. Never install the
actual operator administrator URL in the monitor unit. The reader URL and
HNS_OPERATOR_ALERT_WEBHOOK_URL are optional admitted operator secrets, not
Worker runtime secrets. Dry-run installation does not require a destination.
