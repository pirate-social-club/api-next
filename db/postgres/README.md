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
