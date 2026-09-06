# Staging reconstruction execution gates

This is an operator handoff, not an executable authorization receipt. The fixed
release remains API ba0fd44529d834f491879126cdb8c67c4ec9fcdc and Solid
fa5ce5eff47967efb5f13c04de01e75293d3e230, through migration 0119. Do not use
current main to expand the release. Production is not a target.

Current disposition — 2026-09-06. The owner-approved
[phased amendment](staging-persona-phased-reset-amendment.md) supersedes the
atomic mechanism and the unadopted phase proposal recorded below. Those two
sections retain historical measurements, not current execution instructions.
The internal phased executor is locally proven, but this document is still not
a live runbook: trusted admission collectors, complete maintenance artifacts,
the approved privilege policy and its ledger-write restriction, provider
recovery rehearsal and final publication gates remain unfinished. Table locks
are per removal batch, not held over the whole reset; the continuous producer
fence is essential. Recovery after committed partial progress means restoring
the verified capture, not rolling back an earlier transaction or resuming.

Review this handoff together with the phased amendment and
[privilege proposal](staging-persona-runtime-privileges.review.md). Before
capture, explicitly resolve whether an external HNS provisioner writes staging;
if so, its direct SQL connection belongs to the fence as well. Queue purge
requires the owner's separate affirmative decision. No approval of a proposal
or passing local suite replaces a provider execution receipt.

## Historical combined transaction proof and capacity

The internal reconstructStagingInTransaction body validates pinned artifacts,
the direct SQL identity, schema OID, exact 0109 ledger and approved default-ACL
fingerprint. It removes supported objects, compares the outside catalog before
and after removal, restores the search path, calls the supplied-transaction
migration library on the same connection, compares the schema against an
isolated pinned-baseline measurement, restores only reviewed grants, verifies
the outside catalog again, and checks the ledger and empty persona evidence.
It neither opens a connection nor commits. The caller must roll back every
failure. It is not the missing provider/fence/recovery admission layer.

A local PostgreSQL 17 reconstruction from populated 0109 exhausted shared lock
memory at migration 0052 with SQLSTATE 53200. The server had
max_locks_per_transaction=64 and max_connections=100. With the test server
configured at 512 and 100, the combined tests pass while retaining the one-CPU,
512-MiB container limit. The successful tests use a non-superuser object owner
and separately authenticated runtime role. Final-verification failure restores
the original account, grants and 0109 ledger. The two-minute statement timeout
is a test choice, not a measured provider limit.

At 2026-09-05T20:09:28.687Z, a rolled-back read through the staging operator
credential still matched all 109 checksums and reported max_locks_per_transaction
64, max_connections 25 and max_prepared_transactions 0. No provider setting was
changed. The current live capacity is below the already-failing local setup.
Do not attempt the destructive transaction there. Obtain a provider-supported
capacity disposition and rehearse the entire transaction against restored data
at that exact capacity first. Raising a local test setting does not authorize
changing PlanetScale. Splitting the reset into commits would change the approved
atomic mechanism and is not an automatic fallback.

The transaction body's minimumLockTableEntries must come from the successful
trusted rehearsal, not a submitted JSON claim. The corresponding settings product
is a conservative precondition, not a guarantee that entries are available.
Keep the producer fence and bounded locks; any resource error still aborts.
PostgreSQL describes this shared pool in its
[lock-management documentation](https://www.postgresql.org/docs/17/runtime-config-locks.html).
CI initializes its disposable general-test service with the larger setting using
[initdb's --set option](https://www.postgresql.org/docs/17/app-initdb.html).

## Historical measured phase proposal

The local-only command `rtk proxy bun scripts/staging-persona-lock-measure.ts
--local-measure` measures separate removal of populated 0109 and fresh replay
of 0001–0119. It accepts only the local test URL, creates UUID-named disposable
databases, rolls removal back and deletes only those databases. It does not
change the reset executor. A separate observer samples pg_locks every 20 ms;
the counts are observed lower bounds and may miss transient peaks. Distinct
lock tags, lock rows and shared-memory capacity are not interchangeable exact
accounting units, so these numbers must not automatically choose a batch size.

On PostgreSQL 17.11 configured at 512/100/0, removal reached 10,728 rows,
10,711 non-fast-path rows and 10,728 distinct lock tags in 109 samples over
5,148 ms. Fresh replay reached 6,840 rows, 6,825 non-fast-path rows and 4,598
distinct tags in 61 samples over 2,471 ms. Each measurement ran alone in the
one-CPU, 512-MiB local container. Its setting override was reset afterward and
the container stopped. The first sampling attempt failed on PostgreSQL's xid
comparison inside a composite DISTINCT; casting the transaction ID to text
fixed the observer, and the full measurement rerun passed.

Removal alone therefore needs investigation; batching only replay is not a
demonstrated solution at staging's last observed 64/25/0 settings. Fresh staging
inventory and settings reads in this follow-up failed and did not re-establish
those settings. The final attempt failed during connection with SQLSTATE 53300
(too many connections), before any settings query. No session was terminated
and no provider parameter changed.

PlanetScale's parameter table is explicitly the default-visible list, with
additional parameters searchable. Absence of max_locks_per_transaction from
that table does not prove it unavailable. max_connections is documented as
configurable with restart, but attainable bounds and memory cost need checking;
see the [provider parameter reference](https://planetscale.com/docs/postgres/cluster-configuration/parameters).

A phased reset changes the approved rollback mechanism and needs an explicit
amendment before implementation. A strict-prefix ledger is accepted by the
migration runner: it neither fences runtime nor refuses a naive rerun. The
amendment must specify a durable progress marker surviving removal, its trusted
reader and start/rerun refusal, continuously maintained producer fencing, no
automatic resumption, and independently rehearsed recovery after a committed
partial reset. Final ledger checks alone do not establish these properties.
The current executor remains atomic; no phased reset or connection increase
is authorized by this measurement.

## Privilege decision still required

The pinned migration chain issues no named runtime GRANT statements. The older
rebuild's copied ACLs are evidence, not policy. The composed body supports only
an explicitly approved keep disposition for the exact default-ACL fingerprint;
it does not silently remove or rewrite defaults.

The same staging observation found two api_next-scoped default ACL records
owned by the operator. One grants SELECT, UPDATE and USAGE on future sequences;
the other grants SELECT, INSERT, UPDATE and DELETE on future tables. Neither
has grant option. A second read at 2026-09-05T20:14:11.470Z used the actual SQL
session identity instead of PlanetScale's branch-suffixed connection username
and confirmed both grantees are the runtime role. The earlier other-role label
was an observer attribution error, not evidence of a misconfigured database.
Recommendation: keep those defaults for the paired rollout, subject to explicit
review of the ledger-table consequence below. The recorded default-ACL digest
is f0973701f1b93a794190b0a16ab24126ff6bda647a0d4476f6a00f9d75b2329d.

The coordinator must present a role/object/privilege manifest derived from
runtime operations, with the actual runtime identity independently bound. No
database CREATE, schema CREATE, ownership, TRUNCATE, grant option or historical
privilege is justified merely by its presence in the old catalog. An absent
required grant stops reconstruction; it is never inferred or fabricated.

The offline draft is docs/staging-persona-runtime-privileges.draft.json,
reproduced by `rtk proxy bun scripts/staging-persona-privilege-proposal.ts --draft`.
It lists the schema, 349 product tables and two identity sequences from the
exact baseline. It is a broad application-runtime proposal, not a per-operation
least-privilege proof. It excludes runtime ledger writes and identifies the
routine and ledger-override decisions still needed; it is not executable or an
approved manifest. The owner is asked to review the coordinator's proposal,
not produce this list from scratch.

## Maintained producer fence

Wrangler 4.123.0 command help and the official queue/workflow references were
checked for this handoff. Commands below belong to the release coordinator,
after a reviewed maintenance artifact and receipts exist. They are not actions
the workspace owner needs to paste or run now.

The fixed staging closure is the HTTP, jobs, media-processor and
data-registration Workers. All bind Hyperdrive
8cb7658a0f7143359c1becfec6a15c23. The pinned jobs cron is every minute.
HTTP has the study-generation Workflow, even though generation is disabled in
the pinned configuration. Jobs can produce media and DATA messages and consume
both dead-letter queues. Pause all four queues, not only the two primary queues:

```sh
rtk proxy bunx wrangler queues pause-delivery pirate-media-processing-staging --env staging
rtk proxy bunx wrangler queues pause-delivery pirate-data-registration-staging --env staging
rtk proxy bunx wrangler queues pause-delivery pirate-media-processing-staging-dlq --env staging
rtk proxy bunx wrangler queues pause-delivery pirate-data-registration-staging-dlq --env staging
```

For each exact queue, reversal is the same command with resume-delivery in place
of pause-delivery, but only after release verification. Purge requires a separate
explicit disposition and retained receipts, using queues purge on each of those
four names. Never use a wildcard, and do not add --force by default. Queue purge
does not stop in-flight processing or guarantee deletion of concurrently sent
messages; [Cloudflare documents those limits](https://developers.cloudflare.com/queues/configuration/pause-purge/).

The maintenance HTTP artifact must answer 503 except health while preserving
the reviewed bindings and routes. The jobs maintenance configuration must have
an empty cron list. These artifacts and exact version receipts are still
required; a documented intent to disable them is not a fence. Capture current
versions, trigger configuration and reversal before promotion. Verify callbacks,
Durable Object alarms, probes and other direct producers cannot write. Do not
use a minimal Worker deployment that silently removes existing bindings.

List all pages of instances for pirate-study-generation-staging,
pirate-media-processing-staging and pirate-data-registration-staging:

```sh
rtk proxy bunx wrangler workflows instances list pirate-study-generation-staging --env staging --page 1 --per-page 100
rtk proxy bunx wrangler workflows instances list pirate-media-processing-staging --env staging --page 1 --per-page 100
rtk proxy bunx wrangler workflows instances list pirate-data-registration-staging --env staging --page 1 --per-page 100
```

Reconcile every nonterminal instance, including paused and queued ones, under
the approved disposition. The command is workflows instances terminate followed
by the exact workflow name and observed instance ID. Do not manufacture IDs or
restart terminated old-dataset work after reset. Capture terminal-state readback;
[the command reference](https://developers.cloudflare.com/workers/wrangler/commands/workflows/)
does not make one list page proof of complete enumeration. Termination cannot
undo an already-started external provider effect.

Check Hyperdrive caching read-only and record whether it is disabled. Session
counts are observations, not the decisive lock probe. The reset locks all
supported relation roots before DROP, rejects prepared transactions, and fails
on a short lock timeout rather than retrying into an uncertain fence. Locks do
not prevent new producers, sequence calls or new DDL; Worker-level maintenance
is still essential. Every failure leaves that fence in place.

## Recovery and release

Before destruction, independently bind provider, SQL, credential and Hyperdrive
identities; make and retain a fresh data-bearing capture inside the maintained
fence; restore to an isolated branch; verify extensions, data, ACLs and ledger;
then run the completed reconstruction there with measured capacity and wall time.
Repeat the populated rollback injection there. Local tests do not replace it.

Only after all admission gates and independent review pass may the parent
rollout execute staging reconstruction, read the committed evidence through a
fresh connection, deploy the pinned API and Solid pair, and lift the fence.
Require authenticated product proofs and fresh posts/idempotency keys. No live
reset, queue purge, Workflow termination, deployment or recovery resource was
performed while writing this handoff.
