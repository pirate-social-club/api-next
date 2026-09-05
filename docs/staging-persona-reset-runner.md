# Staging persona reset runner

This is an implementation checkpoint, not an executable reset runbook.
Available pieces are the offline release planner, evidence-consistency
validator and read-only database observers. The observers require dedicated
connections supplied by a future trusted collector. No reset execution option
is available.
The August rebuild script remains
unchanged and must not be used for this release.

Run `bun scripts/staging-persona-reset-plan.ts --dry-run` from a source checkout
containing the approved Git commit. A named remote ref is not required. A
shallow checkout missing that object fails closed; CI's check job fetches full
history. The planner reads immutable Git objects instead of the current
checkout's migration directory, which already includes an unapproved 0120.
It validates the complete manifest, baseline bytes and every migration before
returning an immutable 0001–0119 plan. It does not run Git fetch itself.

The pinned source is ba0fd44529d834f491879126cdb8c67c4ec9fcdc. Its manifest
SHA-256 is b68453cb883b59d30358a43f2b1a5d44dc2a8bc52a266dedca646f712161ecc9
and baseline SHA-256 is
8d680727f9869a1b9fe24a76674f29306e527df90b5506ebdc574dec88250102.
Changing any pin is a release decision, never a CLI override or automatic
response to a newer main. The ledger validator accepts only the reviewed
0109 prefix; that evidence alone does not identify or authorize a database.

The next implementation must add independently verified target, recovery and
writer-fence evidence before any destructive capability is exposed. The
authoritative task record requires the exact staging Hyperdrive/provider
mapping, a fresh data-bearing capture and isolated restore rehearsal, and the
complete four-Worker writer closure. Receipt claims alone must not substitute
for live target and effective-denial checks. Never log credentials or identity
rows. Check inherited/PUBLIC access, SECURITY DEFINER entry points, existing
transactions and cross-schema dependencies; fail before destruction if any
remains unexplained.

Once those gates exist, reuse the repository migration runner with the full
verified plan once, not the August prefix loop. The migration application
already wraps the whole list in one transaction. Runtime fencing must survive
any replay rollback. Separate tests must prove rebuilt catalog/baseline parity,
zero identity-dependent rows and zero persona-binding evidence, while an
isolated recovery rehearsal restores the captured old data. Restoring a fresh
empty database is not recovery proof. Restore only reviewed runtime privileges
after all verification; do not reuse overlapping old grants as authority for
new objects or enable schedulers/providers.

The version-one evidence-consistency module rejects excess fields, production
targets, wrong release pins, incomplete writer lists, duplicate/runtime-admin
role identities, active sessions/transactions, unresolved dependencies and
stale observations. It binds a single fence generation to the capture, a
distinct retained recovery branch and an isolated rehearsal of that exact
capture/restore point. Ledger, catalog, data, grants, extensions and nonzero
identity-row counts must agree with a fresh source observation. The five-minute
window applies to the final fence observation, not the duration of recovery
capture and rehearsal while the same fence remains continuously held.

These serialized values are untrusted claims even when internally consistent.
The validator returns execution_authorized=false and live_recheck_required=true.
It does not verify provider IDs, connection fingerprints, denial booleans or
snapshot digests against real systems. A collector must independently resolve
the approved provider/Hyperdrive/role tuple, enumerate the actual producer and
dependency closure, check denial through runtime credentials, and compute the
source/capture/restoration fingerprints. It must validate the actual full 0109
ledger through the planner's ledger check. Do not accept user-supplied JSON or
this consistency result as authority to destroy data.

The future live boundary must obtain its clock independently of the receipt,
bind observations to the canonical target tuple and exact capture/restore point,
and attest the dependency scan version, complete closure and unknown-object
counts. The four Worker names do not by themselves enumerate their queues,
schedulers, callbacks or other producers. Same-generation strings do not prove
continuous fencing. Immediately before any destructive statement, repeat the
trusted target, ledger, dependency and effective-denial observations while the
fence remains held; a five-minute receipt is not permission to skip that check.
The owner disposition string is descriptive here, not an authorization token.

The disposable-staging disposition permits the original multi-community
conflict to remain in pre-reset evidence. The collector must record those
aggregate counts and their versioned digest without guessing a binding or
requiring pre-reset zero conflicts. Only post-replay verification requires
empty identity state and zero binding violations.

No destructive adapter, complete live evidence collector, runtime fence, grant-restoring
path is implemented in this checkpoint. The PostgreSQL 17 replay suite proves
the pinned full chain installs once and an injected mid-chain failure rolls
back prior migration effects, preserving a separate schema in both cases.
This is not a destructive reset, runtime-role isolation or captured-data
recovery rehearsal test; those proofs remain outstanding. Independent
review and the required Postgres 17 and secret-boundary gates remain mandatory
before the parent release coordinator may use a completed runner.

The runtime-denial observer now inspects a dedicated connection authenticated
with the runtime credential. It rejects role impersonation, elevated roles,
predefined pg_ roles (including server-file/program capabilities),
database creation rights, object ownership, effective schema/table/column/
sequence access through PUBLIC or memberships, and executable security-definer
functions in accessible schemas. Membership checks conservatively include
roles available through SET ROLE. A permission-denied SELECT with LIMIT 0
checks the target ledger without reading data. Driver failures are redacted
and fail closed; the observer neither changes grants nor authorizes execution.
Its PostgreSQL tests cover a separate login, rollback, PUBLIC/inherited and
NOINHERIT role-switch access, an external security-definer function, and a
revoked owner's ability to restore permissions.

This observation is not a maintained fence. The future coordinator still must
verify the provider/connection identity, inspect and drain other sessions and
prepared transactions, stop all producers, check the dependency closure and
repeat observations immediately before destruction. The observer does not
automatically revoke permissions to make a failed check pass. Its rejection of
any current-database object ownership or accessible security-definer routine
is conservative; exceptions require a separately reviewed design, not a flag.

The session-drain observer requires a fresh, idle dedicated administrative
connection with full statistics visibility and no role impersonation. Never
pass an existing caller transaction, because cleanup rolls it back. Within its
own transaction, the observer clears the statistics
snapshot and refuses every other backend in that database, including idle
connections, plus every prepared transaction. It excludes only its own backend
and returns counts, never session identities or query text. It does not kill
connections, resolve transactions or prevent a new connection after observation.
Runtime credential probes must close before this observation. A future fence
must prevent reconnects and repeat the observation immediately before reset.

Its PostgreSQL tests use an isolated UUID-named database and prove refusal of
an idle peer, an idle transaction and a prepared transaction whose client has
disconnected; refusal does not cancel their work. The local dedicated instance
was explicitly configured with max_prepared_transactions=10 for the last proof.
The ordinary CI service defaults to zero, so the test also covers PostgreSQL's
refusal to prepare there rather than claiming that branch tests a live prepared
transaction. Both configurations have been exercised locally.

Read-only execution prerequisite observed on 2026-09-05: the credential injected
from Infisical staging /services/api-next/operator matched the complete pinned
0109 ledger and connected directly to SQL database postgres. It owns api_next,
but has_database_privilege(current_user, current_database(), 'CREATE') returned
false. The observation transaction was rolled back; no grants or DDL ran.
Provider identity was not independently reverified in this SQL-only check.

Schema ownership alone cannot authorize a drop/recreate plan. The new
schema-authority observer refuses this condition without performing DDL or
granting anything; its PostgreSQL regression reproduces the missing CREATE
privilege and proves the original schema remains. It also requires SET ROLE
capability for the original owner, so inherited ownership without SET cannot
pass a plan that must recreate the schema under that owner. A future executor must call
this check before destruction as well as the other target/recovery/fence gates.
The current credential therefore blocks execution of the approved approach.
Use a separately approved staging administrative credential with the necessary
rights, or obtain a reviewed change of approach. Never grant broader rights or
choose an object-level rebuild automatically. PlanetScale documents a separate
[administrative role](https://planetscale.com/docs/postgres/connecting/roles);
that provider capability is not evidence that such a credential is available
to this lane. Do not rotate the default credential as a workaround.

The dependency observer traverses PostgreSQL's recorded reference-to-dependent
graph and internal/extension owner promotion. Column nodes are conservatively
promoted to their whole object. It maps schema-less implementation objects
through their owning relation and TOAST objects through the original table;
unknown classes or dependency flavors, external objects and extension removal
all refuse the observation. Five PostgreSQL tests cover the full pinned schema,
outside views and foreign keys, extension removal refusal and preservation of
an external extension used by a target table.

The pinned graph exceeds 10,000 objects, so the bounded scan admits up to 50,000
objects with a ten-second statement timeout and refuses overflow. The digest
includes object OIDs and incident dependency edges. It is specific to one
catalog snapshot, not a portable fingerprint for comparing logical restores.
Only counts and the digest are returned; no database row data is read. This
models catalog-recorded DROP dependencies, not references inside dynamic SQL
or application configuration. It neither drops objects nor locks out future
DDL. Provider/producer fencing, identity checks and an immediate repeated scan
remain mandatory before destructive execution.

At 2026-09-05 17:28 UTC a read-only invocation through the configured staging
operator credential verified the exact 0109 ledger, then classified 14,277
objects with closure digest
9419f84af0256fdb14288644f997299ef8cdf1a522101a16a650d9fd74679373.
It returned execution_authorized=false and exited zero. Provider identity,
continuous fencing and recovery were not established by that observation;
the missing schema-CREATE privilege remains a separate execution blocker.
## Local data-bearing recovery rehearsal

`scripts/staging-persona-recovery.pg.test.ts` creates UUID-named test databases
only. It replays the pinned 0001–0109 source chain, inserts a synthetic account
through the ordinary first-persona trigger, and captures an unmodified custom
pg_dump archive. A separate database receives the archive through a
single-transaction, exit-on-error pg_restore. Every api_next table is compared
row-for-row, including timestamps and pending wallet/profile state. Additional
checks cover sequence continuation, extension version, function search_path,
row-level security, default privileges and an effective read-only grant. A
deliberately revoked grant must change the schema digest.

The baseline generator is not a recovery tool: it removes owners and ACLs,
rewrites schema references and changes seed timestamps. This rehearsal does
none of those. PostgreSQL itself simplifies some CHECK-expression parentheses
when parsing a dump, so a separate schema-only restore supplies the canonical
schema comparison. Both restored schemas are dumped by the same PostgreSQL 17
tool with a fixed restrict key; no SQL text is stripped or rewritten.

The test requires PostgreSQL 17 and Docker with the postgres:17 image. The
test URL must address the literal 127.0.0.1 host and postgres database; host
overrides, connection options and nonlocal URLs are refused before connecting.
The operator must still ensure the local port is a disposable test server,
not a tunnel to a live service; URL validation cannot detect a port forward.
The optional CONTROL_PLANE_POSTGRES_RECOVERY_TEST_CONTAINER selects an existing
local test container for its client binaries; otherwise a resource-bounded
Docker client runs on host networking. Credentials pass through environment
variables, not command arguments, and tool errors are redacted. The test
creates no provider resource and reads no staging or production data.

This is not the required live recovery receipt. All test databases share one
local cluster, so roles already exist and provider role recreation, independent
branch recovery, credential switching and maintained writer fencing remain
unproven. The fixture has one pending persona, not the full live dataset. The
test compares an actual restored copy, but its schema-only comparison shares
the same PostgreSQL toolchain and is not an independent semantic SQL verifier.
The schema CREATE credential blocker still prohibits live reset execution.

## Read-only provider backup observation

`bun scripts/staging-persona-provider-backup.ts <backup-id>` performs only GET
requests through the authenticated PlanetScale CLI, with its API base fixed to
the official HTTPS endpoint. It checks the staging database and main branch
IDs and the selected backup's source branch relationship before emitting
sanitized metadata. The normal backup CLI presentation omits database_branch;
the raw API response carries it. Missing relationships, failed backups, malformed
timestamps and unexpected targets are refused without logging provider bodies.

This is not capture, retention protection or recovery verification. It never
creates a backup or branch, selects a backup automatically, grants privileges
or connects to SQL. A successful result can describe an expired or unprotected
backup: those facts are evidence for a future admission decision, not approval.
The SQL connection, account/project context, continuous fence, actual backup
contents and restored branch health still require independent verification.
The injected reader is a unit-test seam and confers no execution authority.

A read-only observation on September 5 found staging database mvydkmmwh5x4,
main branch syu03e00w3ux, and backup pz8v156wu3kn completed at
2026-09-05T14:21:09.145Z. The backup was unprotected, expires at
2026-09-07T14:17:02.947Z, and listed no restored branches. The existing
recovery-20260828-moderation-e2e branch remains present, but is not a fresh
capture for this ceremony. None of these reads established a writer fence.

PlanetScale's [restore documentation](https://planetscale.com/docs/postgres/backups)
states that restored branches do not restore database extensions automatically.
The provider rehearsal must therefore inventory and verify required extensions
explicitly; the local pg_dump test cannot establish that provider behavior.
The [backup read contract](https://planetscale.com/docs/api/reference/get_backup)
provides the source-branch metadata used by this observer.

## Secure credential assistance, September 5

The workspace owner asked the agent to provision the needed credential without
displaying its value. A separate staging-main role, provider ID 9eon4hzg2r7a,
was created with postgres inheritance and a two-hour TTL. It expires at
2026-09-05T19:58:02.131Z. Its connection string passed directly from captured
provider output to Infisical stdin under the new staging operator key
CONTROL_PLANE_POSTGRES_RESET_ADMIN_URL. No credential value entered chat,
command arguments or tracked files. Existing secrets were not overwritten.

Reading that new secret back verified the complete 0109 ledger and database
postgres. It has database CREATE permission, but neither schema ownership nor
SET ROLE authority for the original api_next owner. Attempts to grant the
original owner role to this temporary role, first through postgres and then
through the existing operator credential, both failed with SQLSTATE 42501 and
were rolled back. No schema, data, existing runtime permission or deployment
changed. The new role and new secret are the only completed external writes.

The credential transfer is complete, not reset readiness. Do not substitute
this key blindly for ADMIN_URL or transfer schema ownership as a workaround.
The ownership-administration path still needs resolution and review. The
temporary role must not be used after expiry; retire its dedicated secret and
role when the credential work is concluded. The provider role must not acquire
object ownership during that cleanup window. The control-plane checkout had
another active writer at this checkpoint, so this receipt is preserved on the
owning lane pending task-record reconciliation.

## Proposed in-place reconstruction, pending approach sign-off

The owner-requested read-only inventory at 2026-09-05T18:09:15.139Z used the
existing operator credential and revalidated the entire 0109 ledger. The
operator has CREATE inside api_next and effective ownership of all 1,204
relation objects, 362 routines and 660 types observed there. No operators,
operator classes/families, collations, conversions, text-search configuration,
dictionary, parser/template or extended statistics objects were found in that
schema. This supports an in-place proposal; it is not a DROP plan or proof of
complete dependency safety. Relation counts include indexes and other objects,
not just tables. Ownership digest is
01c4538ed6a4006d20c53f1418138a9e00fd63811d19054594097b68a6ab7e00.

The inventory read 5,933 effective ACL entries, zero explicit column ACLs and
two global-or-schema default-ACL records. It found PUBLIC entries for 355
routine grants and 660 type grants, but none for relations or schema. These
are grants, not proof that anonymous application requests can execute SQL.
ACL digest is 763b7deba9e3711a2d589149ce14dce9c95b5ec0c25426e85766e09297654562;
default-ACL digest is
f0973701f1b93a794190b0a16ab24126ff6bda647a0d4476f6a00f9d75b2329d.
The read-only command is `bun scripts/staging-persona-inplace-inventory.ts
--read-only`, with the existing operator secret supplied through Infisical.
It outputs summaries/digests rather than a reusable grant replay manifest.

Installed extensions are btree_gist 1.8 in public, hypopg 1.4.2 in
pscale_extensions and plpgsql 1.0 in pg_catalog. None is effectively owned by
the operator and all remain outside the proposed destruction scope. The
inventory rolled back; provider-to-SQL identity and a maintained fence were
not re-established by this observation.

The proposed mechanism preserves the api_next schema object, ownership and
schema-level ACL/default-ACL state. It inventories and removes supported owned
objects inside it, replays the exact 0001–0119 chain, and verifies the result
within one transaction. It must reject unknown object classes and any external
cascade before removal. Objects recreated by migrations lose their old ACLs;
reviewed grants must be reconciled with the new migrations, not replayed blindly.
Default privileges survive schema preservation and must be reviewed for their
effect on every recreated object. Writer fencing remains outside this transaction
and must survive every failure; runtime access resumes only after verification.

The current migration CLI opens its own connection and transaction. Running
object deletion in one connection and then invoking that CLI would not satisfy
atomicity. Implementation requires a reviewed common transaction boundary for
deletion, repository migration logic, verification and grant reconciliation.
Tests must prove schema identity preservation, full rollback of old populated
state on replay or verification failure, exact ledger/baseline and empty new
identity state, extension/unrelated-schema preservation, and continued runtime
denial. Verified provider recovery and isolated rehearsal still precede any
live destruction. No in-place executor is implemented or authorized here.

The temporary maintenance key will expire without renewal or promotion. No
additional privilege request is part of this proposal. Production HNS rollout
state is outside this lane and was not rechecked in this inventory.
