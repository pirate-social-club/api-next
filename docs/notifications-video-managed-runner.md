# Managed video alias admission

The managed runner wraps the existing Notifications admission store. It supplies the
missing direct managed connection entry point without changing the disposable runner,
applied migrations, producer identities or notification history. The candidate cutover
SQL remains a separate operator effect; applying migration 0273 does not execute it.

## Preparation

Run from the independently reviewed, clean committed source. The request is an external
JSON file, never a credential store. It contains version 1, a new UUID operation_id,
one action, finite UTC not_before and expires_at values, source_commit, target and plan.
Target names the exact hostname, branch-qualified connection login, actual PostgreSQL
principal and database. Plan uses NotificationsVideoAdmissionPlan unchanged: its fixed
contract digest, plan digest, alias run UUID, paired Solid artifact digest and exact
cutover SQL digest. Review must bind the real deployed producer pair, the actual Solid
artifact and the materialization plan; filling these fields with arbitrary digests is
not evidence of readiness.

Default invocation validates the packet, source identity and SQL bytes offline. It
prints the packet digest and opens no database connection:

```sh
bun scripts/notifications-video-managed-runner.ts --request /absolute/request.json
```

The admitted executor supplies the existing managed administrator credential as
CONTROL_PLANE_POSTGRES_ADMIN_URL through its established secret workflow. Never paste
it into arguments, the request, logs or receipts. The connection must match the reviewed
host, branch login and database, use direct port 5432 and verify-full TLS. The runner
uses the existing pg system-CA normalization and pins api_next,pg_catalog search path.
The real session/current principal, schema ownership and complete migration ledger
must match before action dispatch. Execution requires the exact reviewed request digest:

```sh
bun scripts/notifications-video-managed-runner.ts --request /absolute/request.json \
  --execute REVIEWED_REQUEST_SHA256 --receipts /absolute/external/receipts
```

## Execution and reconciliation

The parent establishes exclusive resource custody, current database/role admission,
fresh actual serving producer and consumer evidence, network access, required checks,
review and execution/recovery bounds before the managed invocation. This command does
not acquire Cloudflare, deployment or other coordinators' execution locks for them.
No financial or Dance activation is included. Use each action explicitly; there is no
unbounded batch loop or automatic retry.

First inventory the historical cohort and retain source/receipt/alias evidence. Review
invalid, colliding, alternate and unknown outcomes. They block admission. Then perform
the reviewed materialization run, one bounded batch at a time, retaining its checkpoint.
Drain outstanding old-policy facts with the existing normal recovery action, outside
cutover exclusion. Materialization alone never changes notification eligibility.

Cutover delegates to the existing store: bounded deadlines, outbox EXCLUSIVE NOWAIT
first, alias-namespace exclusion second, exact completed materialization and producer
fences, then atomic SQL installation and immutable receipt. No inventory, drain or alias
repair occurs while those exclusion locks are held. Reconcile an already committed
receipt rather than reinstalling it. Existing terminal suppressions, fact/receipt href
bytes and read history are never reset or backfilled.

The caller first creates a private receipt directory outside the source tree. The
runner requires that directory to exist, be owned by the current operator and grant
no group or other access. It validates the canonical path and fsyncs the existing
directory ancestor chain before creating an intent; it never recursively creates a
new, unpersisted directory chain. Symlinks into source and misleading child names
such as ..receipts are refused. Duplicate and unsupported connection query parameters
are rejected so the driver cannot override the reviewed host, login, port or TLS.

The external receipt directory receives a durable exclusive intent before connection
or effect. An existing operation intent refuses another invocation, even without a
result file. A failure after dispatch is conservatively unknown and requires exact
database receipt/audit reconciliation. Do not choose another operation ID, delete an
intent or repeat a command to evade uncertainty. A separate status operation may read
the persisted run; it does not by itself prove an unknown cutover outcome. The parent
must inspect the immutable cutover receipt against all four bound fields before admitting
another cutover command. Errors never serialize driver causes or connection strings.
The actual platform finalizer has a bounded close and its logged failures are observed.
A failed close cannot produce a success receipt. When SQL already acknowledged the
operation, the failure receipt preserves that fact and its result separately from
unknown connection closure; it does not reinterpret an acknowledged COMMIT as unknown.

After cutover, prove actual inbox-to-video primary and persisted-alias destinations,
nested reply resolution, reload/read behavior and current authorization redaction on
the paired release. Unit tests establish runner boundaries; they are not managed-target,
historical-inventory, codec, device or full-v1 acceptance.
