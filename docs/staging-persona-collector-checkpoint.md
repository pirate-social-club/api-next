# Fresh observation collector checkpoint

This checkpoint adds read-only ingress, database and object-inspection readers to
the reset-runner branch. It does not establish a live fence, install a marker,
reset a database, provision credentials, or authorize execution. Release pins
remain unchanged despite integrating current main as a source dependency.

The ingress collector reads the Cloudflare Access application inventory and its
policies, requires the fixed staging HTTP Worker to have an unconditional deny
policy, rejects hostname/path and preview overrides, and probes both public
hostnames without credentials. It rereads the configuration afterward. Reads
are paginated and bounded to fifteen seconds overall. Unknown destination types,
redirects, incomplete pagination and changing configuration fail closed. This
covers ingress only, not queues, Workflows or external producers. Provider
response shape and the deployed block remain live acceptance obligations.

The database collector reuses the existing effective-privilege catalog query.
It independently binds provider roles, the fixed database and Hyperdrive before
opening a dedicated administrator session. An additional active provider role
blocks collection until its place in the runtime inventory is reviewed. It
checks PUBLIC and inherited privileges including SET ROLE, ownership and
security-definer paths, requires CONNECT denial, attempts a fresh connection
with runtime credentials, and checks full session and prepared-transaction
visibility after the probe has closed. Bad passwords, network failures and
timeouts do not prove denial. The native connection requires verify-full TLS.
The existing pre-fence target diagnostic still authenticates both SQL identities;
the new private provider reader can run after runtime CONNECT has been denied.
No credential is included in the redacted result or CLI error.

The inspection client sends the Access cookie only to the independently selected
HTTPS origin at POST /inspect. It admits the frozen target shape, refuses
redirects and mismatched or stale responses, bounds reads to five seconds and
32 KiB, and retains false installation quiescence. It has no command fallback.
It now imports the operator lane's shared snapshot schema after integrating
reviewed PR 306 source fd5e8f91. There is no duplicate wire decoder definition.
That source integration is local; remote acceptance is tracked in the record.

## Verification

The inspection, ingress, reconnect-classification and provider-binding unit
suites passed: 13 tests, 110 assertions, exit 0. The real PostgreSQL 17 collector,
runtime-denial and session-drain suites passed: 15 tests, 37 assertions, exit 0.
The isolated local database used one CPU, a 512 MiB memory cap and enabled
prepared transactions; it was stopped after the run. Its reconnect seam used a
real independent local connection because that fixture has no TLS. This is not
a live provider proof. The native TLS refusal is covered separately.

A manifest-inventory test initially failed because the new PostgreSQL suite was
not yet tracked by Git. Its classification was present; rerun after staging the
new suite: seven manifest and strict fence-decoder tests passed, 21 assertions, exit 0.
The collector repository check then passed, exit 0, with 41 existing warnings
and two informational diagnostics. The serial ordinary suite passed, exit 0:
3,403 unit tests, 20 Node tests and 176 Workerd tests. Expected denial and stream
cancellation fixtures still emit Workerd diagnostics while their assertions pass.
A final ingress hardening checks legacy host fields even alongside destinations
and rejects unknown destination types; its four tests passed, 38 assertions.
Script-check and staged whitespace checks passed with no findings. No full
PostgreSQL baseline gate or remote CI is claimed by these focused observations.

## Remaining integration

The operator lane owns the inspect implementation, private artifact reader and
verification CLI. The runner still needs the complete maintained-producer and
release journal, independently retained pass history and non-reuse evidence,
and the executable signing collector which combines those with these fresh
readers. No such journal or signing key has been provisioned. Do not substitute
caller-supplied booleans or infer producers=true from database denial. These
observations therefore cannot yet produce a trusted reset-admission manifest.
The sixth rehearsal and live reset remain behind the recorded source and
fencing gates; no billed restore was consumed by this checkpoint.


Shared-schema integration then passed repository check and 29 focused
inspection, adapter, CLI and exact fence-decoder tests (80 assertions, exit 0).
The ordinary suite above remains the pre-integration run; no duplicate broad
suite is claimed. Operator PR 306 owns its independent remote checks.
