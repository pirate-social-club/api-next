# Staging phased-reset amendment

The workspace owner approved implementation and isolated rehearsal of the phased
mechanism on 2026-09-05. For this staging reset only, restore from the verified
capture replaces transaction atomicity as the recovery guarantee. The producer
fence must hold continuously from capture through post-deployment verification.
Production is unaffected. Release pins remain API ba0fd44529d834f491879126cdb8c67c4ec9fcdc,
0001–0119, and Solid fa5ce5eff47967efb5f13c04de01e75293d3e230.

This supersedes the one-transaction requirement for this staging operation,
not the recovery, target, privilege, fence or provider-rehearsal gates. No live
execution follows merely from accepting this amendment. The old atomic helper
remains a local comparison/test primitive, not an alternative live reset path.

The owner ratified a further grant-handoff amendment on 2026-09-08: runtime
grants remain provably denied through reset and retirement and are restored
only during release. This supersedes mid-reset restoration without weakening
the maintenance fence. The reasoning, denied completion readback and independent
release grant-digest verification are recorded in the
[ratified handoff amendment](staging-persona-signed-collector.md#ratified-handoff-amendment--2026-09-08).

## Phases and refusal

The trusted coordinator creates a durable exclusive marker outside the database
before the first removal. The current marker is coordinator-host filesystem
storage in an owner-only directory: all admitted reset entrypoints must use one
fixed approved directory. It is not a distributed lock and cannot stop a manual
migration or a different host. Maintenance fencing, not the ledger or marker,
prevents runtime writes. No live CLI is admitted yet.

The marker binds the fixed release and digests of verified target/fence and
recovery evidence. It survives committed batches, has a bounded validity period,
and fails closed on mismatch, expiry or an existing run. Phase movement is
monotonic. No automatic resume, stale-marker deletion or retry is offered.
After failure, the marker remains and a separately reviewed recovery operation
must restore the capture and verify the target before retiring that failed run.

One catalogue root is removed per transaction, re-reading ownership and its
dependency closure before execution. A root may include more than a table's
indexes and TOAST objects: dependencies and internal-owner promotion can expand
it. A reviewed closure limit and before/after lock counts therefore guard each
batch. Oversized or unknown closures fail rather than being split implicitly.
All locks are checked before commit; checking only after commit loses evidence.

Replay uses the validated in-transaction library, one complete migration per
batch. SQL files are not split at semicolons. Each batch requires precisely the
previous committed prefix and its original checksums. That prefix is provenance,
not permission to resume. An indivisible migration exceeding the rehearsed budget
requires another reviewed decision, not an automatic retry or larger limit.

The full namespace is inventoried before removal. Each removal batch rechecks
its root closure and unsupported objects. The outside catalogue is compared
after all removal, before replay could mask a change, and again at final
verification. Any failure keeps the marker and fence and requires restore.
Reconciliation and final ledger, baseline and zero-identity evidence run in the
last replay transaction; fresh verification follows, and must run again after
the paired deployment while the fence remains held. Only successful paired
release verification permits clearing the successful-run marker.

## Admission still required

The internal orchestrator accepts trusted in-process verification functions;
supplied JSON booleans and hashes are not an admission mechanism. The actual
provider/SQL/fence/recovery collectors remain required before exposing a live
entrypoint. Local tests use synthetic fixtures; they do not establish staging's
batch limits or live recovery.

The isolated PostgreSQL 17 test at max_locks_per_transaction=64,
max_connections=25 and max_prepared_transactions=0 passes 808 committed
batches. Observed pre-commit maxima are 778 own/cluster non-fast-path lock rows
and 603 dependency-closure objects. The test uses ceilings of 1,000 own locks,
1,200 cluster locks and 800 closure objects, leaving headroom rather than
setting limits equal to the observation. These counters can miss transient
peaks; the successful run at the actual low settings is the local capacity
proof. A provider rehearsal still must measure its own workload and headroom.

The local recovery test captures populated 0109, retains an independently
restored copy, injects failure after a committed removal, restores a replacement
from the retained copy, and compares every application table plus the schema/ACL
dump and ledger. The failed target's marker still refuses a new reset. This is
a real local dump/restore test, not a provider recovery-branch receipt.

After fencing Workers, reserve a bounded administrative admission window and
observe runtime connections draining through their configured idle timeout.
Use an explicit reviewed timeout, not an endless retry. If no administrative
connection becomes available or the allowed runtime-session threshold does not
settle, record admission failure and do not start. Idle pooled sessions alone
do not prove the Worker fence is leaky, but they can exhaust all connection slots.
No termination privilege, forced session kill or capacity change is inferred.

The runtime privilege/default-ACL policy, separately recorded queue-purge
disposition, complete maintenance artifacts, protected capture, retained recovery
branch, isolated restore and injected-failure recovery rehearsal remain gates.
An actual provider restore after a committed partial reset must be tested; a
local transaction rollback or marker unit test cannot stand in for it.
