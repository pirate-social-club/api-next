# db/postgres

PlanetScale Postgres schema, forward-only migrations, and operational ledgers
for api-next (000 §4). Lane C owns this directory (001 §5). This is the sole
relational schema for every api-next environment; PostgreSQL dialect only.

Migrations are authoritative repository artifacts because PlanetScale Postgres
branches do not automatically merge schema changes. Apply them through the
forward-only ledger and expand/contract changes.

`schema.sql` is the cumulative baseline for the latest complete schema. The
numbered files are forward deltas and must be applied in order; at every
revision, applying all migrations to a fresh database must produce the same
catalog as applying `schema.sql` to a fresh database. They are not expected to
be byte-identical.

### Gates v2 pre-deployment baseline reset

`0009_gates_v2_foundation.sql` is the single clean gates-v2 baseline, following
canonical `0008_community_route_slug.sql`. It replaced the review-only
gates evidence/action-grant and subject-binding/lifecycle deltas before either was
applied to a durable environment. The reset removed their transitional
create-then-alter sequence. Before coordinator merge, the same undeployed
baseline was amended once to persist canonical verification requirements and
their request mode; the checksum manifest was deliberately regenerated after
that final catalog change.

This is not a compatibility path or a precedent for rewriting applied
migrations. A disposable local database whose ledger contains either retired
filename must be recreated. Once `0009_gates_v2_foundation.sql` is applied to
the first durable environment, its filename, SQL, and checksum are immutable;
all subsequent schema changes are new forward-only migrations.

`0010_proof_session_provenance.sql` is the first such forward delta. It binds
the exact managed flow/policy or dynamic query-generator reference and version
to proof sessions and evidence receipts, and persists the generic client
presentation append-only for idempotent session-start replay. Because no
provider route existed before 0010, it fails closed on a non-empty gates-v2
evidence ledger instead of fabricating configuration provenance.

`0011_verification_start_reservations.sql` adds the fenced, lease-bound
reservation used to make provider session start idempotent without holding a
database transaction across the provider call. Reservation finalization checks
the active generation inside the transaction before it can persist the proof
session and presentation.

`0012_verification_completion_attempts.sql` adds per-proof-session, idempotency-
keyed completion reservations. Active and consumed generations share a bounded
attempt budget; provider-unavailable attempts are released, while stale
finalizers are fenced before they can write the evidence ledger.

`0013_m3_community_purchase_funding_journal.sql` adds the concrete M3
community-purchase funding journal, request bindings, transaction claims,
transition history, and confirmed receipts. PostgreSQL constraints and trigger
guards fence immutable economic identity, cross-operation transaction reuse,
lease generations, reducer-consistent version advances, and append-only
evidence. It is intentionally flow-specific; shared journal extraction waits
for the second proven money flow required by spec 004.

`0014_m3_community_purchase_funding_plans.sql` adds immutable, flow-specific
community-purchase funding terms. A plan has one deterministic purchase,
canonical wallet/chain and treasury terms, and a database-timestamped quote
window. Its trigger permits only active-to-bound or active-to-cancelled
transitions; binding requires one unique journal operation and cannot be
undone.

`0018_m3_funding_dormancy_and_retention.sql` adds the nonterminal
`dormant_unobserved` state for plans whose browser never reports a transaction
hash, permits late evidence to resume observation, and makes the M3 canonical
journal, request, and plan rows non-deletable under the indefinite retention
policy.

`0019_m3_reconciliation_attempts.sql` adds durable retry scheduling for funding
operations that have transaction identity. Conditional claims advance a
generation fence, and success/failure finalizers require that generation;
hashless parked entries therefore never acquire attempt rows or RPC work.

`0020_m3_reconciliation_finalization.sql` adds the one-shot finalization fence
for each attempt generation and the append-only operator-action ledger used to
record an authorized unpark of an escalated attempt. The reset and its audit
record commit in one transaction; migration `0019` remains byte-for-byte
immutable. The supported recovery invocation is the coordinator-only
`makeControlPlaneCommunityPurchaseFundingOperatorStore` seam with the runtime
role, calling `resetEscalatedAttempt({ operationId, actorId, reason })` only
after the approved operator authorization check. It returns `reset` or
`not-escalated`; the latter is the idempotent result for a concurrent or
healthy-row retry. This seam is not an HTTP capability: do not expose it to
end users or replace it with manual SQL. The non-empty actor and reason are
stored with the generation in the append-only operator-action ledger.

`0023_community_creation_intents.sql` adds the server-owned creation-intent
projection, immutable revision ledger, pinned gate-provider binding, and the
credential-subject quota ledger. The default quota consumes slot one; an
additional slot must reference a distinct, immutable operator approval. The
community, initial policy/current pointer, provider binding, subject claim,
and committed intent revision are designed to commit in one transaction.
Provider calls never run inside that transaction.

## Applying migrations

The reviewed operational command is `bun run db:migrate`. It loads every
numbered SQL file, requires an exact match with `migrations/checksums.json`,
and then calls the shared `applyPostgresMigrations` library. The command uses
the administrative URL in `CONTROL_PLANE_POSTGRES_ADMIN_URL`; the URL is not
printed or stored by the repository. It fails before applying anything when
the file set, checksum manifest, ledger checksum, or strict ledger prefix is
invalid.

Use `bun run db:migrate -- --dry-run` to print the ordered version and checksum
plan without opening a database connection. A normal run is an administrative
operation and must be performed with the migration role, never with a Worker
credential.

Before an authorized M3 staging migration, run `bun run db:preflight:m3` with
both `CONTROL_PLANE_POSTGRES_ADMIN_URL` and
`CONTROL_PLANE_POSTGRES_RUNTIME_URL`. It performs read-only checks of the exact
checksummed ledger prefix, M3 row counts, the physical runtime principal, and
per-table privileges without printing either credential. After applying 0020
and its reviewed grants, rerun with `--require-ready`.

The real-Postgres CI gate must invoke the adapter, foundation, migration-runner,
and identity suites together, then run
`bun run verify:postgres-sentinels`. Each file writes a different completion
marker only after all of its tests pass. The verifier therefore fails when a
suite is skipped or omitted, even if another Postgres suite is green.

Workers connect with the least-privilege application role described in
`roles.sql.example`; the default administrative or `BYPASSRLS` role is not an
application credential. In short, the two-role model is: the administrator
applies forward-only migrations, while HTTP and jobs Workers use only the
least-privilege Hyperdrive role for application reads and writes. Application-
scoped repository predicates are the primary tenant boundary. RLS is
intentionally deferred as optional defense-in-depth until pooling and policy
metrics justify it.
