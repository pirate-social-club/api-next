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
The separate zone probe validates signed SOA and TLSA answers from both
authorities against freshly read chain DS. The configured gateway IP
must serve all monitored roots in the reviewed deployment topology.

## Configuration and dry-run

Use a private JSON file with `gateway_address` set to the reviewed gateway IP
and `checkpoints` set to an array. A checkpoint contains `root`,
`activation_generation` as a decimal string, and `due_at` as Unix seconds.
An explicit deadline applies only to that generation, so a completed successor
does not keep alerting on its predecessor's checkpoint. Operator roots also
alert when their pinned inventory reaches five days old. Imported roots do not
receive a manual-checkpoint alert.

The required `zone_freshness` object contains absolute `python` and `script`
paths, the local private driver's `driver_port` and `driver_reference`, and the
reviewed `primary_authority_address`. The script is the release's adjacent
`zone-freshness.py`; Python uses an isolated virtual environment installed from
`scripts/hns-continuity/requirements.txt` with `pip --require-hashes`.
Python 3.10 or newer and its distribution's venv/ensurepip support are required.
The lock includes cryptography's conditional typing-extensions dependency on
Python 3.10, and CI installs and tests the helper on that production version.
Authority addresses come from each activation's exact pinned inventory, not a
root list. This topology requires two distinct active authority addresses,
including the configured primary. A topology change requires reviewed config.

Load the database URL through the existing Infisical operator path. A dedicated
read-only database role is preferred; the command itself always starts a
repeatable-read, read-only transaction with a ten-second statement timeout.

```sh
rtk proxy infisical run --env=prod --path=/services/api-next/operator --silent -- bun scripts/hns-monitor.ts --config /absolute/monitor.json --dry-run
```

Dry-run creates no receipt database and makes no outbound alert request. It
does perform database reads, local driver reads and bounded DNS/TLS probes. Output contains hashed root
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

## Zone evidence and trust

The helper uses the existing private driver's loopback HSD interface. It has
no HSD key, Docker access, database URL or webhook; the parent explicitly removes
those environment values when starting it. The driver admits only its reviewed
read/proof methods. No new daemon or public RPC route is installed. Deployment
must verify that this exact listener is loopback-only and owned by the reviewed
driver release. Trust in that local process is the chain-evidence boundary.

Each observation brackets the root resource and direct authoritative answers
with matching mainnet tip/hash/header reads. It requires near-complete HSD
verification progress and a tip timestamp within six hours of local time (with
the chain's two-hour future allowance). This detects a stalled local chain;
it does not independently establish consensus against an eclipsed full node.
A changing tip produces an unavailable observation for the next timer to retry.
The driver reads current HSD state; retained activation DS and cached recursive
DNS answers are never substituted. In particular, hnsd's root response cache
can retain responses for six hours, so its AD bit is insufficient for this
fresh-resource requirement.

Both authorities receive nonrecursive TCP DNSKEY, SOA and app TLSA queries.
The probe requires authoritative, complete, matching answers, authenticates
DNSKEY against SHA-256/SHA-384 chain DS, then validates exact-owner SOA/TLSA
signatures and the retained DANE-EE SPKI association. Serial comparison follows
RFC 1982, including wraparound and undefined half-range ordering. Equal serials
must also agree on SOA and TLSA content. This samples serving records; it does
not compare complete zones or prove a clean client's DNSSEC/DANE path.

Requests have three-second transport bounds, each helper has a thirty-second
observation deadline, and its parent kills it after thirty-five seconds with
bounded output. At most four roots are probed concurrently. Missing answers,
lag, signature/DS/pin failure and unavailable chain evidence produce a failed
external heartbeat. Raw answers and root
labels are never logged by the helper.
The parent reserves a seventy-five-second probe window and starts no batch
with less than thirty-five seconds left. Unprobed roots produce an explicit
monitor capacity condition rather than letting the timer kill a silently
incomplete observation. Capacity is an operational failure, not healthy coverage.

## Delivery and acknowledgment

Every completed observation sends one Healthchecks signal. Empty conditions
send success; any condition sends failure. Repeated healthy or failed results
still send signals. Healthchecks owns notification suppression and recovery,
and detects a missed run when the unit or host stops. No local delivery ledger
may suppress the heartbeat. Detailed conditions remain in the unit's structured
output; the hosted payload contains only the state, public role label, host and
time. The public-song Workers Logs policy is unchanged.

Use a dedicated check with a fifteen-minute period and five-minute grace.
Do not share its ping URL with any other task. A backup success must not clear
a failed monitor. Keep the project management key in Infisical; install only
this check's private ping URL on the host. The dynamic service identity receives
it through LoadCredential and HNS_HEALTHCHECK_URL_FILE.

The maintained sender is scripts/hns-deployment/ping-healthcheck.py. Install
those exact reviewed bytes beside the monitor bundle and pass its absolute
path with --healthcheck-sender. The parent starts an isolated Python child with
only its credential file path and locale. Neither the database credential nor
the project management key is inherited. Transport has a thirty-second timeout
and the parent kills the child after thirty-five seconds. Redirects are refused.
Only HTTP200 with the exact OK acknowledgment counts as delivery; unknown and
rate-limited checks also return HTTP200 and must remain failures.

```sh
HNS_HEALTHCHECK_URL_FILE=/private/monitor-check-url rtk proxy infisical run --env=prod --path=/services/api-next/operator --silent -- bun scripts/hns-monitor.ts --config /absolute/monitor.json --healthcheck-sender /absolute/ping-healthcheck.py --deliver
HNS_HEALTHCHECK_URL_FILE=/private/fixture-check-url bun scripts/hns-monitor.ts --healthcheck-sender /absolute/ping-healthcheck.py --delivery-test --delivery-state failure
HNS_HEALTHCHECK_URL_FILE=/private/fixture-check-url bun scripts/hns-monitor.ts --healthcheck-sender /absolute/ping-healthcheck.py --delivery-test --delivery-state success
```

The two delivery tests explicitly signal a synthetic failure and recovery,
without reading or changing production observations. Run them against a
separate fixture check with the selected email integration. Also let a short
fixture check expire without further pings to verify missed-run delivery.
Retain provider event and mailbox receipts for all three paths; an acknowledged
ping alone does not prove an email was received. Arm the production check only
after acceptance. New checks that have never received a ping do not provide
missing-run coverage.

## Runtime installation

Build the standalone bundle from the reviewed source with frozen dependencies:

```sh
rtk bun build scripts/hns-monitor.ts --target=bun --outfile=/absolute/release/hns-monitor.mjs
```

The adjacent systemd units are installation templates, not evidence of deployment.
Stage the bundle, DNS helper, hosted sender and hash-locked Python environment. Record all
artifact and dependency provenance and their source commit; verify the local
driver and run the helper as the service identity. Supply the environment
and configuration, run a dry-run and delivery test, then install the timer.
The service uses a dynamic identity. Systemd passes the private monitor
configuration and check URL through LoadCredential, so the
dynamic identity does not need direct access to the operator-owned source file.
Its fifteen-minute period is independent of the production renewal cron.
The hosted check monitors missing timer execution outside the VPS fleet;
a stopped monitor cannot report its own absence. Inspect and retire the live
dry-run override explicitly during the reviewed delivery release. A source
template with --deliver does not override a live ExecStart replacement.

The old backup heartbeat and authority deployment drift checks remain distinct
installation repairs. The secondary release verifier is a local integrity
check; this monitor owns dynamic zone observation after its own deployment.
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
production operator path. The command reads that exact dedicated variable;
never install the actual administrator URL or use it as a fallback. The reader
URL and private check URL are operator credentials, not Worker runtime secrets.
Dry-run installation does not require a destination. Old SQLite delivery
receipts may be retained as evidence, but are neither read nor migrated into
the hosted check's state.
